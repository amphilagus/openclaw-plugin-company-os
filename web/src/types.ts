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
  status: "assigned" | "in_progress" | "review" | "blocked" | "closed" | "canceled";
  revision: number;
  blockedReason: string | null;
  reviewFeedback: string | null;
  childIds: string[];
  childCounts: { total: number; active: number; closed: number; canceled: number };
  risks: { blockedDescendants: number; staleDescendants: number; stale: boolean };
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  sourceMeetingId?: string | null;
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
  queuePosition: number;
  participantCount: number;
  currentTurnId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  canceledReason: string | null;
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
  taskDrafts: Array<{ id: string; position: number; title: string; description: string; acceptanceCriteria: string; assigneeId: string }>;
  currentTurn: { speakerId: string; prompt: string; startedAt: string } | null;
};

export type TaskDetail = Task & {
  versions: Array<{ revision: number; changedBy: string; reason: string; createdAt: string }>;
  progress: Array<{ id: string; authorId: string; body: string; createdAt: string }>;
  submissions: Array<{
    id: string;
    summary: string;
    evidence: Array<{ type: string; label: string; note?: string; command?: string; url?: string; path?: string }>;
    status: string;
    feedback?: string | null;
    createdAt: string;
  }>;
  audit: Array<{ id: number; actorId: string; action: string; reason: string | null; createdAt: string }>;
};

export type Snapshot = {
  organization: Member[];
  tasks: Task[];
  notices: Notice[];
  meetings: { active: MeetingSummary | null; queue: MeetingSummary[]; history: MeetingSummary[] };
  generatedAt: string;
};
