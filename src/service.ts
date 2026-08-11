import type { PluginLogger } from "openclaw/plugin-sdk/core";
import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness-runtime";

import { OpenClawCliAgentInvoker, type AgentInvoker } from "./agent-invoker.js";
import { SmtpMeetingEmailSender, type MeetingEmailSender } from "./email.js";
import { GitCliRemoteVerifier, type GitRemoteVerifier } from "./git-verifier.js";
import { materializeWorkspaceReviewMaterial, prepareTaskReviewHandoff, resolveAgentWorkspace } from "./review-handoff.js";
import { resolveAgentVisualIdentity, resolveStandaloneAvatar } from "./identity.js";
import { OpenClawSessionContextAppender, type SessionContextAppender } from "./session-context.js";
import { InMemoryMeetingSessionRuntime, type MeetingSessionRuntime } from "./meeting-session-runtime.js";
import { CompanyOsStore, nextDailyAgentRunAt, nextNoticeReminderRunAt, nextTaskCheckinRunAt } from "./store.js";
import type {
  Actor,
  DailyAgentDispatch,
  DailyAgentKind,
  EvidenceInput,
  GitLocationInput,
  MeetingAdvance,
  MeetingToolSessionIdentity,
  MeetingTurnDelivery,
  MeetingTurnDispatch,
  ResolvedCompanyOsConfig,
  ServiceEvent,
  TaskReviewReport,
  TaskReviewHandoffInput,
} from "./types.js";

const TASK_PROMPT_SCHEDULE_REFRESH_MS = 250;

export class CompanyOsService {
  readonly store: CompanyOsStore;
  private readonly config: ResolvedCompanyOsConfig;
  private readonly logger: PluginLogger;
  private readonly runtimeConfig: unknown;
  private readonly meetingEmailSender: MeetingEmailSender;
  private readonly agentInvoker: AgentInvoker;
  private readonly gitRemoteVerifier: GitRemoteVerifier;
  private readonly sessionContextAppender: SessionContextAppender;
  private readonly meetingSessionRuntime: MeetingSessionRuntime;
  private readonly directMeetingSystemDelivery: boolean;
  private readonly isSessionActive: (sessionKey: string) => boolean;
  private readonly listeners = new Set<(event: ServiceEvent) => void>();
  private readonly eventHistory: ServiceEvent[] = [];
  private scanTimer?: NodeJS.Timeout;
  private automaticEndTimer?: NodeJS.Timeout;
  private emailFlush?: Promise<void>;
  private submissionMaterialFlush?: Promise<void>;
  private submissionMaterialRetryTimer?: NodeJS.Timeout;
  private dispatchFlush?: Promise<void>;
  private closeoutDispatchFlush?: Promise<void>;
  private closeoutRetryTimer?: NodeJS.Timeout;
  private meetingEntryFlush?: Promise<void>;
  private meetingEntryRetryTimer?: NodeJS.Timeout;
  private taskDispatchFlush?: Promise<void>;
  private taskCheckinFlush?: Promise<void>;
  private taskCheckinRunTimer?: NodeJS.Timeout;
  private taskCheckinDispatchTimer?: NodeJS.Timeout;
  private taskPromptTickTimer?: NodeJS.Timeout;
  private taskPromptScheduleRefreshTimer?: NodeJS.Timeout;
  private taskPromptScheduledAt: string | null = null;
  private readonly activeTaskPromptDeliveries = new Set<Promise<void>>();
  private readonly reservedMainSessions = new Set<string>();
  private noticeReminderFlush?: Promise<void>;
  private noticeReminderRunTimer?: NodeJS.Timeout;
  private dailySelfImprovementRunTimer?: NodeJS.Timeout;
  private dailyPersonaAuditRunTimer?: NodeJS.Timeout;
  private dailyAgentDispatchTimer?: NodeJS.Timeout;
  private readonly activeDailyAgentIds = new Set<string>();
  private readonly activeDailyAgentDeliveries = new Set<Promise<void>>();
  private contextAppendFlush?: Promise<void>;
  private contextAppendIdleTimer?: NodeJS.Timeout;
  private readonly contextAppendIdleQueue = new Map<string, { agentId: string; sessionKey: string; sessionId: string }>();
  private readonly activeTurnDeliveries = new Set<Promise<MeetingTurnDelivery>>();
  private readonly lifecycleAbort = new AbortController();
  private stopping = false;
  private started = false;

  constructor(options: {
    databasePath: string;
    allowedAgentIds: Iterable<string>;
    config: ResolvedCompanyOsConfig;
    runtimeConfig: unknown;
    logger: PluginLogger;
    meetingEmailSender?: MeetingEmailSender;
    agentInvoker?: AgentInvoker;
    gitRemoteVerifier?: GitRemoteVerifier;
    sessionContextAppender?: SessionContextAppender;
    meetingSessionRuntime?: MeetingSessionRuntime;
    isSessionActive?: (sessionKey: string) => boolean;
  }) {
    this.config = options.config;
    this.runtimeConfig = options.runtimeConfig;
    this.logger = options.logger;
    this.meetingEmailSender = options.meetingEmailSender ?? new SmtpMeetingEmailSender(options.config.bossEmailNotifications);
    this.agentInvoker = options.agentInvoker ?? new OpenClawCliAgentInvoker();
    this.gitRemoteVerifier = options.gitRemoteVerifier ?? new GitCliRemoteVerifier();
    this.sessionContextAppender = options.sessionContextAppender ?? new OpenClawSessionContextAppender(options.runtimeConfig);
    this.directMeetingSystemDelivery = Boolean(options.meetingSessionRuntime);
    this.meetingSessionRuntime = options.meetingSessionRuntime ?? new InMemoryMeetingSessionRuntime();
    this.isSessionActive = options.isSessionActive ?? ((sessionKey) => Boolean(resolveActiveEmbeddedRunSessionId(sessionKey)));
    this.store = new CompanyOsStore({
      databasePath: options.databasePath,
      allowedAgentIds: options.allowedAgentIds,
      config: options.config,
      organizationAdminAgentId: resolveOrganizationAdminAgentId(options.runtimeConfig, options.config.organizationAdminAgentId),
      defaultMeetingSessionMode: options.meetingSessionRuntime ? "dedicated" : "legacy_main",
      enforceBossExclusiveEnd: Boolean(options.meetingSessionRuntime),
      onEvent: (event) => this.emit(event),
    });
  }

