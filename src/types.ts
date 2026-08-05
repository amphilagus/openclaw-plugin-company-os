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
  taskStaleAfterHours?: number;
  databasePath?: string;
};

export type ResolvedCompanyOsConfig = {
  participantTurnTimeoutSeconds: number;
  hostIdleTimeoutSeconds: number;
  taskStaleAfterHours: number;
  databasePath?: string;
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

export type ScheduleMeetingTurn = {
  meetingId: string;
  agentId: string;
  prompt: string;
  turnId?: string;
  tag: string;
};

export type MeetingAdvance = {
  schedule?: ScheduleMeetingTurn;
  activatedMeetingId?: string;
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
  return {
    participantTurnTimeoutSeconds: clampInteger(config?.participantTurnTimeoutSeconds, 600, 60),
    hostIdleTimeoutSeconds: clampInteger(config?.hostIdleTimeoutSeconds, 1800, 60),
    taskStaleAfterHours: clampInteger(config?.taskStaleAfterHours, 72, 1),
    ...(config?.databasePath?.trim() ? { databasePath: config.databasePath.trim() } : {}),
  };
}

function clampInteger(value: number | undefined, fallback: number, minimum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value as number));
}
