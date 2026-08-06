import type { PluginLogger } from "openclaw/plugin-sdk/core";
import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness-runtime";

import { OpenClawCliAgentInvoker, type AgentInvoker } from "./agent-invoker.js";
import { SmtpMeetingEmailSender, type MeetingEmailSender } from "./email.js";
import { resolveAgentVisualIdentity, resolveStandaloneAvatar, type AgentVisualIdentity } from "./identity.js";
import { OpenClawSessionContextAppender, type SessionContextAppender } from "./session-context.js";
import { CompanyOsStore, nextTaskCheckinRunAt } from "./store.js";
import type {
  Actor,
  MeetingAdvance,
  MeetingToolSessionIdentity,
  MeetingTurnDelivery,
  MeetingTurnDispatch,
  ResolvedCompanyOsConfig,
  ServiceEvent,
} from "./types.js";

export class CompanyOsService {
  readonly store: CompanyOsStore;
  private readonly config: ResolvedCompanyOsConfig;
  private readonly logger: PluginLogger;
  private readonly runtimeConfig: unknown;
  private readonly meetingEmailSender: MeetingEmailSender;
  private readonly agentInvoker: AgentInvoker;
  private readonly sessionContextAppender: SessionContextAppender;
  private readonly isSessionActive: (sessionKey: string) => boolean;
  private readonly identityCache = new Map<string, AgentVisualIdentity>();
  private readonly listeners = new Set<(event: ServiceEvent) => void>();
  private readonly eventHistory: ServiceEvent[] = [];
  private scanTimer?: NodeJS.Timeout;
  private automaticEndTimer?: NodeJS.Timeout;
  private emailFlush?: Promise<void>;
  private dispatchFlush?: Promise<void>;
  private closeoutDispatchFlush?: Promise<void>;
  private closeoutRetryTimer?: NodeJS.Timeout;
  private taskDispatchFlush?: Promise<void>;
  private taskCheckinFlush?: Promise<void>;
  private taskCheckinRunTimer?: NodeJS.Timeout;
  private taskCheckinDispatchTimer?: NodeJS.Timeout;
  private contextAppendFlush?: Promise<void>;
  private contextAppendIdleTimer?: NodeJS.Timeout;
  private readonly contextAppendIdleQueue = new Map<string, { agentId: string; sessionKey: string; sessionId: string }>();
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
    sessionContextAppender?: SessionContextAppender;
    isSessionActive?: (sessionKey: string) => boolean;
  }) {
    this.config = options.config;
    this.runtimeConfig = options.runtimeConfig;
    this.logger = options.logger;
    this.meetingEmailSender = options.meetingEmailSender ?? new SmtpMeetingEmailSender(options.config.bossEmailNotifications);
    this.agentInvoker = options.agentInvoker ?? new OpenClawCliAgentInvoker();
    this.sessionContextAppender = options.sessionContextAppender ?? new OpenClawSessionContextAppender(options.runtimeConfig);
    this.isSessionActive = options.isSessionActive ?? ((sessionKey) => Boolean(resolveActiveEmbeddedRunSessionId(sessionKey)));
    this.store = new CompanyOsStore({
      databasePath: options.databasePath,
      allowedAgentIds: options.allowedAgentIds,
      config: options.config,
      organizationAdminAgentId: resolveOrganizationAdminAgentId(options.runtimeConfig, options.config.organizationAdminAgentId),
      onEvent: (event) => this.emit(event),
    });
  }

  async start() {
    this.store.recoverAgentDispatches();
    this.store.recoverMeetingCloseoutDispatches();
    this.store.recoverTaskDispatches();
    this.store.recoverTaskCheckinDispatches();
    this.store.recoverSessionContextAppends();
    await this.recover();
    await this.flushSessionContextAppends();
    await this.flushMeetingEmails();
    this.kickHostDispatches();
    this.kickMeetingCloseoutDispatches();
    this.kickTaskDispatches();
    this.kickTaskCheckinDispatches();
    this.scheduleNextTaskCheckinRun();
    this.scheduleNextAutomaticEnd();
    this.scanTimer = setInterval(() => {
      void this.scanTimeouts().catch((error) => this.logger.error(`company-os timeout scan failed: ${formatError(error)}`));
    }, 30_000);
    this.scanTimer.unref();
  }

  async stop() {
    this.stopping = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.automaticEndTimer) clearTimeout(this.automaticEndTimer);
    if (this.contextAppendIdleTimer) clearTimeout(this.contextAppendIdleTimer);
    if (this.closeoutRetryTimer) clearTimeout(this.closeoutRetryTimer);
    if (this.taskCheckinRunTimer) clearTimeout(this.taskCheckinRunTimer);
    if (this.taskCheckinDispatchTimer) clearTimeout(this.taskCheckinDispatchTimer);
    this.lifecycleAbort.abort();
    await Promise.allSettled([
      ...(this.dispatchFlush ? [this.dispatchFlush] : []),
      ...(this.closeoutDispatchFlush ? [this.closeoutDispatchFlush] : []),
      ...(this.taskDispatchFlush ? [this.taskDispatchFlush] : []),
      ...(this.taskCheckinFlush ? [this.taskCheckinFlush] : []),
      ...(this.contextAppendFlush ? [this.contextAppendFlush] : []),
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
    const visual = this.identityCache.get(memberId) ?? (member.kind === "boss"
      ? {
          agentId: "boss",
          configuredName: member.name,
          emoji: null,
          avatarUrl: resolveStandaloneAvatar(this.config.bossAvatarPath),
        }
      : resolveAgentVisualIdentity(this.runtimeConfig, member.agentId ?? memberId));
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
    this.kickMeetingCloseoutDispatches();
    this.scheduleNextAutomaticEnd();
  }

  remindTaskByBoss(taskId: string) {
    const dispatch = this.store.queueTaskReminderByBoss(taskId);
    this.kickTaskDispatches();
    return {
      dispatch,
      task: this.store.readTask("boss", taskId, false),
    };
  }

  reviewTask(actorId: Actor, taskId: string, decision: "accept" | "reject", feedback?: string) {
    const task = this.store.reviewTask(actorId, taskId, decision, feedback);
    this.kickTaskDispatches();
    return task;
  }

  dispatchTaskCheckinRun(scheduledAt: string | number | Date) {
    const run = this.store.queueTaskCheckinRun(scheduledAt);
    this.kickTaskCheckinDispatches();
    return run;
  }

  async delegateMeeting(
    actorId: string,
    meetingId: string,
    speakerId: string,
    prompt: string,
    sessionIdentity?: MeetingToolSessionIdentity,
  ) {
    const priorityDeliveries = await this.drainPendingInterventions(meetingId);
    if (priorityDeliveries.length > 0) {
      const hostDispatchId = this.store.queueHostResume(
        meetingId,
        "Boss 定向插话已优先处理。请阅读新增回答后继续主持；刚才尚未执行新的点名。",
        `host-resume-after-priority-interventions:${meetingId}:${priorityDeliveries.map((item) => item.turnId).join(":")}`,
      );
      this.kickHostDispatches();
      return {
        meeting: this.store.meetingView(meetingId, actorId),
        turn: null,
        delivery: null,
        interventions: priorityDeliveries,
        deferred: true,
        hostDispatchId,
      };
    }
    const turn = this.store.delegateMeeting(actorId, meetingId, speakerId, prompt, sessionIdentity);
    const delivery = await this.deliverTurn(turn);
    const interventions = await this.drainPendingInterventions(meetingId);
    const hostDispatchId = turn.contextAppendId
      ? this.store.queueHostResumeAfterContextAppend(
          meetingId,
          turn.contextAppendId,
          `第 ${turn.roundNumber} 轮参会者发言已经完成。请阅读新增会议记录并继续主持。`,
          `host-resume-after-delegate:${meetingId}:${turn.turnId}`,
        )
      : undefined;
    if (!turn.contextAppendId) this.store.acknowledgeHostContext(meetingId, actorId);
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
      hostDispatchId,
    };
  }

  async flushSessionContextAppends(identity?: { agentId: string; sessionKey: string; sessionId: string }): Promise<void> {
    if (this.contextAppendFlush) {
      await this.contextAppendFlush;
      if (this.store.hasPendingSessionContextAppends(identity)) return this.flushSessionContextAppends(identity);
      return;
    }
    this.contextAppendFlush = (async () => {
      while (!this.stopping) {
        const record = this.store.claimNextSessionContextAppend(identity);
        if (!record) return;
        try {
          const result = await this.sessionContextAppender.append(record);
          this.store.completeSessionContextAppend(record.id, result.messageId);
          this.logger.info(`company-os appended meeting context ${record.id} to ${record.sessionKey}`);
        } catch (error) {
          const message = formatError(error);
          const retry = this.store.failSessionContextAppend(record.id, message);
          this.logger.error(`company-os failed to append meeting context ${record.id}: ${message}`);
          if (!retry) continue;
        }
      }
    })();
    try {
      await this.contextAppendFlush;
    } finally {
      this.contextAppendFlush = undefined;
    }
    this.kickHostDispatches();
  }

  scheduleSessionContextAppendAfterTurn(identity: { agentId: string; sessionKey: string; sessionId: string }) {
    const normalized = {
      agentId: requiredIdentity(identity.agentId, "agentId"),
      sessionKey: requiredIdentity(identity.sessionKey, "sessionKey"),
      sessionId: requiredIdentity(identity.sessionId, "sessionId"),
    };
    this.contextAppendIdleQueue.set(`${normalized.sessionKey}\0${normalized.sessionId}`, normalized);
    this.scheduleIdleContextAppendCheck();
  }

  private scheduleIdleContextAppendCheck() {
    if (this.stopping || this.contextAppendIdleTimer || this.contextAppendIdleQueue.size === 0) return;
    this.contextAppendIdleTimer = setTimeout(() => {
      this.contextAppendIdleTimer = undefined;
      void this.flushIdleSessionContextAppends().catch((error) => {
        this.logger.error(`company-os idle session context append failed: ${formatError(error)}`);
        this.scheduleIdleContextAppendCheck();
      });
    }, 100);
    this.contextAppendIdleTimer.unref();
  }

  private async flushIdleSessionContextAppends() {
    for (const [key, identity] of this.contextAppendIdleQueue) {
      if (this.isSessionActive(identity.sessionKey)) continue;
      await this.flushSessionContextAppends(identity);
      if (!this.store.hasPendingSessionContextAppends(identity)) this.contextAppendIdleQueue.delete(key);
    }
    this.scheduleIdleContextAppendCheck();
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
    this.kickMeetingCloseoutDispatches();
    this.kickTaskDispatches();
    this.kickTaskCheckinDispatches();
    this.scheduleNextTaskCheckinDispatch();
    this.scheduleNextAutomaticEnd();
  }

  private scheduleNextAutomaticEnd() {
    if (this.automaticEndTimer) clearTimeout(this.automaticEndTimer);
    this.automaticEndTimer = undefined;
    if (this.stopping) return;
    const pending = this.store.nextAutomaticMeetingEnd();
    if (!pending) return;
    const delay = Math.max(0, Date.parse(pending.autoEndAt) - Date.now());
    this.automaticEndTimer = setTimeout(() => {
      this.automaticEndTimer = undefined;
      void this.finishAutomaticMeetingEnd().catch((error) => {
        this.logger.error(`company-os automatic meeting end failed: ${formatError(error)}`);
        if (this.stopping) return;
        this.automaticEndTimer = setTimeout(() => {
          this.automaticEndTimer = undefined;
          void this.finishAutomaticMeetingEnd().catch((retryError) => {
            this.logger.error(`company-os automatic meeting end retry failed: ${formatError(retryError)}`);
            this.scheduleNextAutomaticEnd();
          });
        }, 30_000);
        this.automaticEndTimer.unref();
      });
    }, delay);
    this.automaticEndTimer.unref();
  }

  private async finishAutomaticMeetingEnd() {
    const result = this.store.finalizeDueAutomaticMeetingEnd();
    if (result) await this.dispatchAdvance(result.advance);
    else this.scheduleNextAutomaticEnd();
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

  private kickMeetingCloseoutDispatches() {
    if (this.stopping || this.closeoutDispatchFlush) return;
    if (this.closeoutRetryTimer) {
      clearTimeout(this.closeoutRetryTimer);
      this.closeoutRetryTimer = undefined;
    }
    this.closeoutDispatchFlush = this.flushMeetingCloseoutDispatches()
      .catch((error) => this.logger.error(`company-os meeting closeout dispatch loop failed: ${formatError(error)}`))
      .finally(() => {
        this.closeoutDispatchFlush = undefined;
        if (this.stopping) return;
        if (this.store.hasReadyMeetingCloseoutDispatches()) this.kickMeetingCloseoutDispatches();
        else this.scheduleNextMeetingCloseoutDispatch();
      });
  }

  private scheduleNextMeetingCloseoutDispatch() {
    if (this.stopping || this.closeoutRetryTimer) return;
    const nextAttemptAt = this.store.nextMeetingCloseoutDispatchAt();
    if (!nextAttemptAt) return;
    const delay = Math.max(0, Date.parse(nextAttemptAt) - Date.now());
    this.closeoutRetryTimer = setTimeout(() => {
      this.closeoutRetryTimer = undefined;
      this.kickMeetingCloseoutDispatches();
    }, delay);
    this.closeoutRetryTimer.unref();
  }

  private async flushMeetingCloseoutDispatches() {
    while (!this.stopping) {
      const dispatch = this.store.claimNextMeetingCloseoutDispatch();
      if (!dispatch) return;
      try {
        const result = await this.agentInvoker.invoke({
          agentId: dispatch.runtimeAgentId,
          prompt: dispatch.prompt,
          timeoutSeconds: this.config.participantTurnTimeoutSeconds,
          signal: this.lifecycleAbort.signal,
        });
        if (result.ok || (result.code === "empty_reply" && result.completed)) {
          const advance = this.store.completeMeetingCloseoutDispatch(dispatch.id);
          if (!result.ok) {
            this.logger.warn(`company-os accepted meeting closeout ${dispatch.id} after a completed CLI turn returned no text payload`);
          }
          this.logger.info(`company-os delivered meeting closeout ${dispatch.id} to agent:${dispatch.runtimeAgentId}:main`);
          await this.dispatchAdvance(advance);
        } else {
          this.store.retryMeetingCloseoutDispatch(dispatch.id, result.error);
          this.logger.error(`company-os meeting closeout ${dispatch.id} failed for agent:${dispatch.runtimeAgentId}:main: ${result.error}`);
        }
      } catch (error) {
        const message = formatError(error);
        this.store.retryMeetingCloseoutDispatch(dispatch.id, message);
        this.logger.error(`company-os meeting closeout ${dispatch.id} crashed: ${message}`);
      }
    }
  }

  private kickTaskDispatches() {
    if (this.stopping || this.taskDispatchFlush) return;
    this.taskDispatchFlush = this.flushTaskDispatches()
      .catch((error) => this.logger.error(`company-os task dispatch loop failed: ${formatError(error)}`))
      .finally(() => {
        this.taskDispatchFlush = undefined;
        if (!this.stopping && this.store.hasPendingTaskDispatches()) this.kickTaskDispatches();
      });
  }

  private async flushTaskDispatches() {
    while (!this.stopping) {
      const dispatch = this.store.claimNextTaskDispatch();
      if (!dispatch) return;
      try {
        const result = await this.agentInvoker.invoke({
          agentId: dispatch.targetAgentId,
          prompt: dispatch.prompt,
          timeoutSeconds: this.config.participantTurnTimeoutSeconds,
          signal: this.lifecycleAbort.signal,
        });
        if (result.ok || this.store.taskDispatchHasProgress(dispatch.id)) {
          this.store.completeTaskDispatch(dispatch.id);
          if (!result.ok) {
            this.logger.warn(`company-os accepted task dispatch ${dispatch.id} after verified task progress despite CLI result: ${result.error}`);
          }
          this.logger.info(`company-os delivered task ${dispatch.kind} dispatch ${dispatch.id} to agent:${dispatch.targetAgentId}:main`);
        } else {
          this.store.failTaskDispatch(dispatch.id, result.error);
          this.logger.error(`company-os task ${dispatch.kind} dispatch ${dispatch.id} failed for agent:${dispatch.targetAgentId}:main: ${result.error}`);
        }
      } catch (error) {
        this.store.failTaskDispatch(dispatch.id, formatError(error));
        this.logger.error(`company-os task ${dispatch.kind} dispatch ${dispatch.id} crashed: ${formatError(error)}`);
      }
    }
  }

  private scheduleNextTaskCheckinRun() {
    if (this.taskCheckinRunTimer) clearTimeout(this.taskCheckinRunTimer);
    this.taskCheckinRunTimer = undefined;
    if (this.stopping || !this.config.taskHourlyCheckins.enabled) return;
    const scheduledAt = nextTaskCheckinRunAt(
      Date.now(),
      this.config.taskHourlyCheckins.startHour,
      this.config.taskHourlyCheckins.endHour,
    );
    const delay = Math.max(0, Date.parse(scheduledAt) - Date.now());
    this.taskCheckinRunTimer = setTimeout(() => {
      this.taskCheckinRunTimer = undefined;
      try {
        this.dispatchTaskCheckinRun(scheduledAt);
      } catch (error) {
        this.logger.error(`company-os task check-in run ${scheduledAt} failed: ${formatError(error)}`);
      } finally {
        this.scheduleNextTaskCheckinRun();
      }
    }, delay);
    this.taskCheckinRunTimer.unref();
  }

  private scheduleNextTaskCheckinDispatch() {
    if (this.taskCheckinDispatchTimer) clearTimeout(this.taskCheckinDispatchTimer);
    this.taskCheckinDispatchTimer = undefined;
    if (this.stopping || this.taskCheckinFlush) return;
    const scheduledAt = this.store.nextPendingTaskCheckinDispatchAt();
    if (!scheduledAt) return;
    const delay = Math.max(0, Date.parse(scheduledAt) - Date.now());
    this.taskCheckinDispatchTimer = setTimeout(() => {
      this.taskCheckinDispatchTimer = undefined;
      this.kickTaskCheckinDispatches();
    }, delay);
    this.taskCheckinDispatchTimer.unref();
  }

  private kickTaskCheckinDispatches() {
    if (this.stopping || this.taskCheckinFlush) return;
    if (this.taskCheckinDispatchTimer) clearTimeout(this.taskCheckinDispatchTimer);
    this.taskCheckinDispatchTimer = undefined;
    if (!this.store.hasDueTaskCheckinDispatches()) {
      this.scheduleNextTaskCheckinDispatch();
      return;
    }
    this.taskCheckinFlush = this.flushTaskCheckinDispatches()
      .catch((error) => this.logger.error(`company-os task check-in dispatch loop failed: ${formatError(error)}`))
      .finally(() => {
        this.taskCheckinFlush = undefined;
        if (!this.stopping && this.store.hasDueTaskCheckinDispatches()) this.kickTaskCheckinDispatches();
        else this.scheduleNextTaskCheckinDispatch();
      });
  }

  private async flushTaskCheckinDispatches() {
    while (!this.stopping) {
      const dispatch = this.store.claimNextTaskCheckinDispatch();
      if (!dispatch) return;
      try {
        if (dispatch.channel === "boss_email") {
          if (!dispatch.emailNotification) throw new Error("Boss task check-in email payload is missing");
          await this.meetingEmailSender.send(dispatch.emailNotification);
          this.store.completeTaskCheckinDispatch(dispatch.id);
          this.logger.info(`company-os sent Boss task check-in email for run ${dispatch.runId}`);
          continue;
        }
        if (!dispatch.targetAgentId || !dispatch.prompt) throw new Error("agent task check-in dispatch is incomplete");
        const result = await this.agentInvoker.invoke({
          agentId: dispatch.targetAgentId,
          prompt: dispatch.prompt,
          timeoutSeconds: this.config.participantTurnTimeoutSeconds,
          signal: this.lifecycleAbort.signal,
        });
        if (result.ok || this.store.taskCheckinDispatchHasProgress(dispatch.id)) {
          this.store.completeTaskCheckinDispatch(dispatch.id);
          if (!result.ok) {
            this.logger.warn(`company-os accepted task check-in ${dispatch.id} after verified task action despite CLI result: ${result.error}`);
          }
          this.logger.info(`company-os delivered task check-in ${dispatch.id} to agent:${dispatch.targetAgentId}:main`);
        } else {
          this.store.failTaskCheckinDispatch(dispatch.id, result.error);
          this.logger.error(`company-os task check-in ${dispatch.id} failed for agent:${dispatch.targetAgentId}:main: ${result.error}`);
        }
      } catch (error) {
        this.store.failTaskCheckinDispatch(dispatch.id, formatError(error));
        this.logger.error(`company-os task check-in ${dispatch.id} crashed: ${formatError(error)}`);
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

function requiredIdentity(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`meeting session ${field} is required`);
  return normalized;
}

function resolveOrganizationAdminAgentId(runtimeConfig: unknown, configured?: string) {
  if (configured?.trim()) return configured.trim();
  const agents = (runtimeConfig as { agents?: { list?: Array<{ id?: unknown; default?: unknown }> } } | undefined)?.agents?.list ?? [];
  const ids = agents.flatMap((agent) => typeof agent.id === "string" && agent.id.trim() ? [agent.id.trim()] : []);
  const selected = agents.find((agent) => agent.default === true && typeof agent.id === "string" && agent.id.trim());
  return typeof selected?.id === "string" ? selected.id.trim() : ids.includes("main") ? "main" : ids[0] ?? "main";
}
