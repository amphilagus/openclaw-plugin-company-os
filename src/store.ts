import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  Actor,
  EvidenceInput,
  MeetingAdvance,
  MeetingParticipantInput,
  MeetingStatus,
  MeetingType,
  ResolvedCompanyOsConfig,
  ServiceEvent,
  TaskDraftInput,
  TaskStatus,
} from "./types.js";

type Row = Record<string, any>;

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["closed", "canceled"]);
const ACTIVE_TASK_STATUSES = new Set<TaskStatus>(["assigned", "in_progress", "review", "blocked"]);
const OPEN_MEETING_STATUSES = new Set<MeetingStatus>(["queued", "active"]);

export class CompanyOsStore {
  readonly db: DatabaseSync;
  private readonly allowedAgentIds: Set<string>;
  private readonly staleAfterMs: number;
  private readonly onEvent?: (event: ServiceEvent) => void;
  private transactionDepth = 0;
  private pendingEvents: ServiceEvent[] = [];

  constructor(options: {
    databasePath: string;
    allowedAgentIds: Iterable<string>;
    config: ResolvedCompanyOsConfig;
    onEvent?: (event: ServiceEvent) => void;
  }) {
    mkdirSync(path.dirname(options.databasePath), { recursive: true });
    this.db = new DatabaseSync(options.databasePath);
    this.allowedAgentIds = new Set([...options.allowedAgentIds].map((id) => id.trim()).filter(Boolean));
    this.staleAfterMs = options.config.taskStaleAfterHours * 60 * 60 * 1000;
    this.onEvent = options.onEvent;
    this.initializeSchema();
    this.seedOrganization();
  }

  close() {
    this.db.close();
  }

