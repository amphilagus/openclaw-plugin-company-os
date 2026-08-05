import type { PluginLogger } from "openclaw/plugin-sdk/core";

import { OpenClawCliAgentInvoker, type AgentInvoker } from "./agent-invoker.js";
import { SmtpMeetingEmailSender, type MeetingEmailSender } from "./email.js";
import { resolveAgentVisualIdentity, type AgentVisualIdentity } from "./identity.js";
import { CompanyOsStore } from "./store.js";
import type { MeetingAdvance, MeetingTurnDelivery, MeetingTurnDispatch, ResolvedCompanyOsConfig, ServiceEvent } from "./types.js";

export class CompanyOsService {
  readonly store: CompanyOsStore;
  private readonly config: ResolvedCompanyOsConfig;
  private readonly logger: PluginLogger;
  private readonly runtimeConfig: unknown;
  private readonly meetingEmailSender: MeetingEmailSender;
  private readonly agentInvoker: AgentInvoker;
  private readonly identityCache = new Map<string, AgentVisualIdentity>();
  private readonly listeners = new Set<(event: ServiceEvent) => void>();
  private readonly eventHistory: ServiceEvent[] = [];
  private scanTimer?: NodeJS.Timeout;
  private emailFlush?: Promise<void>;
  private dispatchFlush?: Promise<void>;
  private readonly activeTurnDeliveries = new Set<Promise<MeetingTurnDelivery>>();
  private readonly lifecycleAbort = new AbortController();
  private stopping = false;

  constructor(options: {
    databasePath: string;
    allowedAgentIds: Iterable<string>;
    config: ResolvedCompanyOsConfig;
    runtimeConfig: unknown;
    logger: PluginLogger;
    meetingEmailSender?: MeetingEmailSender;
    agentInvoker?: AgentInvoker;
  }) {
    this.config = options.config;
    this.runtimeConfig = options.runtimeConfig;
    this.logger = options.logger;
    this.meetingEmailSender = options.meetingEmailSender ?? new SmtpMeetingEmailSender(options.config.bossEmailNotifications);
    this.agentInvoker = options.agentInvoker ?? new OpenClawCliAgentInvoker();
    this.store = new CompanyOsStore({
      databasePath: options.databasePath,
      allowedAgentIds: options.allowedAgentIds,
      config: options.config,
      onEvent: (event) => this.emit(event),
    });
  }

  async start() {
    this.store.recoverAgentDispatches();
    await this.recover();
    await this.flushMeetingEmails();
    this.kickHostDispatches();
    this.scanTimer = setInterval(() => {
      void this.scanTimeouts().catch((error) => this.logger.error(`company-os timeout scan failed: ${formatError(error)}`));
    }, 30_000);
    this.scanTimer.unref();
  }

  async stop() {
    this.stopping = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.lifecycleAbort.abort();
    await Promise.allSettled([
      ...(this.dispatchFlush ? [this.dispatchFlush] : []),
      ...this.activeTurnDeliveries,
    ]);
    this.listeners.clear();
    this.store.close();
  }

