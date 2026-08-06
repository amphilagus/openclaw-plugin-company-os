export const TASK_STATUSES = [
  "assigned",
  "in_progress",
  "review",
  "blocked",
  "closed",
  "canceled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskAgentDispatchKind = "boss_reminder" | "review_accepted" | "review_rejected";
export type TaskCheckinActionKind = "review" | "execute" | "boss_digest";
export type TaskCheckinChannel = "agent" | "boss_email";
export type TaskCheckinDispatchStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "canceled";
export type NoticeReminderDispatchStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "canceled";
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
  noticeUnreadReminders?: {
    enabled?: boolean;
    startHour?: number;
    endHour?: number;
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
  noticeUnreadReminders: {
    enabled: boolean;
    startHour: number;
    endHour: number;
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

export type TaskDraftInput = {
  title: string;
  description: string;
  acceptanceCriteria: string;
  assigneeId: string;
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
  const noticeReminders = config?.noticeUnreadReminders;
  const taskCheckinStartHour = boundedInteger(taskCheckins?.startHour, 8, 0, 23);
  const taskCheckinEndHour = boundedInteger(taskCheckins?.endHour, 17, 0, 23);
  const noticeReminderStartHour = boundedInteger(noticeReminders?.startHour, 8, 0, 23);
  const noticeReminderEndHour = boundedInteger(noticeReminders?.endHour, 17, 0, 23);
  if (taskCheckinStartHour > taskCheckinEndHour) {
    throw new Error("taskHourlyCheckins.startHour must not be later than endHour");
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
    noticeUnreadReminders: {
      enabled: noticeReminders?.enabled !== false,
      startHour: noticeReminderStartHour,
      endHour: noticeReminderEndHour,
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