  private initializeSchema() {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const schemaRow = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as Row | undefined;
    const currentVersion = schemaRow ? Number(schemaRow.value) : 0;
    if (!Number.isInteger(currentVersion) || currentVersion < 0) throw new Error("company-os schema version is invalid");
    if (currentVersion > 1) throw new Error(`company-os database schema ${currentVersion} is newer than this plugin supports`);
    if (currentVersion === 1) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        agent_id TEXT UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('boss', 'agent')),
        name TEXT NOT NULL,
        title TEXT NOT NULL,
        manager_id TEXT REFERENCES members(id),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deactivated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        reason TEXT,
        before_json TEXT,
        after_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES tasks(id),
        issuer_id TEXT NOT NULL REFERENCES members(id),
        assignee_id TEXT NOT NULL REFERENCES members(id),
        source_meeting_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('assigned', 'in_progress', 'review', 'blocked', 'closed', 'canceled')),
        revision INTEGER NOT NULL DEFAULT 1,
        blocked_reason TEXT,
        review_feedback TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        started_at TEXT,
        submitted_at TEXT,
        closed_at TEXT,
        canceled_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_versions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, revision)
      );

      CREATE TABLE IF NOT EXISTS task_progress (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL REFERENCES members(id),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_submissions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        submitter_id TEXT NOT NULL REFERENCES members(id),
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
        reviewer_id TEXT,
        feedback TEXT,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_acknowledgements (
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY(member_id, task_id)
      );

      CREATE TABLE IF NOT EXISTS notices (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK (kind IN ('manual', 'meeting_report', 'correction')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source_meeting_id TEXT,
        supersedes_notice_id TEXT REFERENCES notices(id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notice_reads (
        notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        read_at TEXT NOT NULL,
        PRIMARY KEY(notice_id, member_id)
      );

      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('task', 'discussion')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'active', 'completed', 'canceled', 'timed_out')),
        title TEXT NOT NULL,
        agenda TEXT NOT NULL,
        host_id TEXT NOT NULL REFERENCES members(id),
        requested_by TEXT NOT NULL REFERENCES members(id),
        parent_task_id TEXT REFERENCES tasks(id),
        summary TEXT,
        publish_notice INTEGER NOT NULL DEFAULT 0 CHECK (publish_notice IN (0, 1)),
        queue_position INTEGER NOT NULL,
        current_turn_id TEXT,
        waiting_on_host_since TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        canceled_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS meeting_participants (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id),
        role TEXT NOT NULL CHECK (role IN ('worker', 'advisor')),
        PRIMARY KEY(meeting_id, member_id)
      );

      CREATE TABLE IF NOT EXISTS meeting_messages (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        author_kind TEXT NOT NULL CHECK (author_kind IN ('boss', 'member', 'system')),
        author_id TEXT,
        target_id TEXT,
        body TEXT NOT NULL,
        turn_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(meeting_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS meeting_turns (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        speaker_id TEXT NOT NULL REFERENCES members(id),
        requested_by TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('delegate', 'boss')),
        prompt TEXT NOT NULL,
        intervention_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('waiting', 'completed', 'failed')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS meeting_interventions (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        target_id TEXT,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered')),
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );

      CREATE TABLE IF NOT EXISTS meeting_task_drafts (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        assignee_id TEXT NOT NULL REFERENCES members(id),
        UNIQUE(meeting_id, position)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(assignee_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_issuer_status ON tasks(issuer_id, status);
      CREATE INDEX IF NOT EXISTS idx_notices_created ON notices(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meetings_status_queue ON meetings(status, queue_position);
      CREATE INDEX IF NOT EXISTS idx_meeting_messages_sequence ON meeting_messages(meeting_id, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_meeting ON meetings(status) WHERE status = 'active';
      `);
      this.db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private seedOrganization() {
    const now = nowIso();
    this.db.prepare(`
      INSERT OR IGNORE INTO members (id, agent_id, kind, name, title, manager_id, active, created_at, updated_at)
      VALUES ('boss', NULL, 'boss', 'Boss', 'CEO', NULL, 1, ?, ?)
    `).run(now, now);
    if (this.allowedAgentIds.has("main")) {
      this.db.prepare(`
        INSERT OR IGNORE INTO members (id, agent_id, kind, name, title, manager_id, active, created_at, updated_at)
        VALUES ('main', 'main', 'agent', '架构师', '首席架构师', 'boss', 1, ?, ?)
      `).run(now, now);
    }
  }

  transaction<T>(run: () => T): T {
    const outer = this.transactionDepth === 0;
    if (outer) this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const value = run();
      this.transactionDepth -= 1;
      if (outer) {
        this.db.exec("COMMIT");
        const events = this.pendingEvents;
        this.pendingEvents = [];
        events.forEach((event) => this.onEvent?.(event));
      }
      return value;
    } catch (error) {
      this.transactionDepth -= 1;
      if (outer) {
        this.db.exec("ROLLBACK");
        this.pendingEvents = [];
      }
      throw error;
    }
  }

  private audit(params: {
    actorId: Actor;
    action: string;
    entityType: string;
    entityId: string;
    reason?: string;
    before?: unknown;
    after?: unknown;
  }) {
    const createdAt = nowIso();
    const result = this.db.prepare(`
      INSERT INTO audit_events (actor_id, action, entity_type, entity_id, reason, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.actorId,
      params.action,
      params.entityType,
      params.entityId,
      params.reason ?? null,
      toJson(params.before),
      toJson(params.after),
      createdAt,
    );
    const event: ServiceEvent = {
      id: Number(result.lastInsertRowid),
      type: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      at: createdAt,
    };
    if (this.transactionDepth > 0) this.pendingEvents.push(event);
    else this.onEvent?.(event);
  }

  listAudit(entityType?: string, entityId?: string, limit = 200) {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (entityType) {
      clauses.push("entity_type = ?");
      values.push(entityType);
    }
    if (entityId) {
      clauses.push("entity_id = ?");
      values.push(entityId);
    }
    values.push(Math.min(Math.max(limit, 1), 1000));
    const rows = this.db.prepare(`
      SELECT * FROM audit_events
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY id DESC LIMIT ?
    `).all(...values) as Row[];
    return rows.map(mapAudit);
  }

  // ── Organization ──────────────────────────────────

  listMembers(includeInactive = false) {
    const rows = this.db.prepare(`
      SELECT * FROM members ${includeInactive ? "" : "WHERE active = 1"} ORDER BY created_at ASC
    `).all() as Row[];
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    const levelOf = (id: string, visiting = new Set<string>()): number => {
      if (id === "boss") return 0;
      if (visiting.has(id)) return -1;
      visiting.add(id);
      const row = byId.get(id);
      if (!row?.manager_id) return -1;
      const parentLevel = levelOf(row.manager_id, visiting);
      return parentLevel < 0 ? -1 : parentLevel + 1;
    };
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      kind: row.kind,
      name: row.name,
      title: row.title,
      managerId: row.manager_id,
      level: levelOf(row.id),
      active: Boolean(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deactivatedAt: row.deactivated_at,
    }));
  }

  getMember(id: string, options?: { active?: boolean }) {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Row | undefined;
    if (!row || (options?.active !== false && !row.active)) throw new Error(`active company member not found: ${id}`);
    return row;
  }

  requireAgentMember(agentId: string) {
    const row = this.db.prepare("SELECT * FROM members WHERE agent_id = ? AND active = 1").get(agentId) as Row | undefined;
    if (!row) throw new Error(`agent is not an active company member: ${agentId}`);
    return row;
  }

  addMember(actorId: string, input: { agentId: string; name: string; title: string; managerId: string }) {
    requireOrganizationAdmin(actorId);
    const agentId = required(input.agentId, "agentId");
    if (!this.allowedAgentIds.has(agentId)) throw new Error(`OpenClaw agent does not exist: ${agentId}`);
    if (agentId === "boss") throw new Error("boss is a reserved member id");
    this.getMember(input.managerId);
    const now = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO members (id, agent_id, kind, name, title, manager_id, active, created_at, updated_at)
        VALUES (?, ?, 'agent', ?, ?, ?, 1, ?, ?)
      `).run(agentId, agentId, required(input.name, "name"), required(input.title, "title"), input.managerId, now, now);
      this.audit({ actorId, action: "org.member_added", entityType: "member", entityId: agentId, after: input });
    });
    return this.memberView(agentId);
  }

  updateMember(actorId: string, memberId: string, patch: { name?: string; title?: string; managerId?: string }, reason: string) {
    requireOrganizationAdmin(actorId);
    if (memberId === "boss") throw new Error("boss cannot be edited");
    const before = this.getMember(memberId, { active: false });
    if (!before.active) throw new Error("inactive member cannot be edited");
    const nextManagerId = patch.managerId ?? before.manager_id;
    if (patch.managerId && patch.managerId !== before.manager_id) {
      if (this.memberHasOpenWork(memberId)) throw new Error("member manager cannot change while open work exists");
      this.getMember(patch.managerId);
      this.assertNoOrganizationCycle(memberId, patch.managerId);
    }
    const next = {
      name: patch.name === undefined ? before.name : required(patch.name, "name"),
      title: patch.title === undefined ? before.title : required(patch.title, "title"),
      managerId: nextManagerId,
    };
    this.transaction(() => {
      this.db.prepare("UPDATE members SET name = ?, title = ?, manager_id = ?, updated_at = ? WHERE id = ?")
        .run(next.name, next.title, next.managerId, nowIso(), memberId);
      this.audit({ actorId, action: "org.member_updated", entityType: "member", entityId: memberId, reason: required(reason, "reason"), before: mapMember(before), after: next });
    });
    return this.memberView(memberId);
  }

  deactivateMember(actorId: string, memberId: string, reason: string) {
    requireOrganizationAdmin(actorId);
    if (memberId === "boss" || memberId === "main") throw new Error(`${memberId} cannot be deactivated`);
    const before = this.getMember(memberId);
    if (this.memberHasOpenWork(memberId)) throw new Error("member cannot be deactivated while open work exists");
    const activeReports = this.db.prepare("SELECT COUNT(*) AS count FROM members WHERE manager_id = ? AND active = 1").get(memberId) as Row;
    if (Number(activeReports.count) > 0) throw new Error("member cannot be deactivated while active direct reports exist");
    const now = nowIso();
    this.transaction(() => {
      this.db.prepare("UPDATE members SET active = 0, updated_at = ?, deactivated_at = ? WHERE id = ?").run(now, now, memberId);
      this.audit({ actorId, action: "org.member_deactivated", entityType: "member", entityId: memberId, reason: required(reason, "reason"), before: mapMember(before) });
    });
    return this.memberView(memberId, true);
  }

  isDirectReport(managerId: string, memberId: string) {
    const row = this.db.prepare("SELECT 1 AS ok FROM members WHERE id = ? AND manager_id = ? AND active = 1").get(memberId, managerId) as Row | undefined;
    return Boolean(row);
  }

  canPublishNotice(memberId: string) {
    if (memberId === "boss" || memberId === "main") return true;
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM members WHERE manager_id = ? AND active = 1").get(memberId) as Row;
    return Number(row.count) > 0;
  }

  private memberView(memberId: string, includeInactive = false) {
    const member = this.listMembers(includeInactive).find((item) => item.id === memberId);
    if (!member) throw new Error(`member not found: ${memberId}`);
    return member;
  }

  private assertNoOrganizationCycle(memberId: string, managerId: string) {
    let current: string | null = managerId;
    const seen = new Set<string>();
    while (current) {
      if (current === memberId) throw new Error("organization cycle is not allowed");
      if (seen.has(current)) throw new Error("organization is already cyclic");
      seen.add(current);
      const row = this.db.prepare("SELECT manager_id FROM members WHERE id = ?").get(current) as Row | undefined;
      current = row?.manager_id ?? null;
    }
  }

  private memberHasOpenWork(memberId: string) {
    const task = this.db.prepare(`
      SELECT 1 AS found FROM tasks
      WHERE (assignee_id = ? OR issuer_id = ?) AND status IN ('assigned', 'in_progress', 'review', 'blocked') LIMIT 1
    `).get(memberId, memberId);
    if (task) return true;
    const meeting = this.db.prepare(`
      SELECT 1 AS found FROM meetings m
      LEFT JOIN meeting_participants p ON p.meeting_id = m.id
      WHERE m.status IN ('queued', 'active') AND (m.host_id = ? OR p.member_id = ?) LIMIT 1
    `).get(memberId, memberId);
    return Boolean(meeting);
  }

  // ── Tasks ─────────────────────────────────────────

  listTasks(actorId: Actor = "boss") {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all() as Row[];
    const decorated = this.decorateTasks(rows);
    if (actorId === "boss") return decorated;
    this.requireAgentMember(actorId);
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    return decorated.filter((task) => {
      let current: Row | undefined = byId.get(task.id);
      while (current) {
        if (current.assignee_id === actorId || current.issuer_id === actorId) return true;
        current = current.parent_id ? byId.get(current.parent_id) : undefined;
      }
      return false;
    });
  }

  readTask(actorId: Actor, taskId: string, markSeen = true) {
    const row = this.getTaskRow(taskId);
    this.assertTaskReadable(actorId, row);
    if (actorId !== "boss" && markSeen && row.assignee_id === actorId) {
      this.db.prepare(`
        INSERT INTO task_acknowledgements (member_id, task_id, revision, seen_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(member_id, task_id) DO UPDATE SET revision = excluded.revision, seen_at = excluded.seen_at
      `).run(actorId, taskId, row.revision, nowIso());
    }
    const tasks = this.listTasks("boss");
    const task = tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const versions = this.db.prepare("SELECT * FROM task_versions WHERE task_id = ? ORDER BY revision DESC").all(taskId) as Row[];
    const progress = this.db.prepare("SELECT * FROM task_progress WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as Row[];
    const submissions = this.db.prepare("SELECT * FROM task_submissions WHERE task_id = ? ORDER BY created_at DESC").all(taskId) as Row[];
    return {
      ...task,
      versions: versions.map(mapTaskVersion),
      progress: progress.map(mapTaskProgress),
      submissions: submissions.map(mapTaskSubmission),
      audit: this.listAudit("task", taskId),
    };
  }

  createRootTask(input: { title: string; description: string; acceptanceCriteria: string; assigneeId: string }) {
    if (!this.isDirectReport("boss", input.assigneeId)) throw new Error("root tasks can only be assigned to Boss direct reports");
    return this.transaction(() => this.insertTask({
      actorId: "boss",
      parentId: null,
      issuerId: "boss",
      assigneeId: input.assigneeId,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
    }));
  }

  createChildTask(actorId: string, input: {
    parentId: string;
    assigneeId: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
  }) {
    this.requireAgentMember(actorId);
    const parent = this.getTaskRow(input.parentId);
    if (parent.assignee_id !== actorId) throw new Error("only the parent task assignee can create a child task");
    if (!ACTIVE_TASK_STATUSES.has(parent.status as TaskStatus) || parent.status === "review") {
      throw new Error("children can only be created while the parent task is active");
    }
    if (!this.isDirectReport(actorId, input.assigneeId)) throw new Error("child task assignee must be a direct report");
    return this.transaction(() => this.insertTask({
      actorId,
      parentId: input.parentId,
      issuerId: actorId,
      assigneeId: input.assigneeId,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
    }));
  }

  startTask(actorId: string, taskId: string) {
    const member = this.requireAgentMember(actorId);
    const before = this.getTaskRow(taskId);
    if (before.assignee_id !== member.id) throw new Error("only the assignee can start a task");
    if (before.status !== "assigned") throw new Error("only assigned tasks can start");
    const now = nowIso();
    this.transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ?")
        .run(now, now, now, taskId);
      this.audit({ actorId, action: "task.started", entityType: "task", entityId: taskId, before: mapTaskRow(before) });
    });
    return this.readTask(actorId, taskId, false);
  }

  addTaskProgress(actorId: string, taskId: string, body: string) {
    this.requireAgentMember(actorId);
    const task = this.getTaskRow(taskId);
    if (task.assignee_id !== actorId) throw new Error("only the assignee can report progress");
    if (task.status !== "assigned" && task.status !== "in_progress") throw new Error("task is not accepting progress");
    const now = nowIso();
    const progressId = randomUUID();
    this.transaction(() => {
      if (task.status === "assigned") {
        this.db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ?")
          .run(now, now, now, taskId);
      } else {
        this.db.prepare("UPDATE tasks SET updated_at = ?, last_activity_at = ? WHERE id = ?").run(now, now, taskId);
      }
      this.db.prepare("INSERT INTO task_progress (id, task_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(progressId, taskId, actorId, required(body, "body"), now);
      this.audit({ actorId, action: "task.progress", entityType: "task", entityId: taskId, after: { progressId, body } });
    });
    return this.readTask(actorId, taskId, false);
  }

  reviseTask(actorId: Actor, taskId: string, patch: { title?: string; description?: string; acceptanceCriteria?: string }, reason: string) {
    const before = this.getTaskRow(taskId);
    if (actorId !== "boss") this.requireAgentMember(actorId);
    if (actorId !== "boss" && before.issuer_id !== actorId) throw new Error("only the issuer or Boss can revise a task");
    if (TERMINAL_TASK_STATUSES.has(before.status as TaskStatus) || before.status === "review") throw new Error("task cannot be revised in its current state");
    const nextRevision = Number(before.revision) + 1;
    const next = {
      title: patch.title === undefined ? before.title : required(patch.title, "title"),
      description: patch.description === undefined ? before.description : required(patch.description, "description"),
      acceptanceCriteria: patch.acceptanceCriteria === undefined ? before.acceptance_criteria : required(patch.acceptanceCriteria, "acceptanceCriteria"),
    };
    const now = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE tasks SET title = ?, description = ?, acceptance_criteria = ?, revision = ?, updated_at = ?, last_activity_at = ? WHERE id = ?
      `).run(next.title, next.description, next.acceptanceCriteria, nextRevision, now, now, taskId);
      this.db.prepare(`
        INSERT INTO task_versions (id, task_id, revision, title, description, acceptance_criteria, changed_by, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), taskId, nextRevision, next.title, next.description, next.acceptanceCriteria, actorId, required(reason, "reason"), now);
      this.audit({ actorId, action: "task.revised", entityType: "task", entityId: taskId, reason, before: mapTaskRow(before), after: next });
    });
    return this.readTask(actorId, taskId, false);
  }

  blockTask(actorId: string, taskId: string, reason: string) {
    this.requireAgentMember(actorId);
    const before = this.getTaskRow(taskId);
    if (before.assignee_id !== actorId) throw new Error("only the assignee can block a task");
    if (before.status !== "assigned" && before.status !== "in_progress") throw new Error("task cannot be blocked in its current state");
    const now = nowIso();
    this.transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'blocked', blocked_reason = ?, updated_at = ?, last_activity_at = ? WHERE id = ?")
        .run(required(reason, "reason"), now, now, taskId);
      this.audit({ actorId, action: "task.blocked", entityType: "task", entityId: taskId, reason, before: mapTaskRow(before) });
    });
    return this.readTask(actorId, taskId, false);
  }

  unblockTask(actorId: Actor, taskId: string, reason: string) {
    const before = this.getTaskRow(taskId);
    if (actorId !== "boss") this.requireAgentMember(actorId);
    if (actorId !== "boss" && before.assignee_id !== actorId && before.issuer_id !== actorId) {
      throw new Error("only the assignee, issuer, or Boss can unblock a task");
    }
    if (before.status !== "blocked") throw new Error("only blocked tasks can be unblocked");
    const now = nowIso();
    this.transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'in_progress', blocked_reason = NULL, updated_at = ?, last_activity_at = ? WHERE id = ?")
        .run(now, now, taskId);
      this.audit({ actorId, action: "task.unblocked", entityType: "task", entityId: taskId, reason: required(reason, "reason"), before: mapTaskRow(before) });
    });
    return this.readTask(actorId, taskId, false);
  }

  submitTask(actorId: string, taskId: string, summary: string, evidence: EvidenceInput[]) {
    this.requireAgentMember(actorId);
    const before = this.getTaskRow(taskId);
    if (before.assignee_id !== actorId) throw new Error("only the assignee can submit a task");
    if (before.status !== "in_progress") throw new Error("only in-progress tasks can be submitted");
    if (!Array.isArray(evidence) || evidence.length === 0) throw new Error("at least one proof or artifact is required");
    const activeChildren = this.db.prepare(`
      SELECT id, status FROM tasks WHERE parent_id = ? AND status NOT IN ('closed', 'canceled') ORDER BY created_at
    `).all(taskId) as Row[];
    if (activeChildren.length > 0) throw new Error(`all direct child tasks must be terminal before review: ${activeChildren.map((row) => row.id).join(", ")}`);
    const submissionId = randomUUID();
    const now = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO task_submissions (id, task_id, submitter_id, summary, evidence_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(submissionId, taskId, actorId, required(summary, "summary"), JSON.stringify(normalizeEvidence(evidence)), now);
      this.db.prepare("UPDATE tasks SET status = 'review', submitted_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ?")
        .run(now, now, now, taskId);
      this.audit({ actorId, action: "task.submitted", entityType: "task", entityId: taskId, before: mapTaskRow(before), after: { submissionId, summary, evidence } });
    });
    return this.readTask(actorId, taskId, false);
  }

  reviewTask(actorId: Actor, taskId: string, decision: "accept" | "reject", feedback?: string) {
    const before = this.getTaskRow(taskId);
    if (actorId !== "boss") this.requireAgentMember(actorId);
    if (actorId !== "boss" && before.issuer_id !== actorId) throw new Error("only the issuer or Boss can review a task");
    if (before.status !== "review") throw new Error("task is not awaiting review");
    const submission = this.db.prepare("SELECT * FROM task_submissions WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(taskId) as Row | undefined;
    if (!submission) throw new Error("pending task submission not found");
    const now = this.nextTaskActivityAt(taskId, before.updated_at);
    this.transaction(() => {
      if (decision === "accept") {
        this.db.prepare("UPDATE task_submissions SET status = 'accepted', reviewer_id = ?, feedback = ?, reviewed_at = ? WHERE id = ?")
          .run(actorId, feedback?.trim() || null, now, submission.id);
        this.db.prepare("UPDATE tasks SET status = 'closed', review_feedback = ?, closed_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ?")
          .run(feedback?.trim() || null, now, now, now, taskId);
        this.audit({ actorId, action: "task.closed", entityType: "task", entityId: taskId, reason: feedback, before: mapTaskRow(before) });
      } else {
        const rejection = required(feedback, "feedback");
        this.db.prepare("UPDATE task_submissions SET status = 'rejected', reviewer_id = ?, feedback = ?, reviewed_at = ? WHERE id = ?")
          .run(actorId, rejection, now, submission.id);
        this.db.prepare("UPDATE tasks SET status = 'in_progress', review_feedback = ?, submitted_at = NULL, updated_at = ?, last_activity_at = ? WHERE id = ?")
          .run(rejection, now, now, taskId);
        this.audit({ actorId, action: "task.rejected", entityType: "task", entityId: taskId, reason: rejection, before: mapTaskRow(before) });
      }
    });
    return this.readTask(actorId, taskId, false);
  }

  reassignTask(actorId: Actor, taskId: string, assigneeId: string, reason: string) {
    const before = this.getTaskRow(taskId);
    if (actorId !== "boss") this.requireAgentMember(actorId);
    if (actorId !== "boss" && before.issuer_id !== actorId) throw new Error("only the issuer or Boss can reassign a task");
    if (!ACTIVE_TASK_STATUSES.has(before.status as TaskStatus) || before.status === "review") throw new Error("task cannot be reassigned in its current state");
    if (!this.isDirectReport(before.issuer_id, assigneeId)) throw new Error("new assignee must remain a direct report of the task issuer");
    const openChildren = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_id = ? AND status NOT IN ('closed', 'canceled')").get(taskId) as Row;
    if (Number(openChildren.count) > 0) throw new Error("task with active child tasks cannot be reassigned");
    const now = this.nextTaskActivityAt(taskId, before.updated_at);
    this.transaction(() => {
      this.db.prepare(`
        UPDATE tasks SET assignee_id = ?, status = 'assigned', blocked_reason = NULL, review_feedback = NULL,
          started_at = NULL, submitted_at = NULL, updated_at = ?, last_activity_at = ? WHERE id = ?
      `).run(assigneeId, now, now, taskId);
      this.audit({ actorId, action: "task.reassigned", entityType: "task", entityId: taskId, reason: required(reason, "reason"), before: mapTaskRow(before), after: { assigneeId } });
    });
    return this.readTask(actorId, taskId, false);
  }

  cancelTask(actorId: Actor, taskId: string, reason: string) {
    const before = this.getTaskRow(taskId);
    if (actorId !== "boss") this.requireAgentMember(actorId);
    if (actorId !== "boss" && before.issuer_id !== actorId) throw new Error("only the issuer or Boss can cancel a task");
    if (TERMINAL_TASK_STATUSES.has(before.status as TaskStatus)) throw new Error("task is already terminal");
    const openChildren = this.db.prepare("SELECT id FROM tasks WHERE parent_id = ? AND status NOT IN ('closed', 'canceled')").all(taskId) as Row[];
    if (openChildren.length > 0) throw new Error("cascade cancellation is forbidden; resolve child tasks first");
    const now = nowIso();
    this.transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'canceled', canceled_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ?")
        .run(now, now, now, taskId);
      this.audit({ actorId, action: "task.canceled", entityType: "task", entityId: taskId, reason: required(reason, "reason"), before: mapTaskRow(before) });
    });
    return this.readTask(actorId, taskId, false);
  }

  private insertTask(input: {
    actorId: Actor;
    parentId: string | null;
    issuerId: string;
    assigneeId: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    sourceMeetingId?: string;
  }) {
    const id = randomUUID();
    const now = nowIso();
    const title = required(input.title, "title");
    const description = required(input.description, "description");
    const acceptanceCriteria = required(input.acceptanceCriteria, "acceptanceCriteria");
    this.getMember(input.issuerId);
    this.getMember(input.assigneeId);
    this.db.prepare(`
      INSERT INTO tasks (
        id, parent_id, issuer_id, assignee_id, source_meeting_id, title, description,
        acceptance_criteria, status, revision, created_at, updated_at, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assigned', 1, ?, ?, ?)
    `).run(id, input.parentId, input.issuerId, input.assigneeId, input.sourceMeetingId ?? null, title, description, acceptanceCriteria, now, now, now);
    this.db.prepare(`
      INSERT INTO task_versions (id, task_id, revision, title, description, acceptance_criteria, changed_by, reason, created_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, 'initial assignment', ?)
    `).run(randomUUID(), id, title, description, acceptanceCriteria, input.actorId, now);
    if (input.parentId) {
      this.db.prepare("UPDATE tasks SET updated_at = ?, last_activity_at = ? WHERE id = ?").run(now, now, input.parentId);
    }
    this.audit({ actorId: input.actorId, action: "task.created", entityType: "task", entityId: id, after: { ...input, id } });
    return this.decorateTasks([this.getTaskRow(id)])[0]!;
  }

  private getTaskRow(taskId: string) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Row | undefined;
    if (!row) throw new Error(`task not found: ${taskId}`);
    return row;
  }

  private nextTaskActivityAt(taskId: string, previousUpdatedAt: string) {
    const acknowledgement = this.db.prepare("SELECT MAX(seen_at) AS seen_at FROM task_acknowledgements WHERE task_id = ?").get(taskId) as Row;
    const timestamps = [previousUpdatedAt, acknowledgement.seen_at]
      .map((value) => typeof value === "string" ? Date.parse(value) : Number.NaN)
      .filter(Number.isFinite);
    const floor = timestamps.length ? Math.max(...timestamps) : 0;
    return new Date(Math.max(Date.now(), floor + 1)).toISOString();
  }

  private assertTaskReadable(actorId: Actor, task: Row) {
    if (actorId === "boss") return;
    this.requireAgentMember(actorId);
    let current: Row | undefined = task;
    while (current) {
      if (current.assignee_id === actorId || current.issuer_id === actorId) return;
      current = current.parent_id ? this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(current.parent_id) as Row | undefined : undefined;
    }
    throw new Error("task is outside the caller's responsibility tree");
  }

  private decorateTasks(rows: Row[]) {
    const allRows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all() as Row[];
    const byParent = new Map<string, Row[]>();
    for (const row of allRows) {
      if (!row.parent_id) continue;
      const list = byParent.get(row.parent_id) ?? [];
      list.push(row);
      byParent.set(row.parent_id, list);
    }
    const collectDescendants = (id: string): Row[] => {
      const direct = byParent.get(id) ?? [];
      return direct.flatMap((child) => [child, ...collectDescendants(child.id)]);
    };
    const now = Date.now();
    return rows.map((row) => {
      const direct = byParent.get(row.id) ?? [];
      const descendants = collectDescendants(row.id);
      const stale = isTaskStale(row, now, this.staleAfterMs);
      return {
        ...mapTaskRow(row),
        childIds: direct.map((child) => child.id),
        childCounts: {
          total: direct.length,
          active: direct.filter((child) => !TERMINAL_TASK_STATUSES.has(child.status as TaskStatus)).length,
          closed: direct.filter((child) => child.status === "closed").length,
          canceled: direct.filter((child) => child.status === "canceled").length,
        },
        risks: {
          blockedDescendants: descendants.filter((child) => child.status === "blocked").length,
          staleDescendants: descendants.filter((child) => isTaskStale(child, now, this.staleAfterMs)).length,
          stale,
        },
      };
    });
  }

  // ── Notices ──────────────────────────────────────────────

  listNotices(actorId: Actor = "boss", options?: { effectiveOnly?: boolean }) {
    if (actorId !== "boss") this.requireAgentMember(actorId);
    const rows = this.db.prepare(`
      SELECT n.*,
        replacement.id AS superseded_by_id,
        (SELECT COUNT(*) FROM members WHERE kind = 'agent' AND active = 1) AS active_employee_count,
        (SELECT COUNT(*) FROM notice_reads nr JOIN members rm ON rm.id = nr.member_id
          WHERE nr.notice_id = n.id AND rm.kind = 'agent' AND rm.active = 1) AS read_count,
        ${actorId === "boss" ? "NULL" : "(SELECT read_at FROM notice_reads WHERE notice_id = n.id AND member_id = ?)"} AS read_at
      FROM notices n
      LEFT JOIN notices replacement ON replacement.supersedes_notice_id = n.id
      ${options?.effectiveOnly ? "WHERE replacement.id IS NULL" : ""}
      ORDER BY n.created_at DESC
    `).all(...(actorId === "boss" ? [] : [actorId])) as Row[];
    return rows.map(mapNotice);
  }

  readNotice(actorId: string, noticeId: string) {
    this.requireAgentMember(actorId);
    const notice = this.db.prepare("SELECT id FROM notices WHERE id = ?").get(noticeId) as Row | undefined;
    if (!notice) throw new Error(`notice not found: ${noticeId}`);
    const readAt = nowIso();
    this.db.prepare(`
      INSERT INTO notice_reads (notice_id, member_id, read_at) VALUES (?, ?, ?)
      ON CONFLICT(notice_id, member_id) DO UPDATE SET read_at = excluded.read_at
    `).run(noticeId, actorId, readAt);
    this.audit({ actorId, action: "notice.read", entityType: "notice", entityId: noticeId });
    return { noticeId, readAt };
  }

  publishNotice(actorId: Actor, input: { title: string; body: string; supersedesNoticeId?: string }) {
    if (actorId !== "boss") this.requireAgentMember(actorId);
    if (!this.canPublishNotice(actorId)) throw new Error("only Boss, main, or a current manager can publish notices");
    return this.transaction(() => this.insertNotice({
      actorId,
      authorId: actorId,
      kind: input.supersedesNoticeId ? "correction" : "manual",
      title: input.title,
      body: input.body,
      supersedesNoticeId: input.supersedesNoticeId,
    }));
  }

  private insertNotice(input: {
    actorId: Actor;
    authorId: string;
    kind: "manual" | "meeting_report" | "correction";
    title: string;
    body: string;
    sourceMeetingId?: string;
    supersedesNoticeId?: string;
  }) {
    this.getMember(input.authorId, { active: false });
    if (input.supersedesNoticeId) {
      const original = this.db.prepare("SELECT id FROM notices WHERE id = ?").get(input.supersedesNoticeId) as Row | undefined;
      if (!original) throw new Error(`superseded notice not found: ${input.supersedesNoticeId}`);
      const replacement = this.db.prepare("SELECT id FROM notices WHERE supersedes_notice_id = ?").get(input.supersedesNoticeId) as Row | undefined;
      if (replacement) throw new Error("a notice can only be directly superseded once; correct the latest notice instead");
    }
    const id = randomUUID();
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO notices (id, author_id, kind, title, body, source_meeting_id, supersedes_notice_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.authorId,
      input.kind,
      required(input.title, "title"),
      required(input.body, "body"),
      input.sourceMeetingId ?? null,
      input.supersedesNoticeId ?? null,
      createdAt,
    );
    this.db.prepare(`
      INSERT OR IGNORE INTO notice_reads (notice_id, member_id, read_at) VALUES (?, ?, ?)
    `).run(id, input.authorId, createdAt);
    this.audit({ actorId: input.actorId, action: "notice.published", entityType: "notice", entityId: id, after: { ...input, id } });
    return this.listNotices("boss").find((notice) => notice.id === id)!;
  }

  // ── Meetings ──────────────────────────────────────────────

  requestMeeting(actorId: Actor, input: {
    type: MeetingType;
    title: string;
    agenda: string;
    parentTaskId?: string;
    hostId?: string;
    participants?: MeetingParticipantInput[];
  }): { meeting: ReturnType<CompanyOsStore["meetingView"]>; advance: MeetingAdvance } {
    if (actorId !== "boss") this.requireAgentMember(actorId);
    const hostId = actorId === "boss" ? required(input.hostId, "hostId") : actorId;
    this.getMember(hostId);
    const participants = dedupeParticipants(input.participants ?? [], hostId);
    let parentTaskId: string | null = null;
    if (input.type === "task") {
      parentTaskId = required(input.parentTaskId, "parentTaskId");
      const parent = this.getTaskRow(parentTaskId);
      if (parent.assignee_id !== hostId) throw new Error("a task meeting must be hosted by the parent task assignee");
      if (!ACTIVE_TASK_STATUSES.has(parent.status as TaskStatus) || parent.status === "review") {
        throw new Error("the bound parent task is not active");
      }
    } else if (input.parentTaskId) {
      throw new Error("discussion meetings cannot bind a task");
    }
    for (const participant of participants) {
      if (participant.agentId === "boss") throw new Error("Boss is an implicit WebUI participant and cannot be scheduled as an Agent");
      this.getMember(participant.agentId);
      if (input.type === "task" && participant.role === "worker" && !this.isDirectReport(hostId, participant.agentId)) {
        throw new Error(`worker must be a direct report of the host: ${participant.agentId}`);
      }
    }
    const meetingId = randomUUID();
    const createdAt = nowIso();
    const advance = this.transaction(() => {
      const active = this.db.prepare("SELECT id FROM meetings WHERE status = 'active'").get() as Row | undefined;
      const queue = this.db.prepare("SELECT COALESCE(MAX(queue_position), 0) AS position FROM meetings WHERE status = 'queued'").get() as Row;
      const status: MeetingStatus = active ? "queued" : "active";
      const position = status === "active" ? 0 : Number(queue.position) + 1;
      this.db.prepare(`
        INSERT INTO meetings (
          id, type, status, title, agenda, host_id, requested_by, parent_task_id, queue_position,
          waiting_on_host_since, created_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        meetingId,
        input.type,
        status,
        required(input.title, "title"),
        required(input.agenda, "agenda"),
        hostId,
        actorId,
        parentTaskId,
        position,
        status === "active" ? createdAt : null,
        createdAt,
        status === "active" ? createdAt : null,
      );
      for (const participant of participants) {
        this.db.prepare("INSERT INTO meeting_participants (meeting_id, member_id, role) VALUES (?, ?, ?)")
          .run(meetingId, participant.agentId, participant.role);
      }
      if (status === "active") this.addMeetingMessage(meetingId, "system", null, null, "会议室已开放，主持人开始组织会议。");
      this.audit({ actorId, action: "meeting.requested", entityType: "meeting", entityId: meetingId, after: { ...input, hostId, status } });
      return status === "active" ? { schedule: this.hostSchedule(meetingId, "会议已开始，请组织第一轮发言。") } : {};
    });
    return { meeting: this.meetingView(meetingId), advance };
  }

  listMeetings(actorId: Actor = "boss") {
    if (actorId !== "boss") this.requireAgentMember(actorId);
    const rows = this.db.prepare(`
      SELECT DISTINCT m.* FROM meetings m
      LEFT JOIN meeting_participants p ON p.meeting_id = m.id
      ${actorId === "boss" ? "" : "WHERE m.host_id = ? OR m.requested_by = ? OR p.member_id = ?"}
      ORDER BY CASE m.status WHEN 'active' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
        m.queue_position ASC, COALESCE(m.ended_at, m.created_at) DESC
    `).all(...(actorId === "boss" ? [] : [actorId, actorId, actorId])) as Row[];
    return rows.map((row) => this.mapMeetingSummary(row));
  }

  meetingView(meetingId: string, actorId: Actor = "boss") {
    const row = this.getMeetingRow(meetingId);
    this.assertMeetingReadable(actorId, row);
    const participants = this.db.prepare(`
      SELECT p.*, m.name, m.title, m.agent_id FROM meeting_participants p
      JOIN members m ON m.id = p.member_id WHERE p.meeting_id = ? ORDER BY p.role, m.created_at
    `).all(meetingId) as Row[];
    const messages = this.db.prepare("SELECT * FROM meeting_messages WHERE meeting_id = ? ORDER BY sequence").all(meetingId) as Row[];
    const drafts = this.db.prepare("SELECT * FROM meeting_task_drafts WHERE meeting_id = ? ORDER BY position").all(meetingId) as Row[];
    const currentTurn = row.current_turn_id
      ? this.db.prepare("SELECT * FROM meeting_turns WHERE id = ?").get(row.current_turn_id) as Row | undefined
      : undefined;
    return {
      ...this.mapMeetingSummary(row),
      participants: participants.map((participant) => ({
        agentId: participant.member_id,
        role: participant.role,
        name: participant.name,
        title: participant.title,
      })),
      messages: messages.map(mapMeetingMessage),
      taskDrafts: drafts.map(mapTaskDraft),
      currentTurn: currentTurn ? mapMeetingTurn(currentTurn) : null,
      audit: this.listAudit("meeting", meetingId),
    };
  }

  delegateMeeting(actorId: string, meetingId: string, speakerId: string, prompt: string): MeetingAdvance {
    this.requireAgentMember(actorId);
    const meeting = this.requireActiveHostedMeeting(actorId, meetingId);
    if (meeting.current_turn_id) throw new Error("the current speaker has not finished");
    const participant = this.db.prepare("SELECT 1 AS ok FROM meeting_participants WHERE meeting_id = ? AND member_id = ?")
      .get(meetingId, speakerId) as Row | undefined;
    if (!participant) throw new Error("the selected speaker is not a meeting participant");
    return this.transaction(() => {
      const interventionAdvance = this.advancePendingInterventions(meetingId);
      if (interventionAdvance.schedule?.turnId) return interventionAdvance;
      const turn = this.createMeetingTurn(meetingId, speakerId, actorId, "delegate", required(prompt, "prompt"));
      this.addMeetingMessage(meetingId, "member", actorId, speakerId, `点名 ${speakerId}：${prompt}`, turn.id);
      this.db.prepare("UPDATE meetings SET current_turn_id = ?, waiting_on_host_since = NULL WHERE id = ?").run(turn.id, meetingId);
      this.audit({ actorId, action: "meeting.delegated", entityType: "meeting", entityId: meetingId, after: { turnId: turn.id, speakerId, prompt } });
      return { schedule: this.turnSchedule(meetingId, turn.id, speakerId, prompt) };
    });
  }

  speakMeeting(actorId: string, meetingId: string, body: string): MeetingAdvance {
    this.requireAgentMember(actorId);
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.status !== "active") throw new Error("meeting is not active");
    const message = required(body, "body");
    return this.transaction(() => {
      if (!meeting.current_turn_id) {
        if (meeting.host_id !== actorId) throw new Error("only the current speaker can speak");
        this.addMeetingMessage(meetingId, "member", actorId, null, message);
        this.db.prepare("UPDATE meetings SET waiting_on_host_since = ? WHERE id = ?").run(nowIso(), meetingId);
        this.audit({ actorId, action: "meeting.host_spoke", entityType: "meeting", entityId: meetingId, after: { body: message } });
        return this.advancePendingInterventions(meetingId);
      }
      const turn = this.db.prepare("SELECT * FROM meeting_turns WHERE id = ?").get(meeting.current_turn_id) as Row | undefined;
      if (!turn || turn.status !== "waiting" || turn.speaker_id !== actorId) throw new Error("only the current speaker can speak");
      const completedAt = nowIso();
      this.db.prepare("UPDATE meeting_turns SET status = 'completed', completed_at = ? WHERE id = ?").run(completedAt, turn.id);
      this.addMeetingMessage(meetingId, "member", actorId, null, message, turn.id);
      if (turn.intervention_id) {
        this.db.prepare("UPDATE meeting_interventions SET status = 'delivered', delivered_at = ? WHERE id = ?")
          .run(completedAt, turn.intervention_id);
      }
      this.db.prepare("UPDATE meetings SET current_turn_id = NULL, waiting_on_host_since = ? WHERE id = ?").run(completedAt, meetingId);
      this.audit({ actorId, action: "meeting.spoke", entityType: "meeting", entityId: meetingId, after: { turnId: turn.id, body: message } });
      return this.advancePendingInterventions(meetingId);
    });
  }

  bossInterject(meetingId: string, body: string, targetId?: string): MeetingAdvance {
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.status !== "active") throw new Error("meeting is not active");
    if (targetId) {
      const related = targetId === meeting.host_id || Boolean(this.db.prepare(
        "SELECT 1 AS ok FROM meeting_participants WHERE meeting_id = ? AND member_id = ?",
      ).get(meetingId, targetId));
      if (!related) throw new Error("Boss can only @ the host or a participant in the active meeting");
      this.getMember(targetId);
    }
    const interventionId = randomUUID();
    const createdAt = nowIso();
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO meeting_interventions (id, meeting_id, target_id, body, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `).run(interventionId, meetingId, targetId ?? null, required(body, "body"), createdAt);
      this.addMeetingMessage(meetingId, "boss", "boss", targetId ?? null, body);
      this.audit({ actorId: "boss", action: "meeting.boss_interjected", entityType: "meeting", entityId: meetingId, after: { interventionId, targetId, body } });
      return meeting.current_turn_id ? {} : this.advancePendingInterventions(meetingId);
    });
  }

  setMeetingTaskDrafts(actorId: string, meetingId: string, drafts: TaskDraftInput[]) {
    this.requireAgentMember(actorId);
    const meeting = this.requireActiveHostedMeeting(actorId, meetingId);
    if (meeting.type !== "task") throw new Error("only task meetings can create task drafts");
    if (meeting.current_turn_id) throw new Error("task drafts cannot change during an active speaking turn");
    const normalized = drafts.map((draft) => ({
      title: required(draft.title, "title"),
      description: required(draft.description, "description"),
      acceptanceCriteria: required(draft.acceptanceCriteria, "acceptanceCriteria"),
      assigneeId: required(draft.assigneeId, "assigneeId"),
    }));
    for (const draft of normalized) {
      if (!this.isDirectReport(actorId, draft.assigneeId)) throw new Error(`draft assignee must be a direct report: ${draft.assigneeId}`);
    }
    this.transaction(() => {
      this.db.prepare("DELETE FROM meeting_task_drafts WHERE meeting_id = ?").run(meetingId);
      normalized.forEach((draft, position) => {
        this.db.prepare(`
          INSERT INTO meeting_task_drafts (id, meeting_id, position, title, description, acceptance_criteria, assignee_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), meetingId, position, draft.title, draft.description, draft.acceptanceCriteria, draft.assigneeId);
      });
      this.db.prepare("UPDATE meetings SET waiting_on_host_since = ? WHERE id = ?").run(nowIso(), meetingId);
      this.audit({ actorId, action: "meeting.task_drafts_set", entityType: "meeting", entityId: meetingId, after: normalized });
    });
    return this.meetingView(meetingId, actorId);
  }

  endMeeting(actorId: string, meetingId: string, summary: string, publishNotice = false): {
    meeting: ReturnType<CompanyOsStore["meetingView"]>;
    createdTasks: ReturnType<CompanyOsStore["listTasks"]>;
    notice: ReturnType<CompanyOsStore["listNotices"]>[number] | null;
    advance: MeetingAdvance;
  } {
    this.requireAgentMember(actorId);
    const meeting = this.requireActiveHostedMeeting(actorId, meetingId);
    if (meeting.current_turn_id) throw new Error("the current speaking turn must finish before the meeting can end");
    const pendingInterventions = this.db.prepare("SELECT COUNT(*) AS count FROM meeting_interventions WHERE meeting_id = ? AND status != 'delivered'")
      .get(meetingId) as Row;
    if (Number(pendingInterventions.count) > 0) throw new Error("all Boss interventions must be handled before the meeting can end");
    const finalSummary = required(summary, "summary");
    const drafts = this.db.prepare("SELECT * FROM meeting_task_drafts WHERE meeting_id = ? ORDER BY position").all(meetingId) as Row[];
    if (meeting.type === "task") {
      const parent = this.getTaskRow(meeting.parent_task_id);
      if (parent.assignee_id !== actorId || !ACTIVE_TASK_STATUSES.has(parent.status as TaskStatus) || parent.status === "review") {
        throw new Error("the bound parent task is no longer eligible for delegation");
      }
      const workers = this.db.prepare("SELECT member_id FROM meeting_participants WHERE meeting_id = ? AND role = 'worker'").all(meetingId) as Row[];
      if (workers.length === 0) throw new Error("a task meeting requires at least one worker");
      for (const worker of workers) {
        if (!drafts.some((draft) => draft.assignee_id === worker.member_id)) {
          throw new Error(`every worker must receive at least one task: ${worker.member_id}`);
        }
      }
      for (const draft of drafts) {
        if (!this.isDirectReport(actorId, draft.assignee_id)) throw new Error(`draft assignee is no longer a direct report: ${draft.assignee_id}`);
      }
    } else if (publishNotice && !this.canPublishNotice(actorId)) {
      throw new Error("the host does not have permission to publish a notice");
    }
    let createdTasks: ReturnType<CompanyOsStore["listTasks"]> = [];
    let notice: ReturnType<CompanyOsStore["listNotices"]>[number] | null = null;
    let advance: MeetingAdvance = {};
    this.transaction(() => {
      if (meeting.type === "task") {
        createdTasks = drafts.map((draft) => this.insertTask({
          actorId,
          parentId: meeting.parent_task_id,
          issuerId: actorId,
          assigneeId: draft.assignee_id,
          title: draft.title,
          description: draft.description,
          acceptanceCriteria: draft.acceptance_criteria,
          sourceMeetingId: meetingId,
        }));
        notice = this.insertNotice({
          actorId,
          authorId: actorId,
          kind: "meeting_report",
          title: `会议汇报：${meeting.title}`,
          body: meetingReportBody(finalSummary, meeting.parent_task_id, createdTasks),
          sourceMeetingId: meetingId,
        });
      } else if (publishNotice) {
        notice = this.insertNotice({
          actorId,
          authorId: actorId,
          kind: "meeting_report",
          title: `讨论会汇报：${meeting.title}`,
          body: finalSummary,
          sourceMeetingId: meetingId,
        });
      }
      const endedAt = nowIso();
      this.db.prepare(`
        UPDATE meetings SET status = 'completed', summary = ?, publish_notice = ?, current_turn_id = NULL,
          waiting_on_host_since = NULL, ended_at = ? WHERE id = ?
      `).run(finalSummary, notice ? 1 : 0, endedAt, meetingId);
      this.addMeetingMessage(meetingId, "system", null, null, "会议已完成，会议室已释放。");
      this.audit({ actorId, action: "meeting.completed", entityType: "meeting", entityId: meetingId, after: { summary: finalSummary, createdTaskIds: createdTasks.map((task) => task.id), noticeId: notice?.id } });
      advance = this.activateNextMeeting();
    });
    return { meeting: this.meetingView(meetingId), createdTasks, notice, advance };
  }

  cancelMeeting(actorId: Actor, meetingId: string, reason: string) {
    if (actorId !== "boss") this.requireAgentMember(actorId);
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.status !== "queued") throw new Error("only queued meetings can be canceled");
    if (actorId !== "boss" && meeting.host_id !== actorId && meeting.requested_by !== actorId) {
      throw new Error("only Boss, the host, or the requester can cancel a queued meeting");
    }
    this.transaction(() => {
      this.db.prepare("UPDATE meetings SET status = 'canceled', canceled_reason = ?, ended_at = ? WHERE id = ?")
        .run(required(reason, "reason"), nowIso(), meetingId);
      this.audit({ actorId, action: "meeting.canceled", entityType: "meeting", entityId: meetingId, reason });
      this.normalizeMeetingQueue();
    });
    return this.meetingView(meetingId, actorId);
  }

  reorderMeeting(meetingId: string, targetPosition: number) {
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.status !== "queued") throw new Error("only queued meetings can be reordered");
    const queued = this.db.prepare("SELECT id FROM meetings WHERE status = 'queued' ORDER BY queue_position, created_at").all() as Row[];
    const ids = queued.map((row) => row.id as string).filter((id) => id !== meetingId);
    const index = Math.min(Math.max(Math.floor(targetPosition) - 1, 0), ids.length);
    ids.splice(index, 0, meetingId);
    this.transaction(() => {
      ids.forEach((id, position) => this.db.prepare("UPDATE meetings SET queue_position = ? WHERE id = ?").run(position + 1, id));
      this.audit({ actorId: "boss", action: "meeting.reordered", entityType: "meeting", entityId: meetingId, after: { targetPosition: index + 1 } });
    });
    return this.listMeetings("boss").filter((item) => item.status === "queued");
  }

  sweepMeetingTimeouts(participantTimeoutMs: number, hostTimeoutMs: number): MeetingAdvance[] {
    const meeting = this.db.prepare("SELECT * FROM meetings WHERE status = 'active'").get() as Row | undefined;
    if (!meeting) return [];
    const now = Date.now();
    if (meeting.current_turn_id) {
      const turn = this.db.prepare("SELECT * FROM meeting_turns WHERE id = ? AND status = 'waiting'").get(meeting.current_turn_id) as Row | undefined;
      if (!turn) return [];
      const timeout = turn.speaker_id === meeting.host_id ? hostTimeoutMs : participantTimeoutMs;
      if (now - Date.parse(turn.started_at) < timeout) return [];
      return this.transaction(() => {
        if (turn.speaker_id === meeting.host_id) return [this.timeoutMeeting(meeting, "主持人发言超时")];
        const failedAt = nowIso();
        this.db.prepare("UPDATE meeting_turns SET status = 'failed', completed_at = ?, error = 'participant timeout' WHERE id = ?")
          .run(failedAt, turn.id);
        if (turn.intervention_id) {
          this.db.prepare("UPDATE meeting_interventions SET status = 'delivered', delivered_at = ? WHERE id = ?")
            .run(failedAt, turn.intervention_id);
        }
        this.db.prepare("UPDATE meetings SET current_turn_id = NULL, waiting_on_host_since = ? WHERE id = ?")
          .run(failedAt, meeting.id);
        this.addMeetingMessage(meeting.id, "system", null, null, `${turn.speaker_id} 本轮发言超时，控制权返回主持人。`, turn.id);
        this.audit({ actorId: "system", action: "meeting.turn_timed_out", entityType: "meeting", entityId: meeting.id, after: { turnId: turn.id, speakerId: turn.speaker_id } });
        const interventionAdvance = this.advancePendingInterventions(meeting.id);
        return [interventionAdvance.schedule ? interventionAdvance : { schedule: this.hostSchedule(meeting.id, "参会者发言超时，请继续主持会议。") }];
      });
    }
    if (meeting.waiting_on_host_since && now - Date.parse(meeting.waiting_on_host_since) >= hostTimeoutMs) {
      return this.transaction(() => [this.timeoutMeeting(meeting, "主持人持续无响应")]);
    }
    return [];
  }

  recoveryAdvance(): MeetingAdvance | null {
    const meeting = this.db.prepare("SELECT * FROM meetings WHERE status = 'active'").get() as Row | undefined;
    if (!meeting) return null;
    if (meeting.current_turn_id) {
      const turn = this.db.prepare("SELECT * FROM meeting_turns WHERE id = ? AND status = 'waiting'").get(meeting.current_turn_id) as Row | undefined;
      if (turn) return { schedule: this.turnSchedule(meeting.id, turn.id, turn.speaker_id, turn.prompt) };
    }
    return { schedule: this.hostSchedule(meeting.id, "Gateway 已恢复，请根据当前会议记录继续主持。") };
  }

  private requireActiveHostedMeeting(actorId: string, meetingId: string) {
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.status !== "active") throw new Error("meeting is not active");
    if (meeting.host_id !== actorId) throw new Error("only the host can perform this meeting action");
    return meeting;
  }

  private getMeetingRow(meetingId: string) {
    const row = this.db.prepare("SELECT * FROM meetings WHERE id = ?").get(meetingId) as Row | undefined;
    if (!row) throw new Error(`meeting not found: ${meetingId}`);
    return row;
  }

  private assertMeetingReadable(actorId: Actor, meeting: Row) {
    if (actorId === "boss") return;
    this.requireAgentMember(actorId);
    if (meeting.host_id === actorId || meeting.requested_by === actorId) return;
    const participant = this.db.prepare("SELECT 1 AS ok FROM meeting_participants WHERE meeting_id = ? AND member_id = ?")
      .get(meeting.id, actorId);
    if (!participant) throw new Error("meeting is not visible to this member");
  }

  private mapMeetingSummary(row: Row) {
    const participantCount = this.db.prepare("SELECT COUNT(*) AS count FROM meeting_participants WHERE meeting_id = ?").get(row.id) as Row;
    return {
      id: row.id,
      type: row.type as MeetingType,
      status: row.status as MeetingStatus,
      title: row.title,
      agenda: row.agenda,
      hostId: row.host_id,
      requestedBy: row.requested_by,
      parentTaskId: row.parent_task_id,
      summary: row.summary,
      publishNotice: Boolean(row.publish_notice),
      queuePosition: Number(row.queue_position),
      participantCount: Number(participantCount.count),
      currentTurnId: row.current_turn_id,
      waitingOnHostSince: row.waiting_on_host_since,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      canceledReason: row.canceled_reason,
    };
  }

  private addMeetingMessage(
    meetingId: string,
    authorKind: "boss" | "member" | "system",
    authorId: string | null,
    targetId: string | null,
    body: string,
    turnId?: string,
  ) {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM meeting_messages WHERE meeting_id = ?")
      .get(meetingId) as Row;
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO meeting_messages (id, meeting_id, sequence, author_kind, author_id, target_id, body, turn_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, meetingId, Number(row.sequence), authorKind, authorId, targetId, required(body, "body"), turnId ?? null, nowIso());
    return id;
  }

  private createMeetingTurn(
    meetingId: string,
    speakerId: string,
    requestedBy: string,
    kind: "delegate" | "boss",
    prompt: string,
    interventionId?: string,
  ) {
    const id = randomUUID();
    const startedAt = nowIso();
    this.db.prepare(`
      INSERT INTO meeting_turns (id, meeting_id, speaker_id, requested_by, kind, prompt, intervention_id, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)
    `).run(id, meetingId, speakerId, requestedBy, kind, prompt, interventionId ?? null, startedAt);
    return { id, startedAt };
  }

  private advancePendingInterventions(meetingId: string): MeetingAdvance {
    while (true) {
      const intervention = this.db.prepare(`
        SELECT * FROM meeting_interventions WHERE meeting_id = ? AND status = 'pending' ORDER BY created_at, rowid LIMIT 1
      `).get(meetingId) as Row | undefined;
      if (!intervention) return { schedule: this.hostSchedule(meetingId, "当前发言已结束，请根据会议记录继续主持。") };
      if (!intervention.target_id) {
        this.db.prepare("UPDATE meeting_interventions SET status = 'delivered', delivered_at = ? WHERE id = ?")
          .run(nowIso(), intervention.id);
        continue;
      }
      const turn = this.createMeetingTurn(
        meetingId,
        intervention.target_id,
        "boss",
        "boss",
        `Boss @${intervention.target_id}：${intervention.body}`,
        intervention.id,
      );
      this.db.prepare("UPDATE meeting_interventions SET status = 'delivering' WHERE id = ?").run(intervention.id);
      this.db.prepare("UPDATE meetings SET current_turn_id = ?, waiting_on_host_since = NULL WHERE id = ?").run(turn.id, meetingId);
      return { schedule: this.turnSchedule(meetingId, turn.id, intervention.target_id, `Boss @你：${intervention.body}`) };
    }
  }

  private hostSchedule(meetingId: string, context: string) {
    const meeting = this.getMeetingRow(meetingId);
    return {
      meetingId,
      agentId: meeting.host_id,
      prompt: `${context}\n会议 ID：${meetingId}\n请先调用 company_meeting_status 读取会议记录，再使用 company_meeting_speak、company_meeting_delegate、company_meeting_set_task_drafts 或 company_meeting_end 推进会议。`,
      tag: `company-os-host-${meetingId}`,
    };
  }

  private turnSchedule(meetingId: string, turnId: string, agentId: string, prompt: string) {
    return {
      meetingId,
      agentId,
      turnId,
      prompt: `你是公司会议的当前发言人。\n会议 ID：${meetingId}\n问题：${prompt}\n请阅读 company_meeting_status 后，通过 company_meeting_speak 提交本轮发言。`,
      tag: `company-os-turn-${turnId}`,
    };
  }

  private activateNextMeeting(): MeetingAdvance {
    const next = this.db.prepare("SELECT * FROM meetings WHERE status = 'queued' ORDER BY queue_position, created_at LIMIT 1").get() as Row | undefined;
    if (!next) return {};
    const startedAt = nowIso();
    this.db.prepare(`
      UPDATE meetings SET status = 'active', queue_position = 0, started_at = ?, waiting_on_host_since = ? WHERE id = ?
    `).run(startedAt, startedAt, next.id);
    this.addMeetingMessage(next.id, "system", null, null, "前一场会议已结束，会议室现已开放。");
    this.normalizeMeetingQueue();
    this.audit({ actorId: "system", action: "meeting.activated", entityType: "meeting", entityId: next.id });
    return { activatedMeetingId: next.id, schedule: this.hostSchedule(next.id, "排队会议现已开始，请组织第一轮发言。") };
  }

  private timeoutMeeting(meeting: Row, reason: string): MeetingAdvance {
    const endedAt = nowIso();
    if (meeting.current_turn_id) {
      this.db.prepare("UPDATE meeting_turns SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND status = 'waiting'")
        .run(endedAt, reason, meeting.current_turn_id);
    }
    this.db.prepare(`
      UPDATE meetings SET status = 'timed_out', current_turn_id = NULL, waiting_on_host_since = NULL, ended_at = ? WHERE id = ?
    `).run(endedAt, meeting.id);
    this.addMeetingMessage(meeting.id, "system", null, null, `${reason}，会议已超时结束；未创建任务且未发布会议汇报。`);
    this.audit({ actorId: "system", action: "meeting.timed_out", entityType: "meeting", entityId: meeting.id, reason });
    return this.activateNextMeeting();
  }

  private normalizeMeetingQueue() {
    const queued = this.db.prepare("SELECT id FROM meetings WHERE status = 'queued' ORDER BY queue_position, created_at").all() as Row[];
    queued.forEach((row, index) => this.db.prepare("UPDATE meetings SET queue_position = ? WHERE id = ?").run(index + 1, row.id));
  }

  // ── Unified inbox and Boss snapshot ──────────────────────────────

  inbox(actorId: string) {
    this.requireAgentMember(actorId);
    const assigned = this.db.prepare(`
      SELECT t.* FROM tasks t
      LEFT JOIN task_acknowledgements a ON a.task_id = t.id AND a.member_id = ?
      WHERE t.assignee_id = ? AND t.status IN ('assigned', 'in_progress', 'blocked')
        AND (a.task_id IS NULL OR a.revision < t.revision OR a.seen_at < t.updated_at)
      ORDER BY t.updated_at DESC
    `).all(actorId, actorId) as Row[];
    const review = this.db.prepare(`
      SELECT * FROM tasks WHERE issuer_id = ? AND status = 'review' ORDER BY submitted_at
    `).all(actorId) as Row[];
    const riskRows = this.db.prepare(`
      SELECT * FROM tasks WHERE (issuer_id = ? OR assignee_id = ?) AND status IN ('assigned', 'in_progress', 'blocked')
      ORDER BY updated_at DESC
    `).all(actorId, actorId) as Row[];
    const risks = this.decorateTasks(riskRows).filter((task) => task.status === "blocked" || task.risks.stale || task.risks.blockedDescendants > 0 || task.risks.staleDescendants > 0);
    const unreadNotices = this.db.prepare(`
      SELECT n.* FROM notices n
      LEFT JOIN notices replacement ON replacement.supersedes_notice_id = n.id
      LEFT JOIN notice_reads r ON r.notice_id = n.id AND r.member_id = ?
      WHERE replacement.id IS NULL AND r.notice_id IS NULL ORDER BY n.created_at DESC
    `).all(actorId) as Row[];
    return {
      assignedOrChangedTasks: this.decorateTasks(assigned),
      tasksAwaitingReview: this.decorateTasks(review),
      taskRisks: risks,
      unreadNotices: unreadNotices.map((row) => ({ ...mapNotice(row), activeEmployeeCount: undefined, readCount: undefined })),
      meetings: this.listMeetings(actorId).filter((meeting) => OPEN_MEETING_STATUSES.has(meeting.status)),
      generatedAt: nowIso(),
    };
  }

  bossSnapshot() {
    const meetings = this.listMeetings("boss");
    return {
      organization: this.listMembers(true),
      tasks: this.listTasks("boss"),
      notices: this.listNotices("boss"),
      meetings: {
        active: meetings.find((meeting) => meeting.status === "active") ?? null,
        queue: meetings.filter((meeting) => meeting.status === "queued"),
        history: meetings.filter((meeting) => !OPEN_MEETING_STATUSES.has(meeting.status)),
      },
      generatedAt: nowIso(),
    };
  }
}

