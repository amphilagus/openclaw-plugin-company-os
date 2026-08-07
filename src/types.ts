export const TASK_STATUSES = [
  "assigned",
  "in_progress",
  "review",
  "blocked",
  "closed",
  "canceled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskAgentDispatchKind =
  | "boss_reminder"
  | "review_accepted"
  | "review_rejected"
  | "block_escalated"
  | "block_guidance"
  | "cancel_request_accepted"
  | "cancel_request_rejected"
  | "acceptance_revoked"
  | "cancellation_restored"
  | "submission_git_required";
export type TaskCheckinActionKind = "review" | "execute" | "boss_digest";
export type TaskCheckinChannel = "agent" | "boss_email";
export type TaskCheckinDispatchStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "canceled";
export type NoticeReminderDispatchStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "canceled";
export type DailyAgentKind = "daily_self_improvement" | "daily_persona_audit";
export type DailyAgentDispatchStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";
export type TaskPromptPoolItemKind = "execution" | "review" | "blocked_review";
export type TaskPromptDispatchStatus = "running" | "succeeded" | "failed" | "skipped_busy" | "skipped_empty" | "skipped_offline" | "canceled";
export type TaskFlowStageStatus = "waiting" | "active" | "suspended" | "completed" | "retired";
export type TaskAvailability = "active" | "waiting_stage" | "suspended_stage" | "retired";
export type MeetingType = "task" | "discussion";
export type MeetingStatus = "queued" | "active" | "completed" | "canceled" | "timed_out";
export type MeetingCloseoutOutcome = "completed" | "canceled" | "timed_out";
export type ParticipantRole = "worker" | "advisor";
export type Actor = "boss" | string;

export type CompanyOsConfig = {
  participantTurnTimeoutSeconds?: number;
  hostIdleTimeoutSeconds?: number;
  meetingAutoEndDelaySeconds?: number;
  taskStaleAfterHours?: number;
  taskHourlyCheckins?: {
    enabled?: boolean;
    startHour?: number;
    endHour?: number;
  };
  taskRollingPrompts?: {
    enabled?: boolean;
    startHour?: number;
    endHour?: number;
    intervalMinutes?: number;
  };
  noticeUnreadReminders?: {
    enabled?: boolean;
    startHour?: number;
    endHour?: number;
  };
  dailySelfImprovement?: {
    enabled?: boolean;
    hour?: number;
    minute?: number;
  };
  dailyPersonaAudit?: {
    enabled?: boolean;
    hour?: number;
    minute?: number;
  };
  databasePath?: string;
  organizationAdminAgentId?: string;
  bossAvatarPath?: string;
  bossEmailNotifications?: {
    enabled?: boolean;
    account?: string;
    recipient?: string;
    configPath?: string;
  };
};

export type ResolvedCompanyOsConfig = {
  participantTurnTimeoutSeconds: number;
  hostIdleTimeoutSeconds: number;
  meetingAutoEndDelaySeconds: number;
  taskStaleAfterHours: number;
  taskHourlyCheckins: {
    enabled: boolean;
    startHour: number;
    endHour: number;
    timeZone: "Asia/Shanghai";
  };
  taskRollingPrompts: {
    enabled: boolean;
    startHour: number;
    endHour: number;
    timeZone: "Asia/Shanghai";
  };
  noticeUnreadReminders: {
    enabled: boolean;
    startHour: number;
    endHour: number;
    timeZone: "Asia/Shanghai";
  };
  dailySelfImprovement: {
    enabled: boolean;
    hour: number;
    minute: number;
    timeZone: "Asia/Shanghai";
  };
  dailyPersonaAudit: {
    enabled: boolean;
    hour: number;
    minute: number;
    timeZone: "Asia/Shanghai";
  };
  databasePath?: string;
  organizationAdminAgentId?: string;
  bossAvatarPath: string;
  bossEmailNotifications: {
    enabled: boolean;
    account?: string;
    recipient?: string;
    configPath?: string;
  };
};

export type EvidenceInput = {
  type: "proof" | "artifact";
  label: string;
  note?: string;
  command?: string;
  url?: string;
  path?: string;
};

export type GitLocationInput = {
  remoteUrl: string;
  branch: string;
  commit: string;
};

export type VerifiedGitLocation = GitLocationInput & {
  verifiedAt: string;
};

export type TaskReviewCheck = {
  criterion: string;
  outcome: "pass" | "fail";
  evidenceIndexes: number[];
  finding: string;
  remediation?: string;
};

export type TaskReviewReport = {
  checks: TaskReviewCheck[];
  conclusion: string;
};

export type TaskCancelRequest = {
  id: string;
  taskId: string;
  requesterId: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "canceled";
  reviewerId: string | null;
  feedback: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export type TaskCancellationEvent = {
  id: string;
  taskId: string;
  actorId: string;
  requestId: string | null;
  statusBefore: TaskStatus;
  reason: string;
  canceledAt: string;
  restoredBy: string | null;
  restoredAt: string | null;
};

export type TaskCorrectionAction = "revoke_acceptance" | "restore_cancellation";

export type TaskCorrection = {
  id: string;
  taskId: string;
  actorId: string;
  action: TaskCorrectionAction;
  reason: string;
  reviewReport: TaskReviewReport | null;
  createdAt: string;
  impacts: Array<{
    taskId: string;
    statusBefore: TaskStatus;
    statusAfter: TaskStatus;
    invalidatedSubmissionId: string | null;
  }>;
};

export type TaskFlowTaskInput = {
  title: string;
  description: string;
  acceptanceCriteria: string;
  assigneeId: string;
};

export type TaskFlowStageInput = {
  name: string;
  objective: string;
  tasks: TaskFlowTaskInput[];
};

export type TaskFlowStage = {
  id: string;
  position: number;
  name: string;
  objective: string;
  status: TaskFlowStageStatus;
  taskIds: string[];
  requiredTaskCount: number;
  closedTaskCount: number;
  createdAt: string;
  activatedAt: string | null;
  completedAt: string | null;
  suspendedAt: string | null;
  retiredAt: string | null;
};

export type TaskFlow = {
  id: string;
  parentTaskId: string;
  revision: number;
  stages: TaskFlowStage[];
  createdAt: string;
  updatedAt: string;
};

export type TaskMeetingRequirement = {
  status: "required" | "scheduled" | "active" | "fulfilled";
  meetingId: string | null;
  requiredAt: string;
  fulfilledAt: string | null;
};

export type MeetingParticipantInput = {
  agentId: string;
  role: ParticipantRole;
};

export type MeetingAdvance = {
  hostDispatchId?: string;
  activatedMeetingId?: string;
};

export type MeetingContextEnvelope = {
  meetingId: string;
  memberId: string;
  fromSequence: number;
  toSequence: number;
  prompt: string;
};

export type MeetingTurnDispatch = MeetingContextEnvelope & {
  turnId: string;
  speakerId: string;
  agentId: string;
  messageId?: string;
  messageSequence?: number;
  roundNumber?: number;
  contextAppendId?: string;
};

export type MeetingToolSessionIdentity = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  toolCallId: string;
};

export type MeetingSessionContextAppend = {
  id: string;
  meetingId: string;
  memberId: string;
  runtimeAgentId: string;
  sessionKey: string;
  sessionId: string;
  toolName: "company_meeting_speak" | "company_meeting_delegate";
  toolCallId: string;
  messageId: string;
  messageSequence: number;
  turnId: string | null;
  roundNumber: number | null;
  recordKind: "speech" | "delegate" | "host_speech";
  targetId: string | null;
  targetName: string | null;
  memberName: string;
  body: string;
  formattedText: string;
  status: "pending" | "appending" | "appended" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  appendedAt: string | null;
};

export type MeetingCloseoutDispatch = {
  id: string;
  meetingId: string;
  memberId: string;
  memberName: string;
  runtimeAgentId: string;
  outcome: MeetingCloseoutOutcome;
  blocksRoom: boolean;
  position: number;
  contextFromSequence: number;
  contextToSequence: number;
  prompt: string;
  status: "pending" | "running" | "succeeded";
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type TaskCheckinDispatch = {
  id: string;
  runId: string;
  batchId: string;
  targetMemberId: string;
  targetAgentId: string | null;
  channel: TaskCheckinChannel;
  slotIndex: number;
  scheduledAt: string;
  taskId: string | null;
  actionKind: TaskCheckinActionKind | null;
  prompt: string | null;
  status: TaskCheckinDispatchStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type TaskPromptPoolItem = {
  id: string;
  memberId: string;
  targetAgentId: string;
  taskId: string;
  parentTaskId: string | null;
  kind: TaskPromptPoolItemKind;
  position: number;
  enqueuedAt: string;
  updatedAt: string;
  lastPromptedAt: string | null;
  promptCount: number;
};

export type TaskPromptDispatch = {
  id: string;
  cycleId: string;
  poolItemId: string | null;
  targetMemberId: string;
  targetAgentId: string;
  taskId: string | null;
  kind: TaskPromptPoolItemKind | null;
  scheduledAt: string;
  prompt: string | null;
  status: TaskPromptDispatchStatus;
  started: boolean;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type TaskPromptPoolSummary = {
  enabled: boolean;
  timeZone: "Asia/Shanghai";
  startHour: number;
  endHour: number;
  nextDueAt: string | null;
  totals: {
    employees: number;
    items: number;
    execution: number;
    review: number;
    blockedReview: number;
  };
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
    head: null | {
      taskId: string;
      parentTaskId: string | null;
      title: string;
      parentTitle: string | null;
      kind: TaskPromptPoolItemKind;
      enqueuedAt: string;
      lastPromptedAt: string | null;
      promptCount: number;
    };
    items: Array<{
      taskId: string;
      parentTaskId: string | null;
      title: string;
      parentTitle: string | null;
      kind: TaskPromptPoolItemKind;
      enqueuedAt: string;
      lastPromptedAt: string | null;
      promptCount: number;
    }>;
    lastDispatch: null | {
      status: TaskPromptDispatchStatus;
      taskId: string | null;
      kind: TaskPromptPoolItemKind | null;
      scheduledAt: string;
      completedAt: string | null;
      lastError: string | null;
    };
  }>;
};

export type NoticeReminderCandidate = {
  noticeId: string;
  kind: "manual" | "meeting_report" | "correction";
  title: string;
  createdAt: string;
};

export type NoticeReminderDispatch = {
  id: string;
  runId: string;
  targetMemberId: string;
  targetAgentId: string;
  scheduledAt: string;
  candidates: NoticeReminderCandidate[];
  candidateCount: number;
  prompt: string | null;
  status: NoticeReminderDispatchStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type DailyAgentDispatch = {
  id: string;
  runId: string;
  kind: DailyAgentKind;
  targetMemberId: string;
  targetAgentId: string;
  position: number;
  scheduledAt: string;
  sessionKey: string;
  prompt: string;
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
  dispatches: Omit<DailyAgentDispatch, "prompt">[];
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

export type MeetingTurnDelivery = {
  turnId: string;
  speakerId: string;
  status: "completed" | "failed";
  body: string | null;
  completionSource: "tool" | "fallback" | null;
  error: string | null;
  contextFromSequence: number;
  contextToSequence: number;
};

export type ServiceEvent = {
  id: number;
  type: string;
  entityType: string;
  entityId: string;
  at: string;
};

export type HttpMutationActor = {
  kind: "boss";
  id: "boss";
};

export function resolveConfig(config: CompanyOsConfig | undefined): ResolvedCompanyOsConfig {
  const email = config?.bossEmailNotifications;
  const taskCheckins = config?.taskHourlyCheckins;
  const taskRollingPrompts = config?.taskRollingPrompts;
  const noticeReminders = config?.noticeUnreadReminders;
  const dailySelfImprovement = config?.dailySelfImprovement;
  const dailyPersonaAudit = config?.dailyPersonaAudit;
  const taskCheckinStartHour = boundedInteger(taskCheckins?.startHour, 8, 0, 23);
  const taskCheckinEndHour = boundedInteger(taskCheckins?.endHour, 17, 0, 23);
  const taskPromptStartHour = boundedInteger(taskRollingPrompts?.startHour ?? taskCheckins?.startHour, 8, 0, 23);
  const taskPromptEndHour = boundedInteger(taskRollingPrompts?.endHour ?? taskCheckins?.endHour, 17, 0, 23);
  const noticeReminderStartHour = boundedInteger(noticeReminders?.startHour, 8, 0, 23);
  const noticeReminderEndHour = boundedInteger(noticeReminders?.endHour, 17, 0, 23);
  if (taskCheckinStartHour > taskCheckinEndHour) {
    throw new Error("taskHourlyCheckins.startHour must not be later than endHour");
  }
  if (taskPromptStartHour > taskPromptEndHour) {
    throw new Error("taskRollingPrompts.startHour must not be later than endHour");
  }
  if (noticeReminderStartHour > noticeReminderEndHour) {
    throw new Error("noticeUnreadReminders.startHour must not be later than endHour");
  }
  return {
    participantTurnTimeoutSeconds: clampInteger(config?.participantTurnTimeoutSeconds, 600, 60),
    hostIdleTimeoutSeconds: clampInteger(config?.hostIdleTimeoutSeconds, 1800, 60),
    meetingAutoEndDelaySeconds: clampInteger(config?.meetingAutoEndDelaySeconds, 60, 1),
    taskStaleAfterHours: clampInteger(config?.taskStaleAfterHours, 72, 1),
    taskHourlyCheckins: {
      enabled: taskCheckins?.enabled !== false,
      startHour: taskCheckinStartHour,
      endHour: taskCheckinEndHour,
      timeZone: "Asia/Shanghai",
    },
    taskRollingPrompts: {
      enabled: taskRollingPrompts?.enabled ?? taskCheckins?.enabled ?? true,
      startHour: taskPromptStartHour,
      endHour: taskPromptEndHour,
      timeZone: "Asia/Shanghai",
    },
    noticeUnreadReminders: {
      enabled: noticeReminders?.enabled !== false,
      startHour: noticeReminderStartHour,
      endHour: noticeReminderEndHour,
      timeZone: "Asia/Shanghai",
    },
    dailySelfImprovement: {
      enabled: dailySelfImprovement?.enabled !== false,
      hour: boundedInteger(dailySelfImprovement?.hour, 5, 0, 23),
      minute: boundedInteger(dailySelfImprovement?.minute, 0, 0, 59),
      timeZone: "Asia/Shanghai",
    },
    dailyPersonaAudit: {
      enabled: dailyPersonaAudit?.enabled !== false,
      hour: boundedInteger(dailyPersonaAudit?.hour, 6, 0, 23),
      minute: boundedInteger(dailyPersonaAudit?.minute, 0, 0, 59),
      timeZone: "Asia/Shanghai",
    },
    ...(config?.databasePath?.trim() ? { databasePath: config.databasePath.trim() } : {}),
    ...(config?.organizationAdminAgentId?.trim() ? { organizationAdminAgentId: config.organizationAdminAgentId.trim() } : {}),
    bossAvatarPath: config?.bossAvatarPath?.trim() || "~/.openclaw/workspace-boss/avatar.png",
    bossEmailNotifications: {
      enabled: email?.enabled !== false,
      ...(email?.account?.trim() ? { account: email.account.trim() } : {}),
      ...(email?.recipient?.trim() ? { recipient: email.recipient.trim() } : {}),
      ...(email?.configPath?.trim() ? { configPath: email.configPath.trim() } : {}),
    },
  };
}

function clampInteger(value: number | undefined, fallback: number, minimum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value as number));
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value as number)));
}
