export type Member = {
  id: string;
  agentId: string | null;
  kind: "boss" | "agent";
  name: string;
  title: string;
  managerId: string | null;
  level: number;
  active: boolean;
};

export type MemberIdentity = {
  id: string;
  name: string;
  title: string;
  emoji: string | null;
  avatarUrl: string | null;
};

export type Task = {
  id: string;
  parentId: string | null;
  issuerId: string;
  assigneeId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: "assigned" | "in_progress" | "review" | "blocked" | "closed" | "canceled" | "aborted";
  revision: number;
  blockedReason: string | null;
  blockedAt: string | null;
  reviewFeedback: string | null;
  childIds: string[];
  childCounts: { total: number; active: number; closed: number; canceled: number };
  risks: { blockedDescendants: number; staleDescendants: number; stale: boolean };
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  abortedAt: string | null;
  abortedReason: string | null;
  sourceMeetingId?: string | null;
  availability: "active" | "waiting_stage" | "suspended_stage" | "retired";
  flowStage: null | {
    flowId: string;
    stageId: string;
    position: number;
    name: string;
    objective: string;
    status: "waiting" | "active" | "suspended" | "completed" | "retired";
  };
};

export type TaskAbortDraft = {
  sourceTaskId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  assigneeId: string;
  requireTaskMeeting: boolean;
};