function requireOrganizationAdmin(actorId: string) {
  if (actorId !== "main") throw new Error("only agent main can manage organization");
}

function required(value: string | undefined, field: string) {
  const result = value?.trim() ?? "";
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function nowIso() {
  return new Date().toISOString();
}

function toJson(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapMember(row: Row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    name: row.name,
    title: row.title,
    managerId: row.manager_id,
    active: Boolean(row.active),
  };
}

function mapAudit(row: Row) {
  return {
    id: Number(row.id),
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
    createdAt: row.created_at,
  };
}

function mapTaskRow(row: Row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    issuerId: row.issuer_id,
    assigneeId: row.assignee_id,
    sourceMeetingId: row.source_meeting_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status as TaskStatus,
    revision: Number(row.revision),
    blockedReason: row.blocked_reason,
    reviewFeedback: row.review_feedback,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
    closedAt: row.closed_at,
    canceledAt: row.canceled_at,
  };
}

function mapTaskVersion(row: Row) {
  return {
    id: row.id,
    taskId: row.task_id,
    revision: Number(row.revision),
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    changedBy: row.changed_by,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapTaskProgress(row: Row) {
  return { id: row.id, taskId: row.task_id, authorId: row.author_id, body: row.body, createdAt: row.created_at };
}

function mapTaskSubmission(row: Row) {
  return {
    id: row.id,
    taskId: row.task_id,
    submitterId: row.submitter_id,
    summary: row.summary,
    evidence: parseJson<EvidenceInput[]>(row.evidence_json, []),
    status: row.status,
    reviewerId: row.reviewer_id,
    feedback: row.feedback,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

function normalizeEvidence(evidence: EvidenceInput[]) {
  return evidence.map((item, index) => {
    if (item.type !== "proof" && item.type !== "artifact") throw new Error(`evidence[${index}].type is invalid`);
    const normalized = {
      type: item.type,
      label: required(item.label, `evidence[${index}].label`),
      ...(item.note?.trim() ? { note: item.note.trim() } : {}),
      ...(item.command?.trim() ? { command: item.command.trim() } : {}),
      ...(item.url?.trim() ? { url: item.url.trim() } : {}),
      ...(item.path?.trim() ? { path: item.path.trim() } : {}),
    };
    if (!normalized.note && !normalized.command && !normalized.url && !normalized.path) {
      throw new Error(`evidence[${index}] must include note, command, url, or path`);
    }
    return normalized;
  });
}

function isTaskStale(row: Row, now: number, thresholdMs: number) {
  if (row.status !== "assigned" && row.status !== "in_progress") return false;
  return now - Date.parse(row.last_activity_at) >= thresholdMs;
}

function mapNotice(row: Row) {
  return {
    id: row.id,
    authorId: row.author_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    sourceMeetingId: row.source_meeting_id,
    supersedesNoticeId: row.supersedes_notice_id,
    supersededById: row.superseded_by_id ?? null,
    effective: !row.superseded_by_id,
    activeEmployeeCount: row.active_employee_count === undefined ? undefined : Number(row.active_employee_count),
    readCount: row.read_count === undefined ? undefined : Number(row.read_count),
    readAt: row.read_at ?? null,
    createdAt: row.created_at,
  };
}

function mapMeetingMessage(row: Row) {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    authorKind: row.author_kind,
    authorId: row.author_id,
    targetId: row.target_id,
    body: row.body,
    turnId: row.turn_id,
    createdAt: row.created_at,
  };
}

function mapMeetingTurn(row: Row) {
  return {
    id: row.id,
    speakerId: row.speaker_id,
    requestedBy: row.requested_by,
    kind: row.kind,
    prompt: row.prompt,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

function mapTaskDraft(row: Row) {
  return {
    id: row.id,
    position: Number(row.position),
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    assigneeId: row.assignee_id,
  };
}

function dedupeParticipants(participants: MeetingParticipantInput[], hostId: string) {
  const seen = new Set<string>();
  return participants.map((participant, index) => {
    const agentId = required(participant.agentId, `participants[${index}].agentId`);
    if (agentId === hostId) throw new Error("the host must not also be listed as a participant");
    if (seen.has(agentId)) throw new Error(`duplicate participant: ${agentId}`);
    seen.add(agentId);
    if (participant.role !== "worker" && participant.role !== "advisor") throw new Error(`invalid participant role: ${participant.role}`);
    return { agentId, role: participant.role };
  });
}

function meetingReportBody(summary: string, parentTaskId: string, tasks: Array<{ id: string; title: string; assigneeId: string }>) {
  const lines = tasks.map((task) => `- [${task.title}](/tasks?task=${task.id}) → ${task.assigneeId}`);
  return `${summary}\n\n父任务：[${parentTaskId}](/tasks?task=${parentTaskId})\n\n新建子任务：\n${lines.join("\n")}`;
}
