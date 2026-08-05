import type { PluginLogger } from "openclaw/plugin-sdk/core";

import { resolveAgentVisualIdentity, type AgentVisualIdentity } from "./identity.js";
import { CompanyOsStore } from "./store.js";
import type { MeetingAdvance, ResolvedCompanyOsConfig, ServiceEvent } from "./types.js";

type SessionWorkflow = {
  scheduleSessionTurn(params: {
    sessionKey: string;
    agentId: string;
    message: string;
    delayMs: number;
    deliveryMode: "announce";
    deleteAfterRun: true;
    tag: string;
  }): Promise<unknown>;
  unscheduleSessionTurnsByTag(params: { sessionKey: string; tag: string }): Promise<unknown>;
};

export class CompanyOsService {
  readonly store: CompanyOsStore;
  private readonly config: ResolvedCompanyOsConfig;
  private readonly workflow: SessionWorkflow;
  private readonly logger: PluginLogger;
  private readonly runtimeConfig: unknown;
  private readonly identityCache = new Map<string, AgentVisualIdentity>();
  private readonly listeners = new Set<(event: ServiceEvent) => void>();
  private readonly eventHistory: ServiceEvent[] = [];
  private scanTimer?: NodeJS.Timeout;

  constructor(options: {
    databasePath: string;
    allowedAgentIds: Iterable<string>;
    config: ResolvedCompanyOsConfig;
    runtimeConfig: unknown;
    workflow: SessionWorkflow;
    logger: PluginLogger;
  }) {
    this.config = options.config;
    this.runtimeConfig = options.runtimeConfig;
    this.workflow = options.workflow;
    this.logger = options.logger;
    this.store = new CompanyOsStore({
      databasePath: options.databasePath,
      allowedAgentIds: options.allowedAgentIds,
      config: options.config,
      onEvent: (event) => this.emit(event),
    });
  }

  async start() {
    await this.recover();
    this.scanTimer = setInterval(() => {
      void this.scanTimeouts().catch((error) => this.logger.error(`company-os timeout scan failed: ${formatError(error)}`));
    }, 30_000);
    this.scanTimer.unref();
  }

  async stop() {
    if (this.scanTimer) clearInterval(this.scanTimer);
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
    if (!advance?.schedule) return;
    const schedule = advance.schedule;
    const sessionKey = `agent:${schedule.agentId}:main`;
    await this.workflow.unscheduleSessionTurnsByTag({ sessionKey, tag: schedule.tag });
    await this.workflow.scheduleSessionTurn({
      sessionKey,
      agentId: schedule.agentId,
      message: schedule.prompt,
      delayMs: 0,
      deliveryMode: "announce",
      deleteAfterRun: true,
      tag: schedule.tag,
    });
    this.logger.info(`company-os scheduled meeting ${schedule.meetingId} for ${sessionKey}`);
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
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