  async start() {
    this.store.recoverMeetingEntryWork();
    this.store.recoverAgentDispatches();
    this.store.recoverMeetingCloseoutDispatches();
    this.store.recoverTaskDispatches();
    this.store.recoverTaskPromptDispatches();
    this.store.recoverTaskPromptCycleDispatches();
    this.store.recoverSubmissionMaterialDeliveries();
    this.store.recoverOverdueTaskPromptSchedules();
    this.store.recoverNoticeReminderDispatches();
    this.store.recoverDailyAgentDispatches();
    this.store.recoverSessionContextAppends();
    await this.recover();
    await this.flushSessionContextAppends();
    await this.flushMeetingEmails();
    await this.flushSubmissionMaterialDeliveries();
    this.kickHostDispatches();
    this.kickMeetingEntryWork();
    this.kickMeetingCloseoutDispatches();
    this.kickTaskDispatches();
    this.kickNoticeReminderDispatches();
    this.kickDailyAgentDispatches();
    this.started = true;
    this.scheduleNextTaskPromptCountdown();
    this.taskPromptScheduleRefreshTimer = setInterval(() => {
      this.refreshTaskPromptCountdown();
    }, TASK_PROMPT_SCHEDULE_REFRESH_MS);
    this.taskPromptScheduleRefreshTimer.unref();
    this.scheduleNextNoticeReminderRun();
    this.scheduleNextDailySelfImprovementRun();
    this.scheduleNextDailyPersonaAuditRun();
    this.scheduleNextAutomaticEnd();
    this.scanTimer = setInterval(() => {
      void this.scanTimeouts().catch((error) => this.logger.error(`company-os timeout scan failed: ${formatError(error)}`));
    }, 30_000);
    this.scanTimer.unref();
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.automaticEndTimer) clearTimeout(this.automaticEndTimer);
    if (this.contextAppendIdleTimer) clearTimeout(this.contextAppendIdleTimer);
    if (this.closeoutRetryTimer) clearTimeout(this.closeoutRetryTimer);
    if (this.meetingEntryRetryTimer) clearTimeout(this.meetingEntryRetryTimer);
    if (this.taskCheckinRunTimer) clearTimeout(this.taskCheckinRunTimer);
    if (this.taskCheckinDispatchTimer) clearTimeout(this.taskCheckinDispatchTimer);
    if (this.taskPromptTickTimer) clearTimeout(this.taskPromptTickTimer);
    if (this.taskPromptScheduleRefreshTimer) clearInterval(this.taskPromptScheduleRefreshTimer);
    if (this.noticeReminderRunTimer) clearTimeout(this.noticeReminderRunTimer);
    if (this.dailySelfImprovementRunTimer) clearTimeout(this.dailySelfImprovementRunTimer);
    if (this.dailyPersonaAuditRunTimer) clearTimeout(this.dailyPersonaAuditRunTimer);
    if (this.dailyAgentDispatchTimer) clearTimeout(this.dailyAgentDispatchTimer);
    if (this.submissionMaterialRetryTimer) clearTimeout(this.submissionMaterialRetryTimer);
    this.lifecycleAbort.abort();
    await Promise.allSettled([
      ...(this.dispatchFlush ? [this.dispatchFlush] : []),
      ...(this.closeoutDispatchFlush ? [this.closeoutDispatchFlush] : []),
      ...(this.meetingEntryFlush ? [this.meetingEntryFlush] : []),
      ...(this.taskDispatchFlush ? [this.taskDispatchFlush] : []),
      ...(this.taskCheckinFlush ? [this.taskCheckinFlush] : []),
      ...this.activeTaskPromptDeliveries,
      ...(this.noticeReminderFlush ? [this.noticeReminderFlush] : []),
      ...(this.emailFlush ? [this.emailFlush] : []),
      ...(this.submissionMaterialFlush ? [this.submissionMaterialFlush] : []),
      ...(this.contextAppendFlush ? [this.contextAppendFlush] : []),
      ...this.activeDailyAgentDeliveries,
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
    const visual = member.kind === "boss"
      ? {
          agentId: "boss",
          configuredName: member.name,
          emoji: null,
          avatarUrl: resolveStandaloneAvatar(this.config.bossAvatarPath),
        }
      : resolveAgentVisualIdentity(this.runtimeConfig, member.agentId ?? memberId);
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
    this.kickMeetingEntryWork();
    if (advance?.hostDispatchId) this.kickHostDispatches();
    this.kickMeetingCloseoutDispatches();
    this.kickTaskDispatches();
    this.kickTaskCheckinDispatches();
    this.kickNoticeReminderDispatches();
    this.scheduleNextAutomaticEnd();
  }

  kickMeetingEntryRetry() {
    this.kickMeetingEntryWork();
  }

  remindTaskByBoss(taskId: string) {
    const dispatch = this.store.queueTaskReminderByBoss(taskId);
    this.kickTaskDispatches();
    return {
      dispatch,
      task: this.store.readTask("boss", taskId, false),
    };
  }

  reviewTask(
    actorId: Actor,
    taskId: string,
    decision: "accept" | "reject" | "fail",
    feedback?: string,
    reviewReport?: TaskReviewReport,
  ) {
    const task = this.store.reviewTask(actorId, taskId, decision, feedback, reviewReport);
    this.kickTaskDispatches();
    return task;
  }

  async submitTask(
    actorId: string,
    taskId: string,
    summary: string,
    evidence: EvidenceInput[],
    gitLocation: GitLocationInput,
    reviewHandoff?: TaskReviewHandoffInput,
  ) {
    const prepared = prepareTaskReviewHandoff(this.runtimeConfig, actorId, evidence, reviewHandoff);
    const verifiedGitLocation = await this.gitRemoteVerifier.verify(gitLocation);
    const task = this.store.submitTask(
      actorId,
      taskId,
      summary,
      prepared.evidence,
      verifiedGitLocation,
      prepared.reviewHandoff,
    );
    void this.flushMeetingEmails().catch((error) => {
      this.logger.error(`company-os task review email flush failed after submission ${taskId}: ${formatError(error)}`);
    });
    this.kickSubmissionMaterialDeliveries();
    return task;
  }

  blockTask(actorId: string, taskId: string, reason: string) {
    const task = this.store.blockTask(actorId, taskId, reason);
    this.kickTaskDispatches();
    void this.flushMeetingEmails().catch((error) => {
      this.logger.error(`company-os blocked task email flush failed for ${taskId}: ${formatError(error)}`);
    });
    return task;
  }

  unblockTask(actorId: Actor, taskId: string, reason: string) {
    const task = this.store.unblockTask(actorId, taskId, reason);
    this.kickTaskDispatches();
    return task;
  }

  cancelTask(actorId: Actor, taskId: string, reason: string) {
    const current = this.store.readTask(actorId, taskId, false);
    if (actorId !== "boss" && current.status === "blocked") {
      const request = this.store.requestTaskCancellation(actorId, taskId, reason);
      void this.flushMeetingEmails().catch((error) => {
        this.logger.error(`company-os cancellation request email flush failed for ${taskId}: ${formatError(error)}`);
      });
      return { outcome: "approval_requested" as const, request, task: this.store.readTask(actorId, taskId, false) };
    }
    const task = this.store.cancelTask(actorId, taskId, reason);
    this.kickTaskDispatches();
    return { outcome: "canceled" as const, task };
  }

  async abortTaskByBoss(taskId: string, reason: string) {
    const result = this.store.abortTaskByBoss(taskId, reason);
    this.kickTaskDispatches();
    await this.dispatchAdvance(result.advance);
    const { advance: _advance, ...response } = result;
    return response;
  }

  reviewTaskCancellationRequest(taskId: string, requestId: string, decision: "accept" | "reject", feedback?: string) {
    const result = this.store.reviewTaskCancellationRequest("boss", taskId, requestId, decision, feedback);
    this.kickTaskDispatches();
    return result;
  }

  correctTaskTerminalDecision(
    actorId: Actor,
    taskId: string,
    action: "revoke_acceptance" | "restore_cancellation",
    reason: string,
    reviewReport?: TaskReviewReport,
  ) {
    const task = this.store.correctTaskTerminalDecision(actorId, taskId, action, reason, reviewReport);
    this.kickTaskDispatches();
    return task;
  }

  dispatchTaskCheckinRun(scheduledAt: string | number | Date) {
    const run = this.store.queueTaskCheckinRun(scheduledAt);
    this.kickTaskCheckinDispatches();
    return run;
  }

  async dispatchTaskPromptTick(scheduledAt: string | number | Date) {
    const tick = this.store.queueTaskPromptTick(scheduledAt);
    const deliveries = this.store.taskPromptTickMembers().map((member) => {
      let delivery!: Promise<void>;
      delivery = this.deliverTaskPromptTickMember(tick.id, member.id)
        .catch((error) => this.logger.error(`company-os rolling task prompt failed for ${member.id}: ${formatError(error)}`))
        .finally(() => this.activeTaskPromptDeliveries.delete(delivery));
      this.activeTaskPromptDeliveries.add(delivery);
      return delivery;
    });
    await Promise.allSettled(deliveries);
    return tick;
  }

  dispatchNoticeReminderRun(scheduledAt: string | number | Date) {
    const run = this.store.queueNoticeReminderRun(scheduledAt);
    this.kickNoticeReminderDispatches();
    return run;
  }

  dispatchDailySelfImprovementRun(scheduledAt: string | number | Date) {
    return this.dispatchDailyAgentRun("daily_self_improvement", scheduledAt);
  }

  dispatchDailyPersonaAuditRun(scheduledAt: string | number | Date) {
    return this.dispatchDailyAgentRun("daily_persona_audit", scheduledAt);
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

  private mainSessionKey(agentId: string) {
    return `agent:${agentId}:main`;
  }

  private mainSessionIsBusy(agentId: string) {
    return this.sessionIsBusy(this.mainSessionKey(agentId));
  }

  private sessionIsBusy(sessionKey: string) {
    if (this.reservedMainSessions.has(sessionKey)) return true;
    try {
      return this.isSessionActive(sessionKey);
    } catch (error) {
      this.logger.warn(`company-os could not read active-run registry for ${sessionKey}: ${formatError(error)}`);
      return true;
    }
  }

  private tryReserveMainSession(agentId: string) {
    return this.tryReserveSession(this.mainSessionKey(agentId));
  }

  private tryReserveSession(sessionKey: string) {
    if (this.sessionIsBusy(sessionKey)) return false;
    this.reservedMainSessions.add(sessionKey);
    return true;
  }

  private async reserveMainSession(agentId: string, mode: "wait" | "skip") {
    return this.reserveSession(this.mainSessionKey(agentId), mode);
  }

  private async reserveSession(sessionKey: string, mode: "wait" | "skip") {
    while (!this.stopping && !this.lifecycleAbort.signal.aborted) {
      if (this.tryReserveSession(sessionKey)) return true;
      if (mode === "skip") return false;
      await shortWait(100, this.lifecycleAbort.signal);
    }
    return false;
  }

  private releaseMainSession(agentId: string) {
    this.reservedMainSessions.delete(this.mainSessionKey(agentId));
  }

  private releaseSession(sessionKey: string) {
    this.reservedMainSessions.delete(sessionKey);
  }

  private async invokeMainSession(input: {
    agentId: string;
    prompt: string;
    timeoutSeconds: number;
    maxInFlightRetries?: number;
  }) {
    const reserved = await this.reserveMainSession(input.agentId, "wait");
    if (!reserved) throw new Error("Company OS is stopping before the main session could be reserved");
    try {
      return await this.agentInvoker.invoke({
        ...input,
        signal: this.lifecycleAbort.signal,
      });
    } finally {
      this.releaseMainSession(input.agentId);
    }
  }

  private async invokeMeetingSession(input: {
    agentId: string;
    sessionKey: string;
    prompt: string;
    timeoutSeconds: number;
  }) {
    const reserved = await this.reserveSession(input.sessionKey, "wait");
    if (!reserved) throw new Error("Company OS is stopping before the meeting session could be reserved");
    try {
      return await this.agentInvoker.invoke({ ...input, signal: this.lifecycleAbort.signal });
    } finally {
      this.releaseSession(input.sessionKey);
    }
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
    if (this.started && (event.type.startsWith("task.prompt_pool_") || event.type === "task.prompt_interval_updated")) {
      queueMicrotask(() => this.scheduleNextTaskPromptCountdown());
    }
  }

  setTaskPromptInterval(memberId: string, intervalMinutes: number | null) {
    const result = this.store.setTaskPromptInterval(memberId, intervalMinutes);
    this.scheduleNextTaskPromptCountdown();
    return result;
  }

  setTaskPromptWorkHours(startHour: number | null, endHour: number | null) {
    const result = this.store.setTaskPromptWorkHours(startHour, endHour);
    this.scheduleNextTaskPromptCountdown();
    return result;
  }

  setTaskPromptMinutesPerLevel(minutesPerLevel: number | null) {
    const result = this.store.setTaskPromptMinutesPerLevel(minutesPerLevel);
    this.scheduleNextTaskPromptCountdown();
    return result;
  }

  setTaskPromptPaused(paused: boolean) {
    const result = this.store.setTaskPromptPaused(paused);
    this.scheduleNextTaskPromptCountdown();
    return result;
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
    this.kickDailyAgentDispatches();
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
      invoked = await this.invokeMeetingSession({
        agentId: turn.agentId,
        sessionKey: turn.sessionKey,
        prompt: turn.prompt,
        timeoutSeconds: this.config.participantTurnTimeoutSeconds,
      });
    } catch (error) {
      const message = `agent invoker crashed: ${formatError(error)}`;
      return this.store.isMeetingTurnWaiting(turn.turnId)
        ? this.store.failMeetingTurn(turn.turnId, message)
        : this.store.meetingTurnDelivery(turn.turnId);
    }
    if (!this.store.isMeetingTurnWaiting(turn.turnId)) {
      const verified = this.store.meetingTurnDelivery(turn.turnId);
      this.logger.info(`company-os verified meeting turn ${turn.turnId} from ${turn.sessionKey} via ${verified.completionSource}`);
      return verified;
    }
    if (invoked.ok) {
      const fallback = this.store.completeMeetingTurnFallback(turn.turnId, turn.speakerId, turn.agentId, invoked.text, invoked.raw);
      this.logger.warn(`company-os auto-recorded fallback speech for meeting turn ${turn.turnId} from ${turn.sessionKey}`);
      return fallback;
    }
    const failed = this.store.failMeetingTurn(turn.turnId, invoked.error);
    this.logger.error(`company-os meeting turn ${turn.turnId} failed for ${turn.sessionKey}: ${invoked.error}`);
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

  private kickMeetingEntryWork() {
    if (this.stopping || this.meetingEntryFlush) return;
    if (this.meetingEntryRetryTimer) {
      clearTimeout(this.meetingEntryRetryTimer);
      this.meetingEntryRetryTimer = undefined;
    }
    this.meetingEntryFlush = this.flushMeetingEntryWork()
      .catch((error) => this.logger.error(`company-os meeting entry loop failed: ${formatError(error)}`))
      .finally(() => {
        this.meetingEntryFlush = undefined;
        if (this.stopping) return;
        if (this.store.hasReadyMeetingEntryWork()) this.kickMeetingEntryWork();
        else this.scheduleNextMeetingEntryWork();
      });
  }

  private scheduleNextMeetingEntryWork() {
    if (this.stopping || this.meetingEntryRetryTimer) return;
    const nextAttemptAt = this.store.nextMeetingEntryWorkAt();
    if (!nextAttemptAt) return;
    const delay = Math.max(0, Date.parse(nextAttemptAt) - Date.now());
    this.meetingEntryRetryTimer = setTimeout(() => {
      this.meetingEntryRetryTimer = undefined;
      this.kickMeetingEntryWork();
    }, delay);
    this.meetingEntryRetryTimer.unref();
  }

  private async flushMeetingEntryWork() {
    while (!this.stopping) {
      const notification = this.store.claimNextMeetingEntryNotification();
      if (notification) {
        const reserved = await this.reserveMainSession(notification.runtimeAgentId, "wait");
        if (!reserved) return;
        try {
          await this.meetingSessionRuntime.appendMainSystemMessage({
            agentId: notification.runtimeAgentId,
            sessionKey: notification.mainSessionKey,
            text: notification.prompt,
            idempotencyKey: `company-os:meeting-entry:${notification.id}`,
          });
          this.store.completeMeetingEntryNotification(notification.id);
          this.logger.info(`company-os delivered meeting entry ${notification.id} to ${notification.mainSessionKey}`);
        } catch (error) {
          this.store.retryMeetingEntryNotification(notification.id, formatError(error));
          this.logger.error(`company-os meeting entry ${notification.id} failed: ${formatError(error)}`);
        } finally {
          this.releaseMainSession(notification.runtimeAgentId);
        }
        continue;
      }

      const session = this.store.claimNextMeetingSessionProvision();
      if (session) {
        try {
          const ensured = await this.meetingSessionRuntime.ensureSession({
            agentId: session.runtimeAgentId,
            sessionKey: session.sessionKey,
            label: session.label,
            category: "Company OS 会议",
          });
          const advance = this.store.completeMeetingSessionProvision(session.id, ensured.sessionId, ensured.sessionKey);
          if (advance.hostDispatchId) this.kickHostDispatches();
          this.logger.info(`company-os provisioned meeting session ${session.sessionKey}`);
        } catch (error) {
          this.store.retryMeetingSessionProvision(session.id, formatError(error));
          this.logger.error(`company-os meeting session ${session.sessionKey} failed: ${formatError(error)}`);
        }
        continue;
      }

      const archive = this.store.claimNextMeetingSessionArchive();
      if (!archive) return;
      try {
        await this.meetingSessionRuntime.releaseSession({ agentId: archive.runtimeAgentId, sessionKey: archive.sessionKey });
        this.store.completeMeetingSessionArchive(archive.id);
        this.logger.info(`company-os released fixed meeting session ${archive.sessionKey}`);
      } catch (error) {
        this.store.retryMeetingSessionArchive(archive.id, formatError(error));
        this.logger.error(`company-os meeting session archive ${archive.sessionKey} failed: ${formatError(error)}`);
      }
    }
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
        const session = this.store.meetingSessionForMember(dispatch.meetingId, dispatch.targetMemberId);
        const result = await this.invokeMeetingSession({
          agentId: dispatch.targetAgentId,
          sessionKey: session.sessionKey,
          prompt: context.prompt,
          timeoutSeconds: this.config.hostIdleTimeoutSeconds,
        });
        const verifiedProgress = this.store.hostDispatchHasProgress(dispatch.id);
        if (dispatch.kind === "host_summary" && !verifiedProgress) {
          const reason = result.ok
            ? "host returned without calling company_meeting_submit_summary"
            : result.error;
          this.store.failHostDispatch(dispatch.id, reason);
          this.logger.error(`company-os host summary dispatch ${dispatch.id} failed for ${session.sessionKey}: ${reason}`);
        } else if (result.ok || verifiedProgress) {
          this.store.completeHostDispatch(dispatch.id, context.toSequence);
          if (!result.ok) {
            this.logger.warn(`company-os accepted host dispatch ${dispatch.id} after verified meeting progress despite CLI result: ${result.error}`);
          }
          this.logger.info(`company-os completed host dispatch ${dispatch.id} for ${session.sessionKey}`);
        } else {
          this.store.failHostDispatch(dispatch.id, result.error);
          this.logger.error(`company-os host dispatch ${dispatch.id} failed for ${session.sessionKey}: ${result.error}`);
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
      const reserved = await this.reserveMainSession(dispatch.runtimeAgentId, "wait");
      if (!reserved) return;
      try {
        if (this.directMeetingSystemDelivery) {
          await this.meetingSessionRuntime.appendMainSystemMessage({
            agentId: dispatch.runtimeAgentId,
            sessionKey: this.mainSessionKey(dispatch.runtimeAgentId),
            text: dispatch.prompt,
            idempotencyKey: `company-os:meeting-closeout:${dispatch.id}`,
          });
        } else {
          const result = await this.agentInvoker.invoke({
            agentId: dispatch.runtimeAgentId,
            prompt: dispatch.prompt,
            timeoutSeconds: this.config.participantTurnTimeoutSeconds,
            signal: this.lifecycleAbort.signal,
          });
          if (!result.ok && !(result.code === "empty_reply" && result.completed)) throw new Error(result.error);
        }
        const advance = this.store.completeMeetingCloseoutDispatch(dispatch.id);
        this.logger.info(`company-os delivered meeting closeout ${dispatch.id} to agent:${dispatch.runtimeAgentId}:main`);
        await this.dispatchAdvance(advance);
      } catch (error) {
        const message = formatError(error);
        this.store.retryMeetingCloseoutDispatch(dispatch.id, message);
        this.logger.error(`company-os meeting closeout ${dispatch.id} crashed: ${message}`);
      } finally {
        this.releaseMainSession(dispatch.runtimeAgentId);
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
      const target = this.store.nextTaskDispatchTarget();
      if (!target) return;
      const reserved = await this.reserveMainSession(target.agentId, "wait");
      if (!reserved) return;
      const dispatch = this.store.claimNextTaskDispatch();
      if (!dispatch) {
        this.releaseMainSession(target.agentId);
        continue;
      }
      if (dispatch.targetAgentId !== target.agentId) {
        this.releaseMainSession(target.agentId);
        this.store.failTaskDispatch(dispatch.id, "dispatch target changed while reserving main session", true);
        continue;
      }
      try {
        const result = await this.agentInvoker.invoke({
          agentId: dispatch.targetAgentId,
          prompt: dispatch.prompt,
          timeoutSeconds: this.config.participantTurnTimeoutSeconds,
          maxInFlightRetries: 0,
          signal: this.lifecycleAbort.signal,
        });
        if (result.ok || (result.code === "empty_reply" && result.completed) || this.store.taskDispatchHasProgress(dispatch.id)) {
          this.store.completeTaskDispatch(dispatch.id);
          if (!result.ok) {
            this.logger.warn(`company-os accepted task dispatch ${dispatch.id} after a completed turn or verified task progress despite CLI result: ${result.error}`);
          }
          this.logger.info(`company-os delivered task ${dispatch.kind} dispatch ${dispatch.id} to agent:${dispatch.targetAgentId}:main`);
        } else {
          this.store.failTaskDispatch(dispatch.id, result.error, definitelyUndelivered(result.code));
          this.logger.error(`company-os task ${dispatch.kind} dispatch ${dispatch.id} failed for agent:${dispatch.targetAgentId}:main: ${result.error}`);
        }
      } catch (error) {
        this.store.failTaskDispatch(dispatch.id, formatError(error), false);
        this.logger.error(`company-os task ${dispatch.kind} dispatch ${dispatch.id} crashed: ${formatError(error)}`);
      } finally {
        this.releaseMainSession(dispatch.targetAgentId);
      }
    }
  }

  private scheduleNextTaskPromptCountdown() {
    if (this.taskPromptTickTimer) clearTimeout(this.taskPromptTickTimer);
    this.taskPromptTickTimer = undefined;
    if (this.stopping || !this.config.taskRollingPrompts.enabled) {
      this.taskPromptScheduledAt = null;
      return;
    }
    const scheduledAt = this.store.nextTaskPromptDueAt();
    this.taskPromptScheduledAt = scheduledAt;
    if (!scheduledAt) return;
    const delay = Math.max(0, Date.parse(scheduledAt) - Date.now());
    this.taskPromptTickTimer = setTimeout(() => {
      this.taskPromptTickTimer = undefined;
      void this.dispatchDueTaskPrompts().catch((error) => {
        this.logger.error(`company-os rolling task prompt countdown ${scheduledAt} failed: ${formatError(error)}`);
      }).finally(() => this.scheduleNextTaskPromptCountdown());
    }, delay);
    this.taskPromptTickTimer.unref();
    this.logger.info(`company-os scheduled next personal task prompt countdown at ${scheduledAt} (Asia/Shanghai)`);
  }

  private refreshTaskPromptCountdown() {
    if (this.stopping || !this.config.taskRollingPrompts.enabled) return;
    try {
      const scheduledAt = this.store.peekNextTaskPromptDueAt();
      if (scheduledAt !== this.taskPromptScheduledAt
        || (!this.taskPromptTickTimer && this.activeTaskPromptDeliveries.size === 0)) {
        this.scheduleNextTaskPromptCountdown();
      }
    } catch (error) {
      this.logger.error(`company-os personal task prompt schedule refresh failed: ${formatError(error)}`);
    }
  }

  private async dispatchDueTaskPrompts(now = Date.now()) {
    const deliveries = this.store.dueTaskPromptMembers(now).map((memberId) => {
      let delivery!: Promise<void>;
      delivery = this.deliverTaskPromptCountdownMember(memberId, now)
        .catch((error) => this.logger.error(`company-os rolling task prompt failed for ${memberId}: ${formatError(error)}`))
        .finally(() => this.activeTaskPromptDeliveries.delete(delivery));
      this.activeTaskPromptDeliveries.add(delivery);
      return delivery;
    });
    await Promise.allSettled(deliveries);
  }

  private async deliverTaskPromptCountdownMember(memberId: string, now: number) {
    const member = this.store.listMembers(true).find((candidate) => candidate.id === memberId);
    if (!member?.agentId) return;
    const activeMeeting = this.store.meetingFocusForMember(memberId);
    if (activeMeeting) {
      const reason = `member is participating in active meeting ${activeMeeting.id}: ${activeMeeting.title}`;
      this.store.createTaskPromptCycleDispatch(memberId, true, reason, now);
      this.logger.info(`company-os skipped rolling task prompt for ${memberId}: ${reason}`);
      return;
    }
    const reserved = await this.reserveMainSession(member.agentId, "skip");
    if (!reserved) {
      this.store.createTaskPromptCycleDispatch(memberId, true, "main session is busy", now);
      this.logger.info(`company-os skipped rolling task prompt for ${memberId}: main session is busy`);
      return;
    }
    let dispatch;
    try {
      dispatch = this.store.createTaskPromptCycleDispatch(memberId, false, undefined, now);
      if (!dispatch.claimed || dispatch.status !== "running" || !dispatch.prompt) return;
      let invocationSettled = false;
      const invocation = this.agentInvoker.invoke({
        agentId: dispatch.targetAgentId,
        prompt: dispatch.prompt,
        timeoutSeconds: this.config.participantTurnTimeoutSeconds,
        maxInFlightRetries: 0,
        signal: this.lifecycleAbort.signal,
      });
      const startObserver = this.observeTaskPromptInvocationStart(
        dispatch.id,
        dispatch.targetAgentId,
        () => invocationSettled,
      );
      const result = await invocation.finally(() => { invocationSettled = true; });
      await startObserver;
      const started = invocationConfirmedStarted(result);
      if (started) this.store.markTaskPromptCycleDispatchStarted(dispatch.id);
      if (result.ok || (!result.ok && result.code === "empty_reply" && result.completed)) {
        this.store.finishTaskPromptCycleDispatch(dispatch.id, { status: "succeeded" });
      } else if (!started && result.code === "in_flight") {
        this.store.finishTaskPromptCycleDispatch(dispatch.id, { status: "skipped_busy", error: result.error });
      } else {
        this.store.finishTaskPromptCycleDispatch(dispatch.id, { status: "failed", error: result.error });
      }
    } catch (error) {
      if (dispatch?.status === "running") {
        this.store.finishTaskPromptCycleDispatch(dispatch.id, { status: "failed", error: formatError(error) });
      }
      throw error;
    } finally {
      this.releaseMainSession(member.agentId);
    }
  }

  private async observeTaskPromptInvocationStart(dispatchId: string, agentId: string, settled: () => boolean) {
    await shortWait(150, this.lifecycleAbort.signal);
    while (!settled() && !this.lifecycleAbort.signal.aborted) {
      try {
        if (this.isSessionActive(this.mainSessionKey(agentId))) {
          this.store.markTaskPromptCycleDispatchStarted(dispatchId);
          return;
        }
      } catch (error) {
        this.logger.warn(`company-os could not confirm task prompt start for agent:${agentId}:main: ${formatError(error)}`);
        return;
      }
      await shortWait(50, this.lifecycleAbort.signal);
    }
  }

  private async deliverTaskPromptTickMember(tickId: string, memberId: string) {
    const member = this.store.listMembers(true).find((candidate) => candidate.id === memberId);
    if (!member?.agentId) return;
    const activeMeeting = this.store.meetingFocusForMember(memberId);
    if (activeMeeting) {
      const reason = `member is participating in active meeting ${activeMeeting.id}: ${activeMeeting.title}`;
      this.store.createTaskPromptDispatch(tickId, memberId, true, reason);
      this.logger.info(`company-os skipped rolling task prompt for ${memberId}: ${reason}`);
      return;
    }
    const reserved = await this.reserveMainSession(member.agentId, "skip");
    if (!reserved) {
      this.store.createTaskPromptDispatch(tickId, memberId, true);
      this.logger.info(`company-os skipped rolling task prompt for ${memberId}: main session is busy`);
      return;
    }
    let dispatch;
    try {
      dispatch = this.store.createTaskPromptDispatch(tickId, memberId, false);
      if (!dispatch.claimed || dispatch.status !== "running" || !dispatch.prompt) return;
      const result = await this.agentInvoker.invoke({
        agentId: dispatch.targetAgentId,
        prompt: dispatch.prompt,
        timeoutSeconds: this.config.participantTurnTimeoutSeconds,
        maxInFlightRetries: 0,
        signal: this.lifecycleAbort.signal,
      });
      const started = invocationConfirmedStarted(result);
      if (started) this.store.markTaskPromptDispatchStarted(dispatch.id);
      if (result.ok || (!result.ok && result.code === "empty_reply" && result.completed)) {
        this.store.finishTaskPromptDispatch(dispatch.id, { status: "succeeded" });
        this.logger.info(`company-os delivered rolling task prompt ${dispatch.id} to ${this.mainSessionKey(dispatch.targetAgentId)}`);
      } else if (!started && result.code === "in_flight") {
        this.store.finishTaskPromptDispatch(dispatch.id, { status: "skipped_busy", error: result.error });
      } else {
        this.store.finishTaskPromptDispatch(dispatch.id, { status: "failed", error: result.error });
        this.logger.error(`company-os rolling task prompt ${dispatch.id} failed: ${result.error}`);
      }
    } catch (error) {
      if (dispatch?.status === "running") {
        this.store.finishTaskPromptDispatch(dispatch.id, { status: "failed", error: formatError(error) });
      }
      throw error;
    } finally {
      this.releaseMainSession(member.agentId);
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
        const result = await this.invokeMainSession({
          agentId: dispatch.targetAgentId,
          prompt: dispatch.prompt,
          timeoutSeconds: this.config.participantTurnTimeoutSeconds,
          maxInFlightRetries: 0,
        });
        if (result.ok || (result.code === "empty_reply" && result.completed) || this.store.taskCheckinDispatchHasProgress(dispatch.id)) {
          this.store.completeTaskCheckinDispatch(dispatch.id);
          if (!result.ok) {
            this.logger.warn(`company-os accepted task check-in ${dispatch.id} after a completed turn or verified task action despite CLI result: ${result.error}`);
          }
          this.logger.info(`company-os delivered task check-in ${dispatch.id} to agent:${dispatch.targetAgentId}:main`);
        } else {
          this.store.failTaskCheckinDispatch(dispatch.id, result.error, false);
          this.logger.error(`company-os task check-in ${dispatch.id} failed for agent:${dispatch.targetAgentId}:main: ${result.error}`);
        }
      } catch (error) {
        this.store.failTaskCheckinDispatch(dispatch.id, formatError(error), dispatch.channel === "boss_email");
        this.logger.error(`company-os task check-in ${dispatch.id} crashed: ${formatError(error)}`);
      }
    }
  }

  private scheduleNextNoticeReminderRun() {
    if (this.noticeReminderRunTimer) clearTimeout(this.noticeReminderRunTimer);
    this.noticeReminderRunTimer = undefined;
    if (this.stopping || !this.config.noticeUnreadReminders.enabled) return;
    const scheduledAt = nextNoticeReminderRunAt(
      Date.now(),
      this.config.noticeUnreadReminders.startHour,
      this.config.noticeUnreadReminders.endHour,
    );
    const delay = Math.max(0, Date.parse(scheduledAt) - Date.now());
    this.noticeReminderRunTimer = setTimeout(() => {
      this.noticeReminderRunTimer = undefined;
      try {
        this.dispatchNoticeReminderRun(scheduledAt);
      } catch (error) {
        this.logger.error(`company-os notice reminder run ${scheduledAt} failed: ${formatError(error)}`);
      } finally {
        this.scheduleNextNoticeReminderRun();
      }
    }, delay);
    this.noticeReminderRunTimer.unref();
  }

  private kickNoticeReminderDispatches() {
    if (this.stopping || this.noticeReminderFlush || !this.store.hasDueNoticeReminderDispatches()) return;
    this.noticeReminderFlush = this.flushNoticeReminderDispatches()
      .catch((error) => this.logger.error(`company-os notice reminder dispatch loop failed: ${formatError(error)}`))
      .finally(() => {
        this.noticeReminderFlush = undefined;
        if (!this.stopping && this.store.hasDueNoticeReminderDispatches()) this.kickNoticeReminderDispatches();
      });
  }

  private async flushNoticeReminderDispatches() {
    while (!this.stopping) {
      const dispatch = this.store.claimNextNoticeReminderDispatch();
      if (!dispatch) return;
      try {
        if (!dispatch.prompt) throw new Error("notice reminder dispatch prompt is missing");
        const result = await this.invokeMainSession({
          agentId: dispatch.targetAgentId,
          prompt: dispatch.prompt,
          timeoutSeconds: this.config.participantTurnTimeoutSeconds,
          maxInFlightRetries: 0,
        });
        if (result.ok || (result.code === "empty_reply" && result.completed) || this.store.noticeReminderDispatchHasReadProgress(dispatch.id)) {
          this.store.completeNoticeReminderDispatch(dispatch.id);
          if (!result.ok) {
            this.logger.warn(`company-os accepted notice reminder ${dispatch.id} after a completed turn or verified notice read despite CLI result: ${result.error}`);
          }
          this.logger.info(`company-os delivered notice reminder ${dispatch.id} to agent:${dispatch.targetAgentId}:main`);
        } else {
          this.store.failNoticeReminderDispatch(dispatch.id, result.error);
          this.logger.error(`company-os notice reminder ${dispatch.id} failed for agent:${dispatch.targetAgentId}:main: ${result.error}`);
        }
      } catch (error) {
        if (this.store.noticeReminderDispatchHasReadProgress(dispatch.id)) {
          this.store.completeNoticeReminderDispatch(dispatch.id);
          this.logger.warn(`company-os accepted notice reminder ${dispatch.id} after a verified notice read despite invocation error: ${formatError(error)}`);
        } else {
          this.store.failNoticeReminderDispatch(dispatch.id, formatError(error));
          this.logger.error(`company-os notice reminder ${dispatch.id} crashed: ${formatError(error)}`);
        }
      }
    }
  }

  private dispatchDailyAgentRun(kind: DailyAgentKind, scheduledAt: string | number | Date) {
    const run = this.store.queueDailyAgentRun(kind, scheduledAt);
    this.logger.info(`company-os queued ${dailyAgentLabel(kind)} run ${run.id} for ${run.planned} agents at ${run.scheduledAt}`);
    this.kickDailyAgentDispatches();
    return run;
  }

  private scheduleNextDailySelfImprovementRun() {
    if (this.dailySelfImprovementRunTimer) clearTimeout(this.dailySelfImprovementRunTimer);
    this.dailySelfImprovementRunTimer = undefined;
    if (this.stopping || !this.config.dailySelfImprovement.enabled) return;
    const scheduledAt = nextDailyAgentRunAt(
      Date.now(),
      this.config.dailySelfImprovement.hour,
      this.config.dailySelfImprovement.minute,
    );
    const delay = Math.max(0, Date.parse(scheduledAt) - Date.now());
    this.dailySelfImprovementRunTimer = setTimeout(() => {
      this.dailySelfImprovementRunTimer = undefined;
      try {
        this.dispatchDailySelfImprovementRun(scheduledAt);
      } catch (error) {
        this.logger.error(`company-os daily self-improvement run ${scheduledAt} failed: ${formatError(error)}`);
      } finally {
        this.scheduleNextDailySelfImprovementRun();
      }
    }, delay);
    this.dailySelfImprovementRunTimer.unref();
    this.logger.info(`company-os scheduled daily self-improvement run at ${scheduledAt} (Asia/Shanghai)`);
  }

  private scheduleNextDailyPersonaAuditRun() {
    if (this.dailyPersonaAuditRunTimer) clearTimeout(this.dailyPersonaAuditRunTimer);
    this.dailyPersonaAuditRunTimer = undefined;
    if (this.stopping || !this.config.dailyPersonaAudit.enabled) return;
    const scheduledAt = nextDailyAgentRunAt(
      Date.now(),
      this.config.dailyPersonaAudit.hour,
      this.config.dailyPersonaAudit.minute,
    );
    const delay = Math.max(0, Date.parse(scheduledAt) - Date.now());
    this.dailyPersonaAuditRunTimer = setTimeout(() => {
      this.dailyPersonaAuditRunTimer = undefined;
      try {
        this.dispatchDailyPersonaAuditRun(scheduledAt);
      } catch (error) {
        this.logger.error(`company-os daily persona-audit run ${scheduledAt} failed: ${formatError(error)}`);
      } finally {
        this.scheduleNextDailyPersonaAuditRun();
      }
    }, delay);
    this.dailyPersonaAuditRunTimer.unref();
    this.logger.info(`company-os scheduled daily persona-audit run at ${scheduledAt} (Asia/Shanghai)`);
  }

  private scheduleNextDailyAgentDispatch() {
    if (this.dailyAgentDispatchTimer) clearTimeout(this.dailyAgentDispatchTimer);
    this.dailyAgentDispatchTimer = undefined;
    if (this.stopping) return;
    const scheduledAt = this.store.nextPendingDailyAgentDispatchAt(this.activeDailyAgentIds);
    if (!scheduledAt) return;
    const delay = Math.max(0, Date.parse(scheduledAt) - Date.now());
    this.dailyAgentDispatchTimer = setTimeout(() => {
      this.dailyAgentDispatchTimer = undefined;
      this.kickDailyAgentDispatches();
    }, delay);
    this.dailyAgentDispatchTimer.unref();
  }

  private kickDailyAgentDispatches() {
    if (this.stopping) return;
    if (this.dailyAgentDispatchTimer) clearTimeout(this.dailyAgentDispatchTimer);
    this.dailyAgentDispatchTimer = undefined;
    while (!this.stopping) {
      const dispatch = this.store.claimNextDailyAgentDispatch(Date.now(), this.activeDailyAgentIds);
      if (!dispatch) break;
      this.activeDailyAgentIds.add(dispatch.targetMemberId);
      let delivery!: Promise<void>;
      delivery = this.deliverDailyAgentDispatch(dispatch)
        .catch((error) => {
          this.store.failDailyAgentDispatch(dispatch.id, formatError(error));
          this.logger.error(`company-os ${dailyAgentLabel(dispatch.kind)} dispatch ${dispatch.id} crashed: ${formatError(error)}`);
        })
        .finally(() => {
          this.activeDailyAgentIds.delete(dispatch.targetMemberId);
          this.activeDailyAgentDeliveries.delete(delivery);
          if (!this.stopping) this.kickDailyAgentDispatches();
        });
      this.activeDailyAgentDeliveries.add(delivery);
    }
    this.scheduleNextDailyAgentDispatch();
  }

  private async deliverDailyAgentDispatch(dispatch: DailyAgentDispatch) {
    const result = await this.agentInvoker.invoke({
      agentId: dispatch.targetAgentId,
      sessionKey: dispatch.sessionKey,
      prompt: dispatch.prompt,
      timeoutSeconds: this.config.participantTurnTimeoutSeconds,
      maxInFlightRetries: 0,
      signal: this.lifecycleAbort.signal,
    });
    if (result.ok || (result.code === "empty_reply" && result.completed)) {
      this.store.completeDailyAgentDispatch(dispatch.id);
      if (!result.ok) {
        this.logger.warn(`company-os accepted ${dailyAgentLabel(dispatch.kind)} dispatch ${dispatch.id} after a completed empty Agent turn: ${result.error}`);
      }
      this.logger.info(`company-os delivered ${dailyAgentLabel(dispatch.kind)} dispatch ${dispatch.id} to ${dispatch.sessionKey}`);
      return;
    }
    this.store.failDailyAgentDispatch(dispatch.id, result.error);
    this.logger.error(`company-os ${dailyAgentLabel(dispatch.kind)} dispatch ${dispatch.id} failed for ${dispatch.sessionKey}: ${result.error}`);
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
      for (const notification of this.store.pendingTaskReviewEmailNotifications()) {
        try {
          await this.meetingEmailSender.send(notification);
          this.store.markTaskReviewEmailSent(notification.id);
          this.logger.info(`company-os sent Boss task review email for ${notification.taskId} submission ${notification.submissionId}`);
        } catch (error) {
          const message = formatError(error);
          this.store.markTaskReviewEmailFailed(notification.id, message);
          this.logger.error(`company-os failed to send Boss task review email for ${notification.taskId}: ${message}`);
        }
      }
      for (const notification of this.store.pendingBossTaskActionEmailNotifications()) {
        try {
          await this.meetingEmailSender.send(notification);
          this.store.markBossTaskActionEmailSent(notification.id);
          this.logger.info(`company-os sent Boss task action email ${notification.kind} for ${notification.taskId}`);
        } catch (error) {
          const message = formatError(error);
          this.store.markBossTaskActionEmailFailed(notification.id, message);
          this.logger.error(`company-os failed to send Boss task action email ${notification.kind} for ${notification.taskId}: ${message}`);
        }
      }
    })();
    try {
      await this.emailFlush;
    } finally {
      this.emailFlush = undefined;
    }
  }