export type TaskAgentDispatch = {
  id: string;
  targetMemberId: string;
  targetAgentId: string;
  kind: "boss_reminder" | "review_accepted" | "review_rejected" | "block_escalated" | "block_guidance" | "cancel_request_accepted" | "cancel_request_rejected" | "acceptance_revoked" | "cancellation_restored" | "submission_git_required";
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type Notice = {
  id: string;
  authorId: string;
  kind: "manual" | "meeting_report" | "correction";
  title: string;
  body: string;
  sourceMeetingId: string | null;
  supersedesNoticeId: string | null;
  supersededById: string | null;
  effective: boolean;
  activeEmployeeCount: number;
  readCount: number;
  createdAt: string;
};

export type MeetingCloseoutStatus = {
  state: "syncing" | "delivered";
  blocksRoom: boolean;
  total: number;
  delivered: number;
  pending: number;
  currentMemberId: string | null;
  currentMemberName: string | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
};

export type MeetingSummary = {
  id: string;
  type: "task" | "discussion";
  status: "queued" | "active" | "completed" | "canceled" | "timed_out";
  title: string;
  agenda: string;
  hostId: string;
  requestedBy: string;
  parentTaskId: string | null;
  summary: string | null;
  bossParticipates: boolean;
  bossStartedAt: string | null;
  awaitingBossStart: boolean;
  endRequestedAt: string | null;
  endRequestedSummary: string | null;
  endRequestedPublishNotice: boolean;
  autoEndAt: string | null;
  queuePosition: number;
  participantCount: number;
  currentTurnId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  canceledReason: string | null;
  closeoutStatus: MeetingCloseoutStatus | null;
};

export type MeetingDetail = MeetingSummary & {
  participants: Array<{ agentId: string; role: "worker" | "advisor"; name: string; title: string }>;
  messages: Array<{
    id: string;
    sequence: number;
    authorKind: "boss" | "member" | "system";
    authorId: string | null;
    targetId: string | null;
    body: string;
    createdAt: string;
  }>;
  taskDraftStages: Array<{
    id: string;
    position: number;
    name: string;
    objective: string;
    tasks: Array<{ id: string; position: number; title: string; description: string; acceptanceCriteria: string; assigneeId: string }>;
  }>;
  currentTurn: { speakerId: string; prompt: string; startedAt: string } | null;
  hostDispatchStatus: {
    id: string;
    status: "pending" | "running" | "succeeded" | "failed" | "canceled";
    attempts: number;
    lastError: string | null;
    reason: string;
  } | null;
  closeoutDispatches: Array<{
    id: string;
    memberId: string;
    memberName: string;
    runtimeAgentId: string;
    outcome: "completed" | "canceled" | "timed_out";
    blocksRoom: boolean;
    position: number;
    contextFromSequence: number;
    contextToSequence: number;
    status: "pending" | "running" | "succeeded";
    attempts: number;
    lastError: string | null;
    nextAttemptAt: string;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  }>;
};

export type TaskDetail = Task & {
  childFlow: null | {
    id: string;
    parentTaskId: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    stages: Array<{
      id: string;
      position: number;
      name: string;
      objective: string;
      status: "waiting" | "active" | "suspended" | "completed" | "retired";
      taskIds: string[];
      requiredTaskCount: number;
      closedTaskCount: number;
      createdAt: string;
      activatedAt: string | null;
      completedAt: string | null;
      suspendedAt: string | null;
      retiredAt: string | null;
    }>;
  };
  taskMeetingRequirement: null | {
    status: "required" | "scheduled" | "active" | "fulfilled";
    meetingId: string | null;
    requiredAt: string;
    fulfilledAt: string | null;
  };
  versions: Array<{ revision: number; changedBy: string; reason: string; createdAt: string }>;
  progress: Array<{ id: string; authorId: string; body: string; createdAt: string }>;
  submissions: Array<{
    id: string;
    summary: string;
    evidence: Array<{ type: string; label: string; note?: string; command?: string; url?: string; path?: string }>;
    status: string;
    feedback?: string | null;
    reviewReport?: {
      checks: Array<{ criterion: string; outcome: "pass" | "fail"; evidenceIndexes: number[]; finding: string; remediation?: string }>;
      conclusion: string;
    } | null;
    gitLocation: null | { remoteUrl: string; branch: string; commit: string; verifiedAt: string };
    createdAt: string;
  }>;
  reminderDispatch: TaskAgentDispatch | null;
  reviewNotificationDispatch: TaskAgentDispatch | null;
  pendingCancelRequest: null | {
    id: string;
    requesterId: string;
    reason: string;
    status: "pending" | "approved" | "rejected" | "canceled";
    createdAt: string;
  };
  cancellationEvents: Array<{
    id: string;
    actorId: string;
    statusBefore: Task["status"];
    reason: string;
    canceledAt: string;
    restoredBy: string | null;
    restoredAt: string | null;
  }>;
  corrections: Array<{
    id: string;
    actorId: string;
    action: "revoke_acceptance" | "restore_cancellation";
    reason: string;
    createdAt: string;
    impacts: Array<{ taskId: string; statusBefore: Task["status"]; statusAfter: Task["status"]; invalidatedSubmissionId: string | null }>;
  }>;
  audit: Array<{ id: number; actorId: string; action: string; reason: string | null; createdAt: string }>;
};

export type TaskPromptPoolSummary = {
  enabled: boolean;
  timeZone: "Asia/Shanghai";
  startHour: number;
  endHour: number;
  workHoursSource?: "config_default" | "boss_override";
  nextDueAt: string | null;
  totals: { employees: number; items: number; execution: number; review: number; blockedReview: number };
  queues: Array<{
    memberId: string;
    memberName: string;
    level: number;
    defaultIntervalMinutes: number;
    intervalMinutes: number;
    intervalOverrideMinutes: number | null;
    intervalSource: "level_default" | "boss_override";
    nextDueAt: string | null;
    remainingWorkMinutes: number | null;
    count: number;
    head: null | { taskId: string; title: string; parentTitle: string | null; kind: "execution" | "review" | "blocked_review"; enqueuedAt: string; lastPromptedAt: string | null; promptCount: number };
    items: Array<{ taskId: string; parentTaskId: string | null; title: string; parentTitle: string | null; kind: "execution" | "review" | "blocked_review"; enqueuedAt: string; lastPromptedAt: string | null; promptCount: number }>;
    lastDispatch: null | { status: "running" | "succeeded" | "failed" | "skipped_busy" | "skipped_empty" | "skipped_offline" | "canceled"; taskId: string | null; kind: "execution" | "review" | "blocked_review" | null; scheduledAt: string; completedAt: string | null; lastError: string | null };
  }>;
};

export type TaskHourlyCheckinSummary = {
  enabled: boolean;
  timeZone: "Asia/Shanghai";
  startHour: number;
  endHour: number;
  nextRunAt: string | null;
  nextDispatchAt: string | null;
  nextDispatch: {
    scheduledAt: string;
    targetMemberId: string;
    channel: "agent" | "boss_email";
    taskId: string | null;
    title: string;
    actionKind: "review" | "execute" | "boss_digest" | null;
  } | null;
  backlog: number;
  today: {
    localDate: string;
    latestRun: {
      id: string;
      scheduledAt: string;
      candidateEmployees: number;
      plannedReminders: number;
      pending: number;
      running: number;
      delivered: number;
      failed: number;
      skipped: number;
      canceled: number;
    } | null;
  };
  boss: {
    reviewCount: number;
    anomalyCount: number;
    emailStatus: "pending" | "running" | "succeeded" | "failed" | "skipped" | "canceled" | null;
    lastError: string | null;
  };
};

export type NoticeUnreadReminderSummary = {
  enabled: boolean;
  timeZone: "Asia/Shanghai";
  startHour: number;
  endHour: number;
  nextRunAt: string | null;
  backlog: number;
  currentUnreadAgents: number;
  currentUnreadEntries: number;
  today: {
    localDate: string;
    latestRun: {
      id: string;
      scheduledAt: string;
      candidateAgents: number;
      candidateUnreadEntries: number;
      pending: number;
      running: number;
      delivered: number;
      failed: number;
      skipped: number;
      canceled: number;
    } | null;
  };
};

export type DailyAgentKind = "daily_self_improvement" | "daily_persona_audit";
export type DailyAgentDispatchStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";

export type DailyAgentDispatch = {
  id: string;
  runId: string;
  kind: DailyAgentKind;
  targetMemberId: string;
  targetAgentId: string;
  position: number;
  scheduledAt: string;
  sessionKey: string;
  status: DailyAgentDispatchStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type DailyAgentRunSummary = {
  id: string;
  kind: DailyAgentKind;
  localDate: string;
  scheduledAt: string;
  planned: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  canceled: number;
  dispatches: DailyAgentDispatch[];
};

export type DailySelfGovernanceSummary = {
  timeZone: "Asia/Shanghai";
  sessionName: "self-audit";
  backlog: number;
  mechanisms: {
    selfImprovement: {
      enabled: boolean;
      hour: number;
      minute: number;
      nextRunAt: string | null;
      today: DailyAgentRunSummary | null;
    };
    personaAudit: {
      enabled: boolean;
      hour: number;
      minute: number;
      nextRunAt: string | null;
      today: DailyAgentRunSummary | null;
    };
  };
  history: DailyAgentRunSummary[];
};

export type Snapshot = {
  organization: Member[];
  tasks: Task[];
  notices: Notice[];
  meetings: { active: MeetingSummary | null; closing: MeetingSummary | null; queue: MeetingSummary[]; history: MeetingSummary[] };
  taskPromptPool: TaskPromptPoolSummary;
  noticeUnreadReminder: NoticeUnreadReminderSummary;
  dailySelfGovernance: DailySelfGovernanceSummary;
  generatedAt: string;
};
