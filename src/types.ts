export const TASK_STATUSES = [
  "assigned",
  "in_progress",
  "review",
  "blocked",
  "closed",
  "canceled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type MeetingType = "task" | "discussion";
export type MeetingStatus = "queued" | "active" | "completed" | "canceled" | "timed_out";
export type ParticipantRole = "worker" | "advisor";
export type Actor = "boss" | string;

export type CompanyOsConfig = {
  participantTurnTimeoutSeconds?: number;
  hostIdleTimeoutSeconds?: number;
  meetingAutoEndDelaySeconds?: number;
  taskStaleAfterHours?: number;
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
  return {
    participantTurnTimeoutSeconds: clampInteger(config?.participantTurnTimeoutSeconds, 600, 60),
    hostIdleTimeoutSeconds: clampInteger(config?.hostIdleTimeoutSeconds, 1800, 60),
    meetingAutoEndDelaySeconds: clampInteger(config?.meetingAutoEndDelaySeconds, 60, 1),
    taskStaleAfterHours: clampInteger(config?.taskStaleAfterHours, 72, 1),
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