  private kickSubmissionMaterialDeliveries() {
    void this.flushSubmissionMaterialDeliveries().catch((error) => {
      this.logger.error(`company-os review material delivery flush failed: ${formatError(error)}`);
    });
  }

  private async flushSubmissionMaterialDeliveries(): Promise<void> {
    if (this.submissionMaterialFlush) {
      await this.submissionMaterialFlush;
      return;
    }
    if (this.submissionMaterialRetryTimer) {
      clearTimeout(this.submissionMaterialRetryTimer);
      this.submissionMaterialRetryTimer = undefined;
    }
    this.submissionMaterialFlush = (async () => {
      while (!this.stopping) {
        const delivery = this.store.claimNextWorkspaceMaterialDelivery();
        if (!delivery) return;
        try {
          const workspace = resolveAgentWorkspace(this.runtimeConfig, delivery.reviewerId);
          const targetPath = materializeWorkspaceReviewMaterial(workspace, delivery);
          this.store.completeWorkspaceMaterialDelivery(delivery.id, targetPath);
          this.logger.info(`company-os delivered review material ${delivery.submissionId} to ${targetPath}`);
        } catch (error) {
          const message = formatError(error);
          this.store.failWorkspaceMaterialDelivery(delivery.id, message);
          this.logger.error(`company-os failed review material delivery ${delivery.submissionId}: ${message}`);
        }
      }
    })();
    try {
      await this.submissionMaterialFlush;
    } finally {
      this.submissionMaterialFlush = undefined;
      this.scheduleNextSubmissionMaterialDelivery();
    }
  }

  private scheduleNextSubmissionMaterialDelivery() {
    if (this.stopping || this.submissionMaterialRetryTimer) return;
    const dueAt = this.store.nextWorkspaceMaterialDeliveryAt();
    if (!dueAt) return;
    const delay = Math.max(0, Date.parse(dueAt) - Date.now());
    this.submissionMaterialRetryTimer = setTimeout(() => {
      this.submissionMaterialRetryTimer = undefined;
      this.kickSubmissionMaterialDeliveries();
    }, Math.min(delay, 2_147_000_000));
    this.submissionMaterialRetryTimer.unref();
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function definitelyUndelivered(code: string) {
  return code === "launch_failed" || code === "in_flight";
}

function invocationConfirmedStarted(result: Awaited<ReturnType<AgentInvoker["invoke"]>>) {
  if (result.ok) return true;
  return result.code !== "launch_failed" && result.code !== "in_flight" && result.code !== "aborted";
}

function shortWait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    timer.unref();
    const abort = () => {
      clearTimeout(timer);
      done();
    };
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function dailyAgentLabel(kind: DailyAgentKind) {
  return kind === "daily_self_improvement" ? "daily self-improvement" : "daily persona-audit";
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
