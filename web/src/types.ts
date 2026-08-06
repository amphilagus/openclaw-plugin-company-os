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

export type TaskAgentDispatch = {
  id: string;
  targetMemberId: string;
  targetAgentId: string;
  kind: "boss_reminder" | "review_accepted" | "review_rejected";
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
  taskDrafts: Array<{ id: string; position: number; title: string; description: string; acceptanceCriteria: string; assigneeId: string }>;
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
  reminderDispatch: TaskAgentDispatch | null;
  reviewNotificationDispatch: TaskAgentDispatch | null;
  audit: Array<{ id: number; actorId: string; action: string; reason: string | null; createdAt: string }>;
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

export type Snapshot = {
  organization: Member[];
  tasks: Task[];
  notices: Notice[];
  meetings: { active: MeetingSummary | null; closing: MeetingSummary | null; queue: MeetingSummary[]; history: MeetingSummary[] };
  taskHourlyCheckin: TaskHourlyCheckinSummary;
  noticeUnreadReminder: NoticeUnreadReminderSummary;
  generatedAt: string;
};