  subscribe(listener: (event: ServiceEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  memberIdentity(memberId: string) {
    const member = this.store.listMembers(true).find((candidate) => candidate.id === memberId);
    if (!member) throw new Error(`member ${memberId} not found`);
    const visual = this.identityCache.get(memberId)
      ?? resolveAgentVisualIdentity(this.runtimeConfig, member.agentId ?? memberId);
    this.identityCache.set(memberId, visual);
    return {
      id: member.id,
      name: member.name,
      title: member.title,
      emoji: visual.emoji,
      avatarUrl: visual.avatarUrl,
    };
  }

  eventsAfter(id: number) {
    return this.eventHistory.filter((event) => event.id > id);
  }

  latestEventId() {
    return this.eventHistory.at(-1)?.id ?? 0;
  }

  waitForEventsAfter(id: number, timeoutMs: number) {
    const available = this.eventsAfter(id);
    if (available.length > 0) return Promise.resolve(available);
    return new Promise<ServiceEvent[]>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (events: ServiceEvent[]) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(events);
      };
      const unsubscribe = this.subscribe((event) => {
        if (event.id > id) finish(this.eventsAfter(id));
      });
      timer = setTimeout(() => finish([]), timeoutMs);
      timer.unref();
      const raced = this.eventsAfter(id);
      if (raced.length > 0) finish(raced);
    });
  }

  async dispatchAdvance(advance: MeetingAdvance | null | undefined) {
    await this.flushMeetingEmails();
    if (advance?.hostDispatchId) this.kickHostDispatches();
  }

  async delegateMeeting(actorId: string, meetingId: string, speakerId: string, prompt: string) {
    const priorityDeliveries = await this.drainPendingInterventions(meetingId);
    if (priorityDeliveries.length > 0) {
      this.store.acknowledgeHostContext(meetingId, actorId);
      return {
        meeting: this.store.meetingView(meetingId, actorId),
        turn: null,
        delivery: null,
        interventions: priorityDeliveries,
        deferred: true,
      };
    }
    const turn = this.store.delegateMeeting(actorId, meetingId, speakerId, prompt);
    const delivery = await this.deliverTurn(turn);
    const interventions = await this.drainPendingInterventions(meetingId);
    this.store.acknowledgeHostContext(meetingId, actorId);
    return {
      meeting: this.store.meetingView(meetingId, actorId),
      turn: {
        id: turn.turnId,
        speakerId: turn.speakerId,
        agentId: turn.agentId,
        contextFromSequence: turn.fromSequence,
        contextToSequence: turn.toSequence,
      },
      delivery,
      interventions,
      deferred: false,
    };
  }

  private emit(event: ServiceEvent) {
    this.eventHistory.push(event);
    if (this.eventHistory.length > 500) this.eventHistory.splice(0, this.eventHistory.length - 500);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn(`company-os event listener failed: ${formatError(error)}`);
      }
    }
  }

  private async recover() {
    const advances = this.store.sweepMeetingTimeouts(
      this.config.participantTurnTimeoutSeconds * 1000,
      this.config.hostIdleTimeoutSeconds * 1000,
    );
    for (const advance of advances) await this.dispatchAdvance(advance);
    if (advances.length === 0) await this.dispatchAdvance(this.store.recoveryAdvance());
  }

  private async scanTimeouts() {
    const advances = this.store.sweepMeetingTimeouts(
      this.config.participantTurnTimeoutSeconds * 1000,
      this.config.hostIdleTimeoutSeconds * 1000,
    );
    for (const advance of advances) await this.dispatchAdvance(advance);
    if (advances.length === 0) await this.flushMeetingEmails();
    this.kickHostDispatches();
  }

  private deliverTurn(turn: MeetingTurnDispatch): Promise<MeetingTurnDelivery> {
    const delivery = this.runTurnDelivery(turn);
    this.activeTurnDeliveries.add(delivery);
    void delivery.then(
      () => this.activeTurnDeliveries.delete(delivery),
      () => this.activeTurnDeliveries.delete(delivery),
    );
    return delivery;
  }

  private async runTurnDelivery(turn: MeetingTurnDispatch): Promise<MeetingTurnDelivery> {
    let invoked;
    try {
      invoked = await this.agentInvoker.invoke({
        agentId: turn.agentId,
        prompt: turn.prompt,
        timeoutSeconds: this.config.participantTurnTimeoutSeconds,
        signal: this.lifecycleAbort.signal,
      });
    } catch (error) {
      const message = `agent invoker crashed: ${formatError(error)}`;
      return this.store.isMeetingTurnWaiting(turn.turnId)
        ? this.store.failMeetingTurn(turn.turnId, message)
        : this.store.meetingTurnDelivery(turn.turnId);
    }
    if (!this.store.isMeetingTurnWaiting(turn.turnId)) {
      const verified = this.store.meetingTurnDelivery(turn.turnId);
      this.logger.info(`company-os verified meeting turn ${turn.turnId} from agent:${turn.agentId}:main via ${verified.completionSource}`);
      return verified;
    }
    if (invoked.ok) {
      const fallback = this.store.completeMeetingTurnFallback(turn.turnId, turn.speakerId, turn.agentId, invoked.text, invoked.raw);
      this.logger.warn(`company-os auto-recorded fallback speech for meeting turn ${turn.turnId} from agent:${turn.agentId}:main`);
      return fallback;
    }
    const failed = this.store.failMeetingTurn(turn.turnId, invoked.error);
    this.logger.error(`company-os meeting turn ${turn.turnId} failed for agent:${turn.agentId}:main: ${invoked.error}`);
    return failed;
  }

  private async drainPendingInterventions(meetingId: string) {
    const deliveries: MeetingTurnDelivery[] = [];
    for (let count = 0; count < 100; count += 1) {
      const turn = this.store.nextPendingInterventionTurn(meetingId);
      if (!turn) return deliveries;
      deliveries.push(await this.deliverTurn(turn));
    }
    throw new Error("too many pending Boss interventions in one meeting advance");
  }

  private kickHostDispatches() {
    if (this.stopping || this.dispatchFlush) return;
    this.dispatchFlush = this.flushHostDispatches()
      .catch((error) => this.logger.error(`company-os host dispatch loop failed: ${formatError(error)}`))
      .finally(() => {
        this.dispatchFlush = undefined;
        if (!this.stopping && this.store.hasPendingHostDispatches()) this.kickHostDispatches();
      });
  }

  private async flushHostDispatches() {
    while (!this.stopping) {
      const dispatch = this.store.claimNextHostDispatch();
      if (!dispatch) return;
      try {
        await this.drainPendingInterventions(dispatch.meetingId);
        const context = this.store.buildMeetingContext(dispatch.meetingId, dispatch.targetMemberId, {
          role: "host",
          instruction: dispatch.reason,
        });
        this.store.setHostDispatchContext(dispatch.id, context);
        const result = await this.agentInvoker.invoke({
          agentId: dispatch.targetAgentId,
          prompt: context.prompt,
          timeoutSeconds: this.config.hostIdleTimeoutSeconds,
          signal: this.lifecycleAbort.signal,
        });
        if (result.ok || this.store.hostDispatchHasProgress(dispatch.id)) {
          this.store.completeHostDispatch(dispatch.id, context.toSequence);
          if (!result.ok) {
            this.logger.warn(`company-os accepted host dispatch ${dispatch.id} after verified meeting progress despite CLI result: ${result.error}`);
          }
          this.logger.info(`company-os completed host dispatch ${dispatch.id} for agent:${dispatch.targetAgentId}:main`);
        } else {
          this.store.failHostDispatch(dispatch.id, result.error);
          this.logger.error(`company-os host dispatch ${dispatch.id} failed for agent:${dispatch.targetAgentId}:main: ${result.error}`);
        }
      } catch (error) {
        this.store.failHostDispatch(dispatch.id, formatError(error));
        this.logger.error(`company-os host dispatch ${dispatch.id} crashed: ${formatError(error)}`);
      }
    }
  }

  private async flushMeetingEmails(): Promise<void> {
    if (this.emailFlush) {
      await this.emailFlush;
      return this.flushMeetingEmails();
    }
    this.emailFlush = (async () => {
      for (const notification of this.store.pendingMeetingEmailNotifications()) {
        try {
          await this.meetingEmailSender.send(notification);
          this.store.markMeetingEmailSent(notification.id);
          this.logger.info(`company-os sent Boss meeting email ${notification.kind} for ${notification.meetingId}`);
        } catch (error) {
          const message = formatError(error);
          this.store.markMeetingEmailFailed(notification.id, message);
          this.logger.error(`company-os failed to send Boss meeting email ${notification.kind} for ${notification.meetingId}: ${message}`);
        }
      }
    })();
    try {
      await this.emailFlush;
    } finally {
      this.emailFlush = undefined;
    }
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
