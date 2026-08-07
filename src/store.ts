import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeGitLocation } from "./git-verifier.js";
import type {
  Actor,
  DailyAgentDispatch,
  DailyAgentKind,
  DailyAgentRunSummary,
  DailySelfGovernanceSummary,
  EvidenceInput,
  VerifiedGitLocation,
  MeetingAdvance,
  MeetingCloseoutDispatch,
  MeetingCloseoutOutcome,
  MeetingContextEnvelope,
  MeetingParticipantInput,
  MeetingSessionContextAppend,
  MeetingStatus,
  MeetingToolSessionIdentity,
  MeetingTurnDelivery,
  MeetingTurnDispatch,
  MeetingType,
  NoticeReminderCandidate,
  NoticeReminderDispatch,
  ResolvedCompanyOsConfig,
  ServiceEvent,
  TaskAgentDispatchKind,
  TaskCancelRequest,
  TaskCancellationEvent,
  TaskCorrection,
  TaskCorrectionAction,
  TaskCheckinActionKind,
  TaskCheckinDispatch,
  TaskFlow,
  TaskFlowStageInput,
  TaskFlowStageStatus,
  TaskPromptDispatch,
  TaskPromptPoolItem,
  TaskPromptPoolItemKind,
  TaskPromptPoolSummary,
  TaskReviewReport,
  TaskStatus,
} from "./types.js";
import type {
  BossTaskActionEmailNotification,
  MeetingEmailKind,
  MeetingEmailNotification,
  TaskCheckinEmailItem,
  TaskCheckinEmailNotification,
  TaskReviewEmailNotification,
} from "./email.js";

type Row = Record<string, any>;
type TaskCheckinCandidate = { taskId: string; actionKind: "review" | "execute"; actionAt: string };
type BossTaskCheckinCandidate = { taskId: string; review: boolean; anomaly: boolean };

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["closed", "canceled"]);
const ACTIVE_TASK_STATUSES = new Set<TaskStatus>(["assigned", "in_progress", "review", "blocked"]);
const OPEN_MEETING_STATUSES = new Set<MeetingStatus>(["queued", "active"]);
export const DAILY_SELF_AUDIT_SESSION_NAME = "self-audit";

const DAILY_AGENT_PROMPTS: Record<DailyAgentKind, string> = {
  daily_self_improvement: `这是每日自我反思任务。回顾过去 24 小时的工作：
1. 用 memory_search 搜索最近的相关内容
2. 读取最近的 memory/YYYY-MM-DD.md 文件
3. 用 sessions_history 检查最近的 session 消息
4. 使用 self-improving-agent 技能，将有价值的经验教训记录到 .learnings/ 目录
5. 如果有已验证的规则，promote 到 MEMORY.md
只记录值得记住的内容，不记录日常噪音。完成后简要记录到 memory/YYYY-MM-DD.md。`,
  daily_persona_audit: `这是每日人设文件治理任务。执行 persona-audit 技能：
1. 读取你的 6 个 persona 文件（AGENTS/SOUL/IDENTITY/MEMORY/TOOLS/USER）
2. 检查行数预算、Hook 重复、跨文件矛盾、workspace 清洁度
3. 做 reality sync：检查最近 24h 的 session 和 memory，确保人设文件与真实状态匹配
4. 直接编辑修复问题
5. 报告改动摘要，记录到 memory/YYYY-MM-DD.md`,
};

export class CompanyOsStore {
  readonly db: DatabaseSync;
  private readonly allowedAgentIds: Set<string>;
  private readonly staleAfterMs: number;
  private readonly automaticEndDelayMs: number;
  private readonly taskCheckinConfig: ResolvedCompanyOsConfig["taskHourlyCheckins"];
  private readonly taskPromptConfig: ResolvedCompanyOsConfig["taskRollingPrompts"];
  private readonly noticeReminderConfig: ResolvedCompanyOsConfig["noticeUnreadReminders"];
  private readonly dailySelfImprovementConfig: ResolvedCompanyOsConfig["dailySelfImprovement"];
  private readonly dailyPersonaAuditConfig: ResolvedCompanyOsConfig["dailyPersonaAudit"];
  private readonly bossEmailEnabled: boolean;
  private readonly organizationAdminAgentId: string;
  private readonly onEvent?: (event: ServiceEvent) => void;
  private transactionDepth = 0;
  private pendingEvents: ServiceEvent[] = [];

  constructor(options: {
    databasePath: string;
    allowedAgentIds: Iterable<string>;
    config: ResolvedCompanyOsConfig;
    organizationAdminAgentId?: string;
    onEvent?: (event: ServiceEvent) => void;
  }) {
    mkdirSync(path.dirname(options.databasePath), { recursive: true });
    this.db = new DatabaseSync(options.databasePath);
    this.allowedAgentIds = new Set([...options.allowedAgentIds].map((id) => id.trim()).filter(Boolean));
    this.staleAfterMs = options.config.taskStaleAfterHours * 60 * 60 * 1000;
    this.automaticEndDelayMs = options.config.meetingAutoEndDelaySeconds * 1000;
    this.taskCheckinConfig = options.config.taskHourlyCheckins;
    this.taskPromptConfig = options.config.taskRollingPrompts;
    this.noticeReminderConfig = options.config.noticeUnreadReminders;
    this.dailySelfImprovementConfig = options.config.dailySelfImprovement;
    this.dailyPersonaAuditConfig = options.config.dailyPersonaAudit;
    this.bossEmailEnabled = options.config.bossEmailNotifications.enabled;
    this.onEvent = options.onEvent;
    this.initializeSchema();
    this.organizationAdminAgentId = this.resolveOrganizationAdminAgentId(options.organizationAdminAgentId);
    this.seedOrganization();
    this.reconcileTaskPromptPool();
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
    if (currentVersion > 15) throw new Error(`company-os database schema ${currentVersion} is newer than this plugin supports`);
    if (currentVersion === 15) return;
    if (currentVersion > 0) {
      for (let version = currentVersion; version < 15; version += 1) {
        switch (version) {
          case 1: this.migrateSchemaV2(); break;
          case 2: this.migrateSchemaV3(); break;
          case 3: this.migrateSchemaV4(); break;
          case 4: this.migrateSchemaV5(); break;
          case 5: this.migrateSchemaV6(); break;
          case 6: this.migrateSchemaV7(); break;
          case 7: this.migrateSchemaV8(); break;
          case 8: this.migrateSchemaV9(); break;
          case 9: this.migrateSchemaV10(); break;
          case 10: this.migrateSchemaV11(); break;
          case 11: this.migrateSchemaV12(); break;
          case 12: this.migrateSchemaV13(); break;
          case 13: this.migrateSchemaV14(); break;
          case 14: this.migrateSchemaV15(); break;
          default: throw new Error(`company-os database schema ${version} has no migration path`);
        }
      }
      return;
    }
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
        blocked_at TEXT,
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
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'invalidated')),
        reviewer_id TEXT,
        feedback TEXT,
        review_report_json TEXT,
        git_remote_url TEXT,
        git_branch TEXT,
        git_commit TEXT,
        git_verified_at TEXT,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_review_email_notifications (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        submission_id TEXT NOT NULL UNIQUE REFERENCES task_submissions(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_acknowledgements (
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY(member_id, task_id)
      );

      CREATE TABLE IF NOT EXISTS task_agent_dispatches (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_agent_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK (kind IN (
          'boss_reminder', 'review_accepted', 'review_rejected', 'block_escalated', 'block_guidance',
          'cancel_request_accepted', 'cancel_request_rejected', 'acceptance_revoked', 'cancellation_restored',
          'submission_git_required'
        )),
        source_event_id TEXT,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_checkin_runs (
        id TEXT PRIMARY KEY,
        slot_key TEXT NOT NULL UNIQUE,
        scheduled_at TEXT NOT NULL,
        local_date TEXT NOT NULL,
        local_hour INTEGER NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_checkin_batches (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES task_checkin_runs(id) ON DELETE CASCADE,
        target_member_id TEXT NOT NULL REFERENCES members(id),
        channel TEXT NOT NULL CHECK (channel IN ('agent', 'boss_email')),
        candidate_json TEXT NOT NULL,
        candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
        created_at TEXT NOT NULL,
        UNIQUE(run_id, target_member_id, channel)
      );

      CREATE TABLE IF NOT EXISTS task_checkin_dispatches (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES task_checkin_runs(id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL REFERENCES task_checkin_batches(id) ON DELETE CASCADE,
        target_member_id TEXT NOT NULL REFERENCES members(id),
        channel TEXT NOT NULL CHECK (channel IN ('agent', 'boss_email')),
        slot_index INTEGER NOT NULL CHECK (slot_index BETWEEN 0 AND 2),
        scheduled_at TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id),
        action_kind TEXT CHECK (action_kind IN ('review', 'execute', 'boss_digest')),
        prompt TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'canceled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(batch_id, slot_index)
      );

      CREATE TABLE IF NOT EXISTS task_review_inspections (
        submission_id TEXT NOT NULL REFERENCES task_submissions(id) ON DELETE CASCADE,
        reviewer_id TEXT NOT NULL REFERENCES members(id),
        read_at TEXT NOT NULL,
        PRIMARY KEY(submission_id, reviewer_id)
      );

      CREATE TABLE IF NOT EXISTS task_cancel_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        requester_id TEXT NOT NULL REFERENCES members(id),
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'canceled')),
        reviewer_id TEXT REFERENCES members(id),
        feedback TEXT,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_cancellation_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL REFERENCES members(id),
        request_id TEXT REFERENCES task_cancel_requests(id),
        status_before TEXT NOT NULL CHECK (status_before IN ('assigned', 'in_progress', 'review', 'blocked')),
        reason TEXT NOT NULL,
        canceled_at TEXT NOT NULL,
        restored_by TEXT REFERENCES members(id),
        restored_reason TEXT,
        restored_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_corrections (
        id TEXT PRIMARY KEY,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('acceptance_revoked', 'cancellation_restored')),
        actor_id TEXT NOT NULL REFERENCES members(id),
        reason TEXT NOT NULL,
        report_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_correction_impacts (
        correction_id TEXT NOT NULL REFERENCES task_corrections(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('target', 'ancestor')),
        status_before TEXT NOT NULL,
        status_after TEXT NOT NULL,
        submission_id TEXT REFERENCES task_submissions(id),
        PRIMARY KEY(correction_id, task_id)
      );

      CREATE TABLE IF NOT EXISTS boss_task_action_email_notifications (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('block_escalated', 'cancel_requested')),
        source_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        UNIQUE(kind, source_id)
      );

      CREATE TABLE IF NOT EXISTS task_prompt_pool_items (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('execution', 'review', 'blocked_review')),
        queue_seq INTEGER NOT NULL CHECK (queue_seq > 0),
        enqueued_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_prompted_at TEXT,
        prompt_count INTEGER NOT NULL DEFAULT 0 CHECK (prompt_count >= 0),
        UNIQUE(member_id, task_id, kind),
        UNIQUE(member_id, queue_seq)
      );

      CREATE TABLE IF NOT EXISTS task_prompt_ticks (
        id TEXT PRIMARY KEY,
        slot_key TEXT NOT NULL UNIQUE,
        scheduled_at TEXT NOT NULL,
        local_date TEXT NOT NULL,
        local_hour INTEGER NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
        local_minute INTEGER NOT NULL CHECK (local_minute IN (0, 20, 40)),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_prompt_dispatches (
        id TEXT PRIMARY KEY,
        tick_id TEXT NOT NULL REFERENCES task_prompt_ticks(id) ON DELETE CASCADE,
        pool_item_id TEXT REFERENCES task_prompt_pool_items(id) ON DELETE SET NULL,
        target_member_id TEXT NOT NULL REFERENCES members(id),
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        kind TEXT CHECK (kind IN ('execution', 'review', 'blocked_review')),
        scheduled_at TEXT NOT NULL,
        prompt TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped_busy', 'skipped_empty', 'skipped_offline', 'canceled')),
        started INTEGER NOT NULL DEFAULT 0 CHECK (started IN (0, 1)),
        last_error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(tick_id, target_member_id)
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

      CREATE TABLE IF NOT EXISTS notice_reminder_runs (
        id TEXT PRIMARY KEY,
        slot_key TEXT NOT NULL UNIQUE,
        scheduled_at TEXT NOT NULL,
        local_date TEXT NOT NULL,
        local_hour INTEGER NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notice_reminder_dispatches (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES notice_reminder_runs(id) ON DELETE CASCADE,
        target_member_id TEXT NOT NULL REFERENCES members(id),
        scheduled_at TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
        prompt TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'canceled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(run_id, target_member_id)
      );

      CREATE TABLE IF NOT EXISTS daily_agent_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('daily_self_improvement', 'daily_persona_audit')),
        slot_key TEXT NOT NULL UNIQUE,
        scheduled_at TEXT NOT NULL,
        local_date TEXT NOT NULL,
        local_hour INTEGER NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
        local_minute INTEGER NOT NULL CHECK (local_minute BETWEEN 0 AND 59),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_agent_dispatches (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES daily_agent_runs(id) ON DELETE CASCADE,
        target_member_id TEXT NOT NULL REFERENCES members(id),
        position INTEGER NOT NULL CHECK (position >= 0),
        scheduled_at TEXT NOT NULL,
        session_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(run_id, target_member_id)
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
        boss_participates INTEGER NOT NULL DEFAULT 0 CHECK (boss_participates IN (0, 1)),
        boss_started_at TEXT,
        end_requested_at TEXT,
        end_requested_summary TEXT,
        end_requested_publish_notice INTEGER NOT NULL DEFAULT 0 CHECK (end_requested_publish_notice IN (0, 1)),
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
        completion_source TEXT CHECK (completion_source IN ('tool', 'fallback')),
        context_from_sequence INTEGER NOT NULL DEFAULT 0,
        context_to_sequence INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS meeting_email_notifications (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('created', 'room_entered')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        UNIQUE(meeting_id, kind)
      );

      CREATE TABLE IF NOT EXISTS meeting_context_watermarks (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id),
        sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(meeting_id, member_id)
      );

      CREATE TABLE IF NOT EXISTS meeting_session_context_appends (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id),
        runtime_agent_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL CHECK (tool_name IN ('company_meeting_speak', 'company_meeting_delegate')),
        tool_call_id TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES meeting_messages(id) ON DELETE CASCADE,
        message_sequence INTEGER NOT NULL CHECK (message_sequence > 0),
        turn_id TEXT,
        round_number INTEGER CHECK (round_number IS NULL OR round_number > 0),
        record_kind TEXT NOT NULL CHECK (record_kind IN ('speech', 'delegate', 'host_speech')),
        target_id TEXT REFERENCES members(id),
        target_name TEXT,
        member_name TEXT NOT NULL,
        body TEXT NOT NULL,
        formatted_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'appending', 'appended', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        appended_message_id TEXT,
        created_at TEXT NOT NULL,
        appended_at TEXT,
        UNIQUE(session_id, tool_call_id)
      );

      CREATE TABLE IF NOT EXISTS meeting_agent_dispatches (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('host_start', 'host_resume', 'host_recovery')),
        target_agent_id TEXT NOT NULL REFERENCES members(id),
        reason TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        context_from_sequence INTEGER,
        context_to_sequence INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        lease_expires_at TEXT,
        wait_for_context_append_id TEXT REFERENCES meeting_session_context_appends(id),
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS meeting_closeout_dispatches (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id),
        runtime_agent_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'canceled', 'timed_out')),
        blocks_room INTEGER NOT NULL DEFAULT 0 CHECK (blocks_room IN (0, 1)),
        position INTEGER NOT NULL,
        context_from_sequence INTEGER NOT NULL DEFAULT 0 CHECK (context_from_sequence >= 0),
        context_to_sequence INTEGER NOT NULL DEFAULT 0 CHECK (context_to_sequence >= 0),
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT NOT NULL,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(meeting_id, member_id)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(assignee_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_issuer_status ON tasks(issuer_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_dispatch_pending ON task_agent_dispatches(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_review_email_pending
        ON task_review_email_notifications(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_checkin_dispatch_due
        ON task_checkin_dispatches(status, scheduled_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_checkin_rotation
        ON task_checkin_dispatches(target_member_id, status, completed_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_cancel_request_pending
        ON task_cancel_requests(task_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_task_prompt_pool_head
        ON task_prompt_pool_items(member_id, queue_seq);
      CREATE INDEX IF NOT EXISTS idx_task_prompt_dispatch_tick
        ON task_prompt_dispatches(tick_id, target_member_id);
      CREATE INDEX IF NOT EXISTS idx_boss_task_action_email_pending
        ON boss_task_action_email_notifications(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_notices_created ON notices(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notice_reminder_dispatch_due
        ON notice_reminder_dispatches(status, scheduled_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_daily_agent_dispatch_due
        ON daily_agent_dispatches(status, scheduled_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_meetings_status_queue ON meetings(status, queue_position);
      CREATE INDEX IF NOT EXISTS idx_meeting_messages_sequence ON meeting_messages(meeting_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_meeting_email_pending ON meeting_email_notifications(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_meeting_context_append_pending ON meeting_session_context_appends(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_meeting_dispatch_pending ON meeting_agent_dispatches(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_meeting_closeout_pending
        ON meeting_closeout_dispatches(status, blocks_room DESC, next_attempt_at, position);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_meeting ON meetings(status) WHERE status = 'active';
      `);
      this.createSchemaV15Tables();
      this.db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '15')").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV2() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        ALTER TABLE meetings ADD COLUMN boss_participates INTEGER NOT NULL DEFAULT 0 CHECK (boss_participates IN (0, 1));
        ALTER TABLE meetings ADD COLUMN boss_started_at TEXT;
        ALTER TABLE meetings ADD COLUMN end_requested_at TEXT;
        ALTER TABLE meetings ADD COLUMN end_requested_summary TEXT;
        ALTER TABLE meetings ADD COLUMN end_requested_publish_notice INTEGER NOT NULL DEFAULT 0 CHECK (end_requested_publish_notice IN (0, 1));

        CREATE TABLE meeting_email_notifications (
          id TEXT PRIMARY KEY,
          meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('created', 'room_entered')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          sent_at TEXT,
          UNIQUE(meeting_id, kind)
        );
        CREATE INDEX idx_meeting_email_pending ON meeting_email_notifications(status, created_at);
      `);
      this.db.prepare("UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV3() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.tableExists("meeting_turns") && !this.columnExists("meeting_turns", "completion_source")) {
        this.db.exec("ALTER TABLE meeting_turns ADD COLUMN completion_source TEXT CHECK (completion_source IN ('tool', 'fallback'))");
      }
      if (this.tableExists("meeting_turns") && !this.columnExists("meeting_turns", "context_from_sequence")) {
        this.db.exec("ALTER TABLE meeting_turns ADD COLUMN context_from_sequence INTEGER NOT NULL DEFAULT 0");
      }
      if (this.tableExists("meeting_turns") && !this.columnExists("meeting_turns", "context_to_sequence")) {
        this.db.exec("ALTER TABLE meeting_turns ADD COLUMN context_to_sequence INTEGER NOT NULL DEFAULT 0");
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meeting_context_watermarks (
          meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES members(id),
          sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(meeting_id, member_id)
        );
        CREATE TABLE IF NOT EXISTS meeting_agent_dispatches (
          id TEXT PRIMARY KEY,
          meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('host_start', 'host_resume', 'host_recovery')),
          target_agent_id TEXT NOT NULL REFERENCES members(id),
          reason TEXT NOT NULL,
          dedupe_key TEXT NOT NULL UNIQUE,
          context_from_sequence INTEGER,
          context_to_sequence INTEGER,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_dispatch_pending ON meeting_agent_dispatches(status, created_at);
      `);
      this.db.prepare("UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV4() {
    const memberReferences: Array<[string, string]> = [
      ["members", "manager_id"],
      ["tasks", "issuer_id"],
      ["tasks", "assignee_id"],
      ["task_versions", "changed_by"],
      ["task_progress", "author_id"],
      ["task_submissions", "submitter_id"],
      ["task_submissions", "reviewer_id"],
      ["task_acknowledgements", "member_id"],
      ["notices", "author_id"],
      ["notice_reads", "member_id"],
      ["meetings", "host_id"],
      ["meetings", "requested_by"],
      ["meeting_participants", "member_id"],
      ["meeting_messages", "author_id"],
      ["meeting_messages", "target_id"],
      ["meeting_turns", "speaker_id"],
      ["meeting_turns", "requested_by"],
      ["meeting_interventions", "target_id"],
      ["meeting_task_drafts", "assignee_id"],
      ["meeting_context_watermarks", "member_id"],
      ["meeting_agent_dispatches", "target_agent_id"],
      ["audit_events", "actor_id"],
    ];
    for (const table of this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Row[]) {
      for (const foreignKey of this.db.prepare(`PRAGMA foreign_key_list(${table.name})`).all() as Row[]) {
        if (foreignKey.table === "members") memberReferences.push([String(table.name), String(foreignKey.from)]);
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("PRAGMA defer_foreign_keys = ON");
      const aliases = this.tableExists("members")
        ? this.db.prepare("SELECT id, agent_id FROM members WHERE kind = 'agent' AND agent_id IS NOT NULL AND id != agent_id").all() as Row[]
        : [];
      for (const alias of aliases) {
        const oldId = String(alias.id);
        const agentId = String(alias.agent_id);
        if (!this.allowedAgentIds.has(agentId)) continue;
        const conflict = this.db.prepare("SELECT id FROM members WHERE id = ? AND id != ?").get(agentId, oldId);
        if (conflict) throw new Error(`cannot normalize member ${oldId} to Agent ID ${agentId}: target member already exists`);
        for (const [table, column] of new Map(memberReferences.map((entry) => [entry.join("."), entry] as const)).values()) {
          if (this.tableExists(table) && this.columnExists(table, column)) {
            this.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(agentId, oldId);
          }
        }
        if (this.tableExists("audit_events")) {
          this.db.prepare("UPDATE audit_events SET entity_id = ? WHERE entity_type = 'member' AND entity_id = ?").run(agentId, oldId);
        }
        this.db.prepare("UPDATE members SET id = ? WHERE id = ?").run(agentId, oldId);
        this.db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'organization_admin_id' AND value = ?").run(agentId, oldId);
        if (this.tableExists("audit_events")) {
          this.db.prepare(`
            INSERT INTO audit_events (actor_id, action, entity_type, entity_id, reason, before_json, after_json, created_at)
            VALUES ('system', 'org.member_id_normalized', 'member', ?, ?, ?, ?, ?)
          `).run(
            agentId,
            "organization member IDs now equal their configured OpenClaw Agent IDs",
            JSON.stringify({ id: oldId, agentId }),
            JSON.stringify({ id: agentId, agentId }),
            nowIso(),
          );
        }
      }
      const violations = this.db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) throw new Error(`company-os v4 member ID migration violated foreign keys: ${JSON.stringify(violations)}`);
      this.db.prepare("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV5() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meeting_session_context_appends (
          id TEXT PRIMARY KEY,
          meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES members(id),
          runtime_agent_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL CHECK (tool_name IN ('company_meeting_speak', 'company_meeting_delegate')),
          tool_call_id TEXT NOT NULL,
          message_id TEXT NOT NULL REFERENCES meeting_messages(id) ON DELETE CASCADE,
          message_sequence INTEGER NOT NULL CHECK (message_sequence > 0),
          turn_id TEXT,
          round_number INTEGER CHECK (round_number IS NULL OR round_number > 0),
          record_kind TEXT NOT NULL CHECK (record_kind IN ('speech', 'delegate', 'host_speech')),
          target_id TEXT REFERENCES members(id),
          target_name TEXT,
          member_name TEXT NOT NULL,
          body TEXT NOT NULL,
          formatted_text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'appending', 'appended', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          appended_message_id TEXT,
          created_at TEXT NOT NULL,
          appended_at TEXT,
          UNIQUE(session_id, tool_call_id)
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_context_append_pending
          ON meeting_session_context_appends(status, created_at);
      `);
      if (!this.columnExists("meeting_agent_dispatches", "wait_for_context_append_id")) {
        this.db.exec("ALTER TABLE meeting_agent_dispatches ADD COLUMN wait_for_context_append_id TEXT REFERENCES meeting_session_context_appends(id)");
      }
      this.db.prepare("UPDATE schema_meta SET value = '5' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV6() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_agent_dispatches (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          target_agent_id TEXT NOT NULL REFERENCES members(id),
          kind TEXT NOT NULL CHECK (kind = 'boss_reminder'),
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_task_dispatch_pending
          ON task_agent_dispatches(status, created_at);
      `);
      this.db.prepare("UPDATE schema_meta SET value = '6' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV7() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meeting_closeout_dispatches (
          id TEXT PRIMARY KEY,
          meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES members(id),
          runtime_agent_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'canceled', 'timed_out')),
          blocks_room INTEGER NOT NULL DEFAULT 0 CHECK (blocks_room IN (0, 1)),
          position INTEGER NOT NULL,
          context_from_sequence INTEGER NOT NULL DEFAULT 0 CHECK (context_from_sequence >= 0),
          context_to_sequence INTEGER NOT NULL DEFAULT 0 CHECK (context_to_sequence >= 0),
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          next_attempt_at TEXT NOT NULL,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          UNIQUE(meeting_id, member_id)
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_closeout_pending
          ON meeting_closeout_dispatches(status, blocks_room DESC, next_attempt_at, position);
      `);
      this.db.prepare("UPDATE schema_meta SET value = '7' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV8() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        DROP INDEX IF EXISTS idx_task_dispatch_pending;
        ALTER TABLE task_agent_dispatches RENAME TO task_agent_dispatches_v7;
        CREATE TABLE task_agent_dispatches (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          target_agent_id TEXT NOT NULL REFERENCES members(id),
          kind TEXT NOT NULL CHECK (kind IN ('boss_reminder', 'review_accepted', 'review_rejected')),
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        INSERT INTO task_agent_dispatches (
          id, task_id, target_agent_id, kind, prompt, status, attempts, last_error,
          lease_expires_at, created_at, started_at, completed_at
        )
        SELECT
          id, task_id, target_agent_id, kind, prompt, status, attempts, last_error,
          lease_expires_at, created_at, started_at, completed_at
        FROM task_agent_dispatches_v7;
        DROP TABLE task_agent_dispatches_v7;
        CREATE INDEX idx_task_dispatch_pending ON task_agent_dispatches(status, created_at);
      `);
      this.db.prepare("UPDATE schema_meta SET value = '8' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV9() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_checkin_runs (
          id TEXT PRIMARY KEY,
          slot_key TEXT NOT NULL UNIQUE,
          scheduled_at TEXT NOT NULL,
          local_date TEXT NOT NULL,
          local_hour INTEGER NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_checkin_batches (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES task_checkin_runs(id) ON DELETE CASCADE,
          target_member_id TEXT NOT NULL REFERENCES members(id),
          channel TEXT NOT NULL CHECK (channel IN ('agent', 'boss_email')),
          candidate_json TEXT NOT NULL,
          candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
          created_at TEXT NOT NULL,
          UNIQUE(run_id, target_member_id, channel)
        );
        CREATE TABLE IF NOT EXISTS task_checkin_dispatches (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES task_checkin_runs(id) ON DELETE CASCADE,
          batch_id TEXT NOT NULL REFERENCES task_checkin_batches(id) ON DELETE CASCADE,
          target_member_id TEXT NOT NULL REFERENCES members(id),
          channel TEXT NOT NULL CHECK (channel IN ('agent', 'boss_email')),
          slot_index INTEGER NOT NULL CHECK (slot_index BETWEEN 0 AND 2),
          scheduled_at TEXT NOT NULL,
          task_id TEXT REFERENCES tasks(id),
          action_kind TEXT CHECK (action_kind IN ('review', 'execute', 'boss_digest')),
          prompt TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'canceled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          UNIQUE(batch_id, slot_index)
        );
        CREATE INDEX IF NOT EXISTS idx_task_checkin_dispatch_due
          ON task_checkin_dispatches(status, scheduled_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_task_checkin_rotation
          ON task_checkin_dispatches(target_member_id, status, completed_at);
      `);
      this.db.prepare("UPDATE schema_meta SET value = '9' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV10() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS notice_reminder_runs (
          id TEXT PRIMARY KEY,
          slot_key TEXT NOT NULL UNIQUE,
          scheduled_at TEXT NOT NULL,
          local_date TEXT NOT NULL,
          local_hour INTEGER NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notice_reminder_dispatches (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES notice_reminder_runs(id) ON DELETE CASCADE,
          target_member_id TEXT NOT NULL REFERENCES members(id),
          scheduled_at TEXT NOT NULL,
          candidate_json TEXT NOT NULL,
          candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
          prompt TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'canceled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          UNIQUE(run_id, target_member_id)
        );
        CREATE INDEX IF NOT EXISTS idx_notice_reminder_dispatch_due
          ON notice_reminder_dispatches(status, scheduled_at, created_at);
      `);
      this.db.prepare("UPDATE schema_meta SET value = '10' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV11() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_review_email_notifications (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          submission_id TEXT NOT NULL UNIQUE REFERENCES task_submissions(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          sent_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_task_review_email_pending
          ON task_review_email_notifications(status, created_at);
      `);
      this.db.prepare("UPDATE schema_meta SET value = '11' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV12() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS daily_agent_runs (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('daily_self_improvement', 'daily_persona_audit')),
          slot_key TEXT NOT NULL UNIQUE,
          scheduled_at TEXT NOT NULL,
          local_date TEXT NOT NULL,
          local_hour INTEGER NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
          local_minute INTEGER NOT NULL CHECK (local_minute BETWEEN 0 AND 59),
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS daily_agent_dispatches (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES daily_agent_runs(id) ON DELETE CASCADE,
          target_member_id TEXT NOT NULL REFERENCES members(id),
          position INTEGER NOT NULL CHECK (position >= 0),
          scheduled_at TEXT NOT NULL,
          session_key TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          UNIQUE(run_id, target_member_id)
        );
        CREATE INDEX IF NOT EXISTS idx_daily_agent_dispatch_due
          ON daily_agent_dispatches(status, scheduled_at, created_at);
      `);
      this.db.prepare("UPDATE schema_meta SET value = '12' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV13() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // These tables cannot exist in a real v12 database. Dropping them makes the
      // migration idempotent for development databases whose schema version was
      // intentionally rolled back while exercising older migration paths.
      this.db.exec(`
        DROP TABLE IF EXISTS task_prompt_dispatches;
        DROP TABLE IF EXISTS task_prompt_ticks;
        DROP TABLE IF EXISTS task_prompt_pool_items;
        DROP TABLE IF EXISTS boss_task_action_email_notifications;
        DROP TABLE IF EXISTS task_correction_impacts;
        DROP TABLE IF EXISTS task_corrections;
        DROP TABLE IF EXISTS task_cancellation_events;
        DROP TABLE IF EXISTS task_cancel_requests;
        DROP TABLE IF EXISTS task_review_inspections;
      `);
      if (!this.columnExists("tasks", "blocked_at")) {
        this.db.exec("ALTER TABLE tasks ADD COLUMN blocked_at TEXT");
      }
      if (!this.tableExists("task_submissions")) {
        this.db.exec(`
          CREATE TABLE task_submissions (
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
        `);
      }
      const blockedActivityColumn = this.columnExists("tasks", "last_activity_at")
        ? "last_activity_at"
        : this.columnExists("tasks", "updated_at")
          ? "updated_at"
          : null;
      if (blockedActivityColumn && this.columnExists("tasks", "status")) {
        this.db.exec(`UPDATE tasks SET blocked_at = COALESCE(blocked_at, ${blockedActivityColumn}) WHERE status = 'blocked'`);
      }
      this.db.exec(`
        DROP INDEX IF EXISTS idx_task_review_email_pending;
        ALTER TABLE task_review_email_notifications RENAME TO task_review_email_notifications_v12;
        ALTER TABLE task_submissions RENAME TO task_submissions_v12;
        CREATE TABLE task_submissions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          submitter_id TEXT NOT NULL REFERENCES members(id),
          summary TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'invalidated')),
          reviewer_id TEXT,
          feedback TEXT,
          review_report_json TEXT,
          created_at TEXT NOT NULL,
          reviewed_at TEXT
        );
        INSERT INTO task_submissions (
          id, task_id, submitter_id, summary, evidence_json, status, reviewer_id,
          feedback, review_report_json, created_at, reviewed_at
        )
        SELECT id, task_id, submitter_id, summary, evidence_json, status, reviewer_id,
          feedback, NULL, created_at, reviewed_at
        FROM task_submissions_v12;
        CREATE TABLE task_review_email_notifications (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          submission_id TEXT NOT NULL UNIQUE REFERENCES task_submissions(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          sent_at TEXT
        );
        INSERT INTO task_review_email_notifications
          (id, task_id, submission_id, status, attempts, last_error, created_at, sent_at)
        SELECT id, task_id, submission_id, status, attempts, last_error, created_at, sent_at
        FROM task_review_email_notifications_v12;
        DROP TABLE task_review_email_notifications_v12;
        DROP TABLE task_submissions_v12;
        CREATE INDEX idx_task_review_email_pending
          ON task_review_email_notifications(status, created_at);

        DROP INDEX IF EXISTS idx_task_dispatch_pending;
        ALTER TABLE task_agent_dispatches RENAME TO task_agent_dispatches_v12;
        CREATE TABLE task_agent_dispatches (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          target_agent_id TEXT NOT NULL REFERENCES members(id),
          kind TEXT NOT NULL CHECK (kind IN (
            'boss_reminder', 'review_accepted', 'review_rejected', 'block_escalated', 'block_guidance',
            'cancel_request_accepted', 'cancel_request_rejected', 'acceptance_revoked', 'cancellation_restored'
          )),
          source_event_id TEXT,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        INSERT INTO task_agent_dispatches (
          id, task_id, target_agent_id, kind, source_event_id, prompt, status, attempts,
          last_error, lease_expires_at, created_at, started_at, completed_at
        )
        SELECT id, task_id, target_agent_id, kind, NULL, prompt, status, attempts,
          last_error, lease_expires_at, created_at, started_at, completed_at
        FROM task_agent_dispatches_v12;
        DROP TABLE task_agent_dispatches_v12;
        CREATE INDEX idx_task_dispatch_pending ON task_agent_dispatches(status, created_at);
        CREATE UNIQUE INDEX idx_task_dispatch_source_target
          ON task_agent_dispatches(kind, source_event_id, target_agent_id)
          WHERE source_event_id IS NOT NULL;

        CREATE TABLE task_review_inspections (
          submission_id TEXT NOT NULL REFERENCES task_submissions(id) ON DELETE CASCADE,
          reviewer_id TEXT NOT NULL REFERENCES members(id),
          read_at TEXT NOT NULL,
          PRIMARY KEY(submission_id, reviewer_id)
        );
        CREATE TABLE task_cancel_requests (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          requester_id TEXT NOT NULL REFERENCES members(id),
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'canceled')),
          reviewer_id TEXT REFERENCES members(id),
          feedback TEXT,
          created_at TEXT NOT NULL,
          reviewed_at TEXT
        );
        CREATE UNIQUE INDEX idx_task_cancel_request_pending
          ON task_cancel_requests(task_id) WHERE status = 'pending';
        CREATE TABLE task_cancellation_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          actor_id TEXT NOT NULL REFERENCES members(id),
          request_id TEXT REFERENCES task_cancel_requests(id),
          status_before TEXT NOT NULL CHECK (status_before IN ('assigned', 'in_progress', 'review', 'blocked')),
          reason TEXT NOT NULL,
          canceled_at TEXT NOT NULL,
          restored_by TEXT REFERENCES members(id),
          restored_reason TEXT,
          restored_at TEXT
        );
        CREATE TABLE task_corrections (
          id TEXT PRIMARY KEY,
          target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('acceptance_revoked', 'cancellation_restored')),
          actor_id TEXT NOT NULL REFERENCES members(id),
          reason TEXT NOT NULL,
          report_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE task_correction_impacts (
          correction_id TEXT NOT NULL REFERENCES task_corrections(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('target', 'ancestor')),
          status_before TEXT NOT NULL,
          status_after TEXT NOT NULL,
          submission_id TEXT REFERENCES task_submissions(id),
          PRIMARY KEY(correction_id, task_id)
        );
        CREATE TABLE boss_task_action_email_notifications (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('block_escalated', 'cancel_requested')),
          source_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          sent_at TEXT,
          UNIQUE(kind, source_id)
        );
        CREATE INDEX idx_boss_task_action_email_pending
          ON boss_task_action_email_notifications(status, created_at);

        CREATE TABLE task_prompt_pool_items (
          id TEXT PRIMARY KEY,
          member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('execution', 'review', 'blocked_review')),
          queue_seq INTEGER NOT NULL CHECK (queue_seq > 0),
          enqueued_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_prompted_at TEXT,
          prompt_count INTEGER NOT NULL DEFAULT 0 CHECK (prompt_count >= 0),
          UNIQUE(member_id, task_id, kind),
          UNIQUE(member_id, queue_seq)
        );
        CREATE INDEX idx_task_prompt_pool_head ON task_prompt_pool_items(member_id, queue_seq);
        CREATE TABLE task_prompt_ticks (
          id TEXT PRIMARY KEY,
          slot_key TEXT NOT NULL UNIQUE,
          scheduled_at TEXT NOT NULL,
          local_date TEXT NOT NULL,
          local_hour INTEGER NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
          local_minute INTEGER NOT NULL CHECK (local_minute IN (0, 20, 40)),
          created_at TEXT NOT NULL
        );
        CREATE TABLE task_prompt_dispatches (
          id TEXT PRIMARY KEY,
          tick_id TEXT NOT NULL REFERENCES task_prompt_ticks(id) ON DELETE CASCADE,
          pool_item_id TEXT REFERENCES task_prompt_pool_items(id) ON DELETE SET NULL,
          target_member_id TEXT NOT NULL REFERENCES members(id),
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          kind TEXT CHECK (kind IN ('execution', 'review', 'blocked_review')),
          scheduled_at TEXT NOT NULL,
          prompt TEXT,
          status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped_busy', 'skipped_empty', 'canceled')),
          started INTEGER NOT NULL DEFAULT 0 CHECK (started IN (0, 1)),
          last_error TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          UNIQUE(tick_id, target_member_id)
        );
        CREATE INDEX idx_task_prompt_dispatch_tick ON task_prompt_dispatches(tick_id, target_member_id);
      `);
      this.db.prepare("UPDATE schema_meta SET value = '13' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV14() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        ALTER TABLE task_submissions ADD COLUMN git_remote_url TEXT;
        ALTER TABLE task_submissions ADD COLUMN git_branch TEXT;
        ALTER TABLE task_submissions ADD COLUMN git_commit TEXT;
        ALTER TABLE task_submissions ADD COLUMN git_verified_at TEXT;

        DROP INDEX IF EXISTS idx_task_dispatch_pending;
        DROP INDEX IF EXISTS idx_task_dispatch_source_target;
        ALTER TABLE task_agent_dispatches RENAME TO task_agent_dispatches_v13;
        CREATE TABLE task_agent_dispatches (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          target_agent_id TEXT NOT NULL REFERENCES members(id),
          kind TEXT NOT NULL CHECK (kind IN (
            'boss_reminder', 'review_accepted', 'review_rejected', 'block_escalated', 'block_guidance',
            'cancel_request_accepted', 'cancel_request_rejected', 'acceptance_revoked', 'cancellation_restored',
            'submission_git_required'
          )),
          source_event_id TEXT,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        INSERT INTO task_agent_dispatches (
          id, task_id, target_agent_id, kind, source_event_id, prompt, status, attempts,
          last_error, lease_expires_at, created_at, started_at, completed_at
        )
        SELECT id, task_id, target_agent_id, kind, source_event_id, prompt, status, attempts,
          last_error, lease_expires_at, created_at, started_at, completed_at
        FROM task_agent_dispatches_v13;
        DROP TABLE task_agent_dispatches_v13;
        CREATE INDEX idx_task_dispatch_pending ON task_agent_dispatches(status, created_at);
        CREATE UNIQUE INDEX idx_task_dispatch_source_target
          ON task_agent_dispatches(kind, source_event_id, target_agent_id)
          WHERE source_event_id IS NOT NULL;
      `);

      const canInvalidateLegacyPending = this.columnExists("tasks", "status")
        && this.columnExists("task_submissions", "status")
        && this.columnExists("task_submissions", "submitter_id");
      const legacyPending = canInvalidateLegacyPending ? this.db.prepare(`
        SELECT s.id AS submission_id, s.task_id, s.submitter_id, t.status AS task_status
        FROM task_submissions s
        JOIN tasks t ON t.id = s.task_id
        WHERE s.status = 'pending'
          AND (s.git_remote_url IS NULL OR s.git_branch IS NULL OR s.git_commit IS NULL OR s.git_verified_at IS NULL)
        ORDER BY s.created_at, s.rowid
      `).all() as Row[] : [];
      const invalidatedAt = nowIso();
      const feedback = "Submission invalidated by schema v14: a remotely verified gitLocation is required";
      for (const row of legacyPending) {
        this.db.prepare(`
          UPDATE task_submissions SET status = 'invalidated', reviewer_id = NULL,
            feedback = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'
        `).run(feedback, invalidatedAt, row.submission_id);
        if (row.task_status === "review") {
          this.db.prepare(`
            UPDATE tasks SET status = 'in_progress', submitted_at = NULL, review_feedback = ?,
              updated_at = ?, last_activity_at = ? WHERE id = ? AND status = 'review'
          `).run(feedback, invalidatedAt, invalidatedAt, row.task_id);
        }
        this.db.prepare(`
          DELETE FROM task_review_email_notifications WHERE submission_id = ? AND status != 'sent'
        `).run(row.submission_id);
        const prompt = [
          "【Company OS 任务提交格式升级】",
          `任务 ID：${row.task_id}`,
          `原 submission ID：${row.submission_id}`,
          "原待验收提交已失效，因为缺少经过远端验证的 Git 分支定位。",
          "请读取最新任务，确认成果已经推送到远端分支，并重新调用 company_task_submit。",
          "新提交必须包含 gitLocation.remoteUrl、gitLocation.branch，以及等于该远端分支当前 tip 的 40 位 gitLocation.commit。",
          "请实际重新提交，不要只回复已收到。",
        ].join("\n");
        this.insertTaskAgentDispatch(
          row.task_id,
          row.submitter_id,
          "submission_git_required",
          prompt,
          invalidatedAt,
          row.submission_id,
        );
        this.audit({
          actorId: "system",
          action: "task.submission_invalidated_git_required",
          entityType: "task",
          entityId: row.task_id,
          reason: feedback,
          after: { submissionId: row.submission_id },
        });
      }
      this.db.prepare("UPDATE schema_meta SET value = '14' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSchemaV15() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.createSchemaV15Tables();
      const now = nowIso();
      const parents = this.columnExists("tasks", "parent_id") ? this.db.prepare(`
        SELECT DISTINCT parent_id FROM tasks WHERE parent_id IS NOT NULL ORDER BY parent_id
      `).all() as Row[] : [];
      for (const parent of parents) {
        const existing = this.db.prepare("SELECT id FROM task_flows WHERE parent_task_id = ?").get(parent.parent_id) as Row | undefined;
        if (existing) continue;
        const children = this.db.prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at, rowid")
          .all(parent.parent_id) as Row[];
        if (children.length === 0) continue;
        const flowId = randomUUID();
        const stageId = randomUUID();
        const completed = children.every((child) => child.status === "closed" || child.status === "canceled");
        const createdAt = children[0]?.created_at ?? now;
        this.db.prepare(`
          INSERT INTO task_flows (id, parent_task_id, revision, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?)
        `).run(flowId, parent.parent_id, createdAt, now);
        this.db.prepare(`
          INSERT INTO task_flow_stages (
            id, flow_id, position, name, objective, status, created_at, activated_at, completed_at
          ) VALUES (?, ?, 0, '历史阶段', '完成升级前已经派发的直接子任务', ?, ?, ?, ?)
        `).run(stageId, flowId, completed ? "completed" : "active", createdAt, createdAt, completed ? now : null);
        children.forEach((child, position) => {
          this.db.prepare(`
            INSERT INTO task_flow_stage_tasks (stage_id, task_id, position, completion_required)
            VALUES (?, ?, ?, ?)
          `).run(stageId, child.id, position, child.status === "canceled" ? 0 : 1);
        });
      }
      this.db.prepare("UPDATE schema_meta SET value = '15' WHERE key = 'schema_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private createSchemaV15Tables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_flows (
        id TEXT PRIMARY KEY,
        parent_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_flow_stages (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL REFERENCES task_flows(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        name TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'suspended', 'completed', 'retired')),
        created_at TEXT NOT NULL,
        activated_at TEXT,
        completed_at TEXT,
        suspended_at TEXT,
        retired_at TEXT,
        UNIQUE(flow_id, position)
      );

      CREATE TABLE IF NOT EXISTS task_flow_stage_tasks (
        stage_id TEXT NOT NULL REFERENCES task_flow_stages(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        completion_required INTEGER NOT NULL DEFAULT 1 CHECK (completion_required IN (0, 1)),
        PRIMARY KEY(stage_id, task_id),
        UNIQUE(stage_id, position)
      );

      CREATE TABLE IF NOT EXISTS task_meeting_requirements (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('required', 'scheduled', 'active', 'fulfilled')),
        meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
        required_at TEXT NOT NULL,
        fulfilled_at TEXT
      );

      CREATE TABLE IF NOT EXISTS meeting_task_draft_stages (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        name TEXT NOT NULL,
        objective TEXT NOT NULL,
        UNIQUE(meeting_id, position)
      );

      CREATE TABLE IF NOT EXISTS task_prompt_schedules (
        member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        interval_override_minutes INTEGER CHECK (interval_override_minutes BETWEEN 1 AND 600),
        next_due_at TEXT,
        last_due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_prompt_cycles (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        scheduled_at TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 1 AND 600),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped_busy', 'skipped_empty', 'canceled', 'skipped_offline')),
        last_error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_prompt_cycle_dispatches (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL UNIQUE REFERENCES task_prompt_cycles(id) ON DELETE CASCADE,
        pool_item_id TEXT REFERENCES task_prompt_pool_items(id) ON DELETE SET NULL,
        target_member_id TEXT NOT NULL REFERENCES members(id),
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        kind TEXT CHECK (kind IN ('execution', 'review', 'blocked_review')),
        scheduled_at TEXT NOT NULL,
        prompt TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped_busy', 'skipped_empty', 'skipped_offline', 'canceled')),
        started INTEGER NOT NULL DEFAULT 0 CHECK (started IN (0, 1)),
        last_error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_task_flow_stage_status ON task_flow_stages(flow_id, status, position);
      CREATE INDEX IF NOT EXISTS idx_task_prompt_schedule_due ON task_prompt_schedules(next_due_at);
      CREATE INDEX IF NOT EXISTS idx_task_prompt_cycle_member ON task_prompt_cycles(member_id, scheduled_at DESC);
    `);
    if (!this.columnExists("task_prompt_pool_items", "paused_at")) {
      this.db.exec("ALTER TABLE task_prompt_pool_items ADD COLUMN paused_at TEXT");
      this.db.exec("ALTER TABLE task_prompt_pool_items ADD COLUMN pause_reason TEXT");
    }
    if (!this.tableExists("meeting_task_drafts")) {
      this.db.exec(`
        CREATE TABLE meeting_task_drafts (
          id TEXT PRIMARY KEY,
          meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          stage_id TEXT NOT NULL REFERENCES meeting_task_draft_stages(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK (position >= 0),
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          acceptance_criteria TEXT NOT NULL,
          assignee_id TEXT NOT NULL REFERENCES members(id),
          UNIQUE(stage_id, position)
        );
      `);
    } else if (!this.columnExists("meeting_task_drafts", "stage_id")) {
      this.db.exec("ALTER TABLE meeting_task_drafts RENAME TO meeting_task_drafts_v14");
      this.db.exec(`
        CREATE TABLE meeting_task_drafts (
          id TEXT PRIMARY KEY,
          meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          stage_id TEXT NOT NULL REFERENCES meeting_task_draft_stages(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK (position >= 0),
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          acceptance_criteria TEXT NOT NULL,
          assignee_id TEXT NOT NULL REFERENCES members(id),
          UNIQUE(stage_id, position)
        );
      `);
      const meetings = this.db.prepare("SELECT DISTINCT meeting_id FROM meeting_task_drafts_v14 ORDER BY meeting_id").all() as Row[];
      for (const meeting of meetings) {
        const stageId = randomUUID();
        this.db.prepare(`
          INSERT INTO meeting_task_draft_stages (id, meeting_id, position, name, objective)
          VALUES (?, ?, 0, '阶段 1', '完成本次会议规划的历史子任务')
        `).run(stageId, meeting.meeting_id);
        this.db.prepare(`
          INSERT INTO meeting_task_drafts (
            id, meeting_id, stage_id, position, title, description, acceptance_criteria, assignee_id
          )
          SELECT id, meeting_id, ?, position, title, description, acceptance_criteria, assignee_id
          FROM meeting_task_drafts_v14 WHERE meeting_id = ? ORDER BY position
        `).run(stageId, meeting.meeting_id);
      }
      this.db.exec("DROP TABLE meeting_task_drafts_v14");
    }
  }

  private tableExists(table: string) {
    return Boolean(this.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }

  private columnExists(table: string, column: string) {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((row) => row.name === column);
  }

  private resolveOrganizationAdminAgentId(preferred?: string) {
    const persisted = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'organization_admin_id'").get() as Row | undefined;
    const candidate = preferred?.trim() || String(persisted?.value ?? "").trim()
      || (this.allowedAgentIds.has("main") ? "main" : [...this.allowedAgentIds][0]);
    if (!candidate || !this.allowedAgentIds.has(candidate)) {
      throw new Error(`organization admin Agent does not exist in OpenClaw configuration: ${candidate || "<empty>"}`);
    }
    this.db.prepare(`
      INSERT INTO schema_meta (key, value) VALUES ('organization_admin_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(candidate);
    return candidate;
  }

  private seedOrganization() {
    const now = nowIso();
    this.db.prepare(`
      INSERT OR IGNORE INTO members (id, agent_id, kind, name, title, manager_id, active, created_at, updated_at)
      VALUES ('boss', NULL, 'boss', 'Boss', 'CEO', NULL, 1, ?, ?)
    `).run(now, now);
    this.db.prepare(`
      INSERT OR IGNORE INTO members (id, agent_id, kind, name, title, manager_id, active, created_at, updated_at)
      VALUES (?, ?, 'agent', '架构师', '首席架构师', 'boss', 1, ?, ?)
    `).run(this.organizationAdminAgentId, this.organizationAdminAgentId, now, now);
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
    const row = this.db.prepare("SELECT * FROM members WHERE id = ? AND agent_id = ? AND kind = 'agent' AND active = 1")
      .get(agentId, agentId) as Row | undefined;
    if (!row) throw new Error(`agent is not an active company member: ${agentId}`);
    return row;
  }

  addMember(actorId: string, input: { agentId: string; name: string; title: string; managerId: string }) {
    this.requireOrganizationAdmin(actorId);
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
    this.requireOrganizationAdmin(actorId);
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
    this.requireOrganizationAdmin(actorId);
    if (memberId === "boss" || memberId === this.organizationAdminAgentId) throw new Error(`${memberId} cannot be deactivated`);
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
    if (memberId === "boss" || memberId === this.organizationAdminAgentId) return true;
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM members WHERE manager_id = ? AND active = 1").get(memberId) as Row;
    return Number(row.count) > 0;
  }

  private requireOrganizationAdmin(actorId: string) {
    if (actorId !== this.organizationAdminAgentId) {
      throw new Error(`only organization admin ${this.organizationAdminAgentId} can manage organization`);
    }
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
    const taskRows = this.db.prepare(`
      SELECT id FROM tasks
      WHERE (assignee_id = ? OR issuer_id = ?) AND status IN ('assigned', 'in_progress', 'review', 'blocked')
    `).all(memberId, memberId) as Row[];
    if (taskRows.some((task) => this.taskAvailability(task.id) !== "retired")) return true;
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
      if (task.availability !== "active") {
        const stage = this.taskStageRow(task.id);
        const flowParent = stage ? byId.get(stage.parent_task_id) : undefined;
        if (!flowParent || flowParent.assignee_id !== actorId) return false;
      }
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
    if (actorId !== "boss" && markSeen && row.issuer_id === actorId && row.status === "review") {
      const submission = this.db.prepare(`
        SELECT id FROM task_submissions WHERE task_id = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `).get(taskId) as Row | undefined;
      if (submission) {
        this.db.prepare(`
          INSERT INTO task_review_inspections (submission_id, reviewer_id, read_at)
          VALUES (?, ?, ?)
          ON CONFLICT(submission_id, reviewer_id) DO UPDATE SET read_at = excluded.read_at
        `).run(submission.id, actorId, nowIso());
      }
    }
    const tasks = this.listTasks("boss");
    const task = tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const versions = this.db.prepare("SELECT * FROM task_versions WHERE task_id = ? ORDER BY revision DESC").all(taskId) as Row[];
    const progress = this.db.prepare("SELECT * FROM task_progress WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as Row[];
    const submissions = this.db.prepare("SELECT * FROM task_submissions WHERE task_id = ? ORDER BY created_at DESC").all(taskId) as Row[];
    const latestReminder = this.db.prepare(`
      SELECT * FROM task_agent_dispatches
      WHERE task_id = ? AND kind = 'boss_reminder'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(taskId) as Row | undefined;
    const latestReviewNotification = this.db.prepare(`
      SELECT * FROM task_agent_dispatches
      WHERE task_id = ? AND kind IN ('review_accepted', 'review_rejected')
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(taskId) as Row | undefined;
    const pendingCancelRequest = this.db.prepare(`
      SELECT * FROM task_cancel_requests WHERE task_id = ? AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `).get(taskId) as Row | undefined;
    const cancellationEvents = this.db.prepare(`
      SELECT * FROM task_cancellation_events WHERE task_id = ? ORDER BY canceled_at DESC
    `).all(taskId) as Row[];
    const correctionRows = this.db.prepare(`
      SELECT * FROM task_corrections WHERE target_task_id = ? ORDER BY created_at DESC
    `).all(taskId) as Row[];
    const flow = this.db.prepare("SELECT id FROM task_flows WHERE parent_task_id = ?").get(taskId) as Row | undefined;
    return {
      ...task,
      childFlow: flow ? this.taskFlowDetail(flow.id) : null,
      taskMeetingRequirement: this.mapTaskMeetingRequirement(taskId),
      versions: versions.map(mapTaskVersion),
      progress: progress.map(mapTaskProgress),
      submissions: submissions.map(mapTaskSubmission),
      reminderDispatch: latestReminder ? mapTaskAgentDispatch(latestReminder) : null,
      reviewNotificationDispatch: latestReviewNotification ? mapTaskAgentDispatch(latestReviewNotification) : null,
      pendingCancelRequest: pendingCancelRequest ? mapTaskCancelRequest(pendingCancelRequest) : null,
      cancellationEvents: cancellationEvents.map(mapTaskCancellationEvent),
      corrections: correctionRows.map((correction) => this.mapTaskCorrection(correction)),
      audit: this.listAudit("task", taskId),
    };
  }

  private taskMeetingRequirementRow(taskId: string) {
    return this.db.prepare("SELECT * FROM task_meeting_requirements WHERE task_id = ?").get(taskId) as Row | undefined;
  }

  private mapTaskMeetingRequirement(taskId: string) {
    const row = this.taskMeetingRequirementRow(taskId);
    return row ? {
      status: row.status,
      meetingId: row.meeting_id ?? null,
      requiredAt: row.required_at,
      fulfilledAt: row.fulfilled_at ?? null,
    } : null;
  }

  queueTaskReminderByBoss(taskId: string) {
    const task = this.getTaskRow(taskId);
    const targetMemberId = taskReminderTargetMemberId(task);
    if (!targetMemberId) {
      if ((task.status === "review" || task.status === "blocked") && task.issuer_id === "boss") {
        throw new Error("Boss is the reviewer for this root task and cannot be reminded through an Agent dispatch");
      }
      throw new Error("only assigned, in-progress, review, or blocked tasks can be reminded");
    }
    const targetAgentId = this.runtimeAgentId(targetMemberId);
    const inFlight = this.db.prepare(`
      SELECT * FROM task_agent_dispatches
      WHERE task_id = ? AND target_agent_id = ? AND kind = 'boss_reminder' AND status IN ('pending', 'running')
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(taskId, targetMemberId) as Row | undefined;
    if (inFlight) return mapTaskAgentDispatch({ ...inFlight, target_runtime_agent_id: targetAgentId });
    return this.transaction(() => {
      const id = randomUUID();
      const submission = task.status === "review" ? this.latestPendingTaskSubmission(task.id) : undefined;
      const prompt = buildTaskReminderPrompt(task, id, submission);
      const createdAt = nowIso();
      this.db.prepare(`
        INSERT INTO task_agent_dispatches (
          id, task_id, target_agent_id, kind, prompt, status, created_at
        ) VALUES (?, ?, ?, 'boss_reminder', ?, 'pending', ?)
      `).run(id, taskId, targetMemberId, prompt, createdAt);
      this.audit({
        actorId: "boss",
        action: "task.reminder_queued",
        entityType: "task",
        entityId: taskId,
        after: {
          dispatchId: id,
          targetMemberId,
          targetAgentId,
          targetRole: task.status === "review" || task.status === "blocked" ? "reviewer" : "assignee",
          taskStatus: task.status,
        },
      });
      return mapTaskAgentDispatch({
        id,
        task_id: taskId,
        target_agent_id: targetMemberId,
        target_runtime_agent_id: targetAgentId,
        kind: "boss_reminder",
        prompt,
        status: "pending",
        attempts: 0,
        last_error: null,
        lease_expires_at: null,
        created_at: createdAt,
        started_at: null,
        completed_at: null,
      });
    });
  }

  recoverTaskDispatches() {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM task_agent_dispatches WHERE status = 'running'").all() as Row[];
      for (const row of rows) {
        const progressed = this.taskDispatchHasProgress(row.id);
        const completedAt = nowIso();
        this.db.prepare(`
          UPDATE task_agent_dispatches SET status = ?, lease_expires_at = NULL,
            completed_at = ?, last_error = ? WHERE id = ?
        `).run(
          progressed ? "succeeded" : "failed",
          completedAt,
          progressed ? null : "Gateway restarted after dispatch started; automatic retry suppressed to avoid duplicate delivery",
          row.id,
        );
        this.audit({
          actorId: "system",
          action: taskDispatchAuditAction(row.kind, progressed ? "delivered" : "failed"),
          entityType: "task",
          entityId: row.task_id,
          reason: progressed ? "Gateway restart recovery found verified task progress" : "delivery outcome unknown after Gateway restart; duplicate retry suppressed",
          after: { dispatchId: row.id, kind: row.kind, attempts: row.attempts },
        });
      }
      return rows.length;
    });
  }

  claimNextTaskDispatch(leaseMs = 15 * 60 * 1000) {
    return this.transaction(() => {
      while (true) {
        const row = this.db.prepare(`
          SELECT * FROM task_agent_dispatches
          WHERE status = 'pending' AND attempts < 3
          ORDER BY created_at, rowid LIMIT 1
        `).get() as Row | undefined;
        if (!row) return null;
        const task = this.getTaskRow(row.task_id);
        const reminderTarget = taskReminderTargetMemberId(task);
        if (row.kind === "boss_reminder" && reminderTarget !== row.target_agent_id) {
          const completedAt = nowIso();
          this.db.prepare(`
            UPDATE task_agent_dispatches SET status = 'canceled', completed_at = ?, lease_expires_at = NULL WHERE id = ?
          `).run(completedAt, row.id);
          this.audit({
            actorId: "system",
            action: taskDispatchAuditAction(row.kind, "canceled"),
            entityType: "task",
            entityId: row.task_id,
            reason: reminderTarget ? "task reminder target changed" : "task no longer accepts reminders",
            after: { dispatchId: row.id, kind: row.kind },
          });
          continue;
        }
        const startedAt = nowIso();
        const submission = task.status === "review" ? this.latestPendingTaskSubmission(task.id) : undefined;
        const prompt = row.kind === "boss_reminder" ? buildTaskReminderPrompt(task, row.id, submission) : row.prompt;
        this.db.prepare(`
          UPDATE task_agent_dispatches SET status = 'running', attempts = attempts + 1,
            prompt = ?, started_at = ?, lease_expires_at = ?, last_error = NULL WHERE id = ?
        `).run(prompt, startedAt, new Date(Date.now() + leaseMs).toISOString(), row.id);
        return mapTaskAgentDispatch({
          ...row,
          target_runtime_agent_id: this.runtimeAgentId(row.target_agent_id),
          prompt,
          status: "running",
          attempts: Number(row.attempts) + 1,
          started_at: startedAt,
        });
      }
    });
  }

  nextTaskDispatchTarget() {
    const row = this.db.prepare(`
      SELECT target_agent_id FROM task_agent_dispatches
      WHERE status = 'pending' AND attempts < 3 ORDER BY created_at, rowid LIMIT 1
    `).get() as Row | undefined;
    return row ? { memberId: row.target_agent_id as string, agentId: this.runtimeAgentId(row.target_agent_id) } : null;
  }

  hasPendingTaskDispatches() {
    return Boolean(this.db.prepare(`
      SELECT 1 AS ok FROM task_agent_dispatches WHERE status = 'pending' AND attempts < 3 LIMIT 1
    `).get());
  }

  taskDispatchHasProgress(dispatchId: string) {
    const row = this.db.prepare(`
      SELECT task_id, target_agent_id, kind, created_at, started_at FROM task_agent_dispatches WHERE id = ?
    `).get(dispatchId) as Row | undefined;
    if (!row?.started_at || (row.kind !== "boss_reminder" && row.kind !== "review_rejected")) return false;
    const activitySince = String(row.created_at) > String(row.started_at) ? row.created_at : row.started_at;
    const queuedAudit = this.db.prepare(`
      SELECT rowid AS audit_rowid FROM audit_events
      WHERE entity_type = 'task' AND entity_id = ? AND action = ?
        AND json_extract(after_json, '$.dispatchId') = ?
      ORDER BY rowid DESC LIMIT 1
    `).get(
      row.task_id,
      taskDispatchAuditAction(row.kind, "queued"),
      dispatchId,
    ) as Row | undefined;
    const auditWatermark = queuedAudit ? Number(queuedAudit.audit_rowid) : null;
    const taskProgress = this.db.prepare(`
      SELECT 1 AS ok FROM audit_events
      WHERE entity_type = 'task' AND entity_id = ? AND actor_id = ?
        AND ((? IS NOT NULL AND rowid > ?) OR (? IS NULL AND created_at > ?))
        AND action IN (
          'task.started', 'task.progress', 'task.blocked', 'task.unblocked', 'task.submitted',
          'task.closed', 'task.rejected', 'task.cancel_requested'
        )
      LIMIT 1
    `).get(row.task_id, row.target_agent_id, auditWatermark, auditWatermark, auditWatermark, activitySince);
    if (taskProgress) return true;
    if (row.kind !== "review_rejected") return false;
    return Boolean(this.db.prepare(`
      SELECT 1 AS ok FROM audit_events
      WHERE entity_type = 'task' AND actor_id = ? AND action = 'task.created'
        AND ((? IS NOT NULL AND rowid > ?) OR (? IS NULL AND created_at > ?))
        AND json_extract(after_json, '$.parentId') = ?
      LIMIT 1
    `).get(row.target_agent_id, auditWatermark, auditWatermark, auditWatermark, activitySince, row.task_id));
  }

  completeTaskDispatch(dispatchId: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM task_agent_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running") return false;
      const completedAt = nowIso();
      this.db.prepare(`
        UPDATE task_agent_dispatches SET status = 'succeeded', completed_at = ?, lease_expires_at = NULL,
          last_error = NULL WHERE id = ?
      `).run(completedAt, dispatchId);
      this.audit({
        actorId: "system",
        action: taskDispatchAuditAction(row.kind, "delivered"),
        entityType: "task",
        entityId: row.task_id,
        after: { dispatchId, kind: row.kind, attempts: row.attempts },
      });
      return true;
    });
  }

  failTaskDispatch(dispatchId: string, error: string, allowRetry = true) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM task_agent_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running") return false;
      const reason = required(error, "task dispatch error").slice(0, 1000);
      const task = this.getTaskRow(row.task_id);
      const reminderStillRelevant = taskReminderTargetMemberId(task) === row.target_agent_id;
      const retry = allowRetry && Number(row.attempts) < 3 && (row.kind !== "boss_reminder" || reminderStillRelevant);
      this.db.prepare(`
        UPDATE task_agent_dispatches SET status = ?, last_error = ?, lease_expires_at = NULL,
          completed_at = ? WHERE id = ?
      `).run(retry ? "pending" : "failed", reason, retry ? null : nowIso(), dispatchId);
      this.audit({
        actorId: "system",
        action: taskDispatchAuditAction(row.kind, retry ? "retry" : "failed"),
        entityType: "task",
        entityId: row.task_id,
        reason,
        after: { dispatchId, kind: row.kind, attempts: row.attempts },
      });
      return retry;
    });
  }

  // ── Rolling task prompt pool ──────────────────────────────

  reconcileTaskPromptPool() {
    if (!this.tableExists("task_prompt_pool_items")) return { added: 0, removed: 0 };
    const requiredTaskColumns = ["status", "parent_id", "issuer_id", "assignee_id", "created_at", "last_activity_at"];
    if (requiredTaskColumns.some((column) => !this.columnExists("tasks", column))) return { added: 0, removed: 0 };
    return this.transaction(() => {
      this.reconcileTaskFlows();
      const desired = new Map<string, {
        memberId: string;
        taskId: string;
        parentTaskId: string | null;
        kind: TaskPromptPoolItemKind;
        actionAt: string;
        paused: boolean;
      }>();
      const tasks = this.db.prepare(`
        SELECT t.*, m.active AS target_active,
          (SELECT COUNT(*) FROM tasks child
            WHERE child.parent_id = t.id AND child.status NOT IN ('closed', 'canceled')
              AND NOT EXISTS (
                SELECT 1 FROM task_flow_stage_tasks child_st
                JOIN task_flow_stages child_stage ON child_stage.id = child_st.stage_id
                WHERE child_st.task_id = child.id AND child_stage.status = 'retired'
              )) AS active_children
        FROM tasks t
        LEFT JOIN members m ON m.id = CASE
          WHEN t.status IN ('review', 'blocked') THEN t.issuer_id ELSE t.assignee_id END
        ORDER BY t.created_at, t.id
      `).all() as Row[];
      for (const task of tasks) {
        if (!task.target_active) continue;
        const availability = this.taskAvailability(task.id);
        const paused = availability === "suspended_stage";
        if (availability === "waiting_stage" || availability === "retired") continue;
        let memberId: string | null = null;
        let kind: TaskPromptPoolItemKind | null = null;
        let actionAt = task.last_activity_at as string;
        const flowComplete = this.taskFlowIsComplete(task.id);
        if ((task.status === "assigned" || task.status === "in_progress")
          && Number(task.active_children) === 0 && flowComplete !== false) {
          memberId = task.assignee_id;
          kind = "execution";
        } else if (task.status === "review" && task.issuer_id !== "boss") {
          memberId = task.issuer_id;
          kind = "review";
          actionAt = task.submitted_at ?? task.last_activity_at;
        } else if (task.status === "blocked" && task.parent_id && task.issuer_id !== "boss") {
          memberId = task.issuer_id;
          kind = "blocked_review";
          actionAt = task.blocked_at ?? task.last_activity_at;
        }
        if (!memberId || !kind) continue;
        desired.set(`${memberId}\0${task.id}\0${kind}`, {
          memberId,
          taskId: task.id,
          parentTaskId: task.parent_id ?? null,
          kind,
          actionAt,
          paused,
        });
      }

      const existing = this.db.prepare("SELECT * FROM task_prompt_pool_items ORDER BY member_id, queue_seq").all() as Row[];
      let removed = 0;
      for (const row of existing) {
        const key = `${row.member_id}\0${row.task_id}\0${row.kind}`;
        const expected = desired.get(key);
        if (!expected) {
          this.db.prepare("DELETE FROM task_prompt_pool_items WHERE id = ?").run(row.id);
          this.audit({
            actorId: "system",
            action: "task.prompt_pool_removed",
            entityType: "task",
            entityId: row.task_id,
            after: { poolItemId: row.id, memberId: row.member_id, kind: row.kind },
          });
          removed += 1;
          continue;
        }
        desired.delete(key);
        if ((row.parent_task_id ?? null) !== expected.parentTaskId || Boolean(row.paused_at) !== expected.paused) {
          const updatedAt = nowIso();
          this.db.prepare(`
            UPDATE task_prompt_pool_items SET parent_task_id = ?, updated_at = ?, paused_at = ?, pause_reason = ? WHERE id = ?
          `).run(
            expected.parentTaskId,
            updatedAt,
            expected.paused ? updatedAt : null,
            expected.paused ? "task flow stage is suspended" : null,
            row.id,
          );
        }
      }

      const nextSeq = new Map<string, number>();
      const maxRows = this.db.prepare(`
        SELECT member_id, COALESCE(MAX(queue_seq), 0) AS max_seq
        FROM task_prompt_pool_items GROUP BY member_id
      `).all() as Row[];
      maxRows.forEach((row) => nextSeq.set(row.member_id, Number(row.max_seq)));
      const missing = [...desired.values()].sort((a, b) =>
        a.actionAt.localeCompare(b.actionAt) || a.taskId.localeCompare(b.taskId) || a.kind.localeCompare(b.kind));
      let added = 0;
      for (const item of missing) {
        const queueSeq = (nextSeq.get(item.memberId) ?? 0) + 1;
        nextSeq.set(item.memberId, queueSeq);
        const id = randomUUID();
        const createdAt = item.actionAt;
        const updatedAt = nowIso();
        this.db.prepare(`
          INSERT INTO task_prompt_pool_items (
            id, member_id, task_id, parent_task_id, kind, queue_seq, enqueued_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, item.memberId, item.taskId, item.parentTaskId, item.kind, queueSeq, createdAt, updatedAt);
        if (item.paused) {
          this.db.prepare("UPDATE task_prompt_pool_items SET paused_at = ?, pause_reason = ? WHERE id = ?")
            .run(updatedAt, "task flow stage is suspended", id);
        }
        this.audit({
          actorId: "system",
          action: "task.prompt_pool_enqueued",
          entityType: "task",
          entityId: item.taskId,
          after: { poolItemId: id, memberId: item.memberId, kind: item.kind, queueSeq },
        });
        added += 1;
      }
      this.reconcileTaskPromptSchedules();
      return { added, removed };
    });
  }

  queueTaskPromptTick(scheduledAtInput: string | number | Date) {
    const scheduledAt = new Date(scheduledAtInput);
    if (!Number.isFinite(scheduledAt.getTime())) throw new Error("task prompt tick scheduledAt is invalid");
    const slot = shanghaiSlot(scheduledAt.getTime());
    if (![0, 20, 40].includes(slot.minute) || slot.second !== 0 || slot.millisecond !== 0) {
      throw new Error("task prompt ticks must be scheduled at :00, :20, or :40");
    }
    if (slot.hour < this.taskPromptConfig.startHour || slot.hour > this.taskPromptConfig.endHour) {
      throw new Error("task prompt tick is outside the configured schedule");
    }
    const slotKey = `${slot.localDate}T${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}`;
    const existing = this.db.prepare("SELECT * FROM task_prompt_ticks WHERE slot_key = ?").get(slotKey) as Row | undefined;
    if (existing) return mapTaskPromptTick(existing);
    const id = randomUUID();
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO task_prompt_ticks (id, slot_key, scheduled_at, local_date, local_hour, local_minute, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, slotKey, scheduledAt.toISOString(), slot.localDate, slot.hour, slot.minute, createdAt);
    this.audit({
      actorId: "system",
      action: "task.prompt_tick_created",
      entityType: "task_prompt_tick",
      entityId: id,
      after: { scheduledAt: scheduledAt.toISOString(), slotKey },
    });
    return mapTaskPromptTick(this.db.prepare("SELECT * FROM task_prompt_ticks WHERE id = ?").get(id) as Row);
  }

  taskPromptTickMembers() {
    return this.listMembers().filter((member) => member.kind === "agent" && member.active)
      .sort((a, b) => a.level - b.level || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  createTaskPromptDispatch(
    tickId: string,
    memberId: string,
    busy: boolean,
    busyReason = "main session is active or reserved",
  ): TaskPromptDispatch & { claimed: boolean } {
    return this.transaction(() => {
      const tick = this.db.prepare("SELECT * FROM task_prompt_ticks WHERE id = ?").get(tickId) as Row | undefined;
      if (!tick) throw new Error(`task prompt tick not found: ${tickId}`);
      this.requireAgentMember(memberId);
      const existing = this.db.prepare(`
        SELECT * FROM task_prompt_dispatches WHERE tick_id = ? AND target_member_id = ?
      `).get(tickId, memberId) as Row | undefined;
      if (existing) return { ...mapTaskPromptDispatch({ ...existing, target_runtime_agent_id: this.runtimeAgentId(memberId) }), claimed: false };
      this.reconcileTaskPromptPool();
      const now = nowIso();
      if (busy) {
        return { ...this.insertSkippedTaskPromptDispatch(tick, memberId, "skipped_busy", busyReason, now), claimed: false };
      }
      const item = this.db.prepare(`
        SELECT * FROM task_prompt_pool_items WHERE member_id = ? ORDER BY queue_seq LIMIT 1
      `).get(memberId) as Row | undefined;
      if (!item) {
        return { ...this.insertSkippedTaskPromptDispatch(tick, memberId, "skipped_empty", "task prompt pool is empty", now), claimed: false };
      }
      const id = randomUUID();
      const prompt = this.buildTaskPromptPoolPrompt(item, id);
      this.db.prepare(`
        INSERT INTO task_prompt_dispatches (
          id, tick_id, pool_item_id, target_member_id, task_id, kind, scheduled_at,
          prompt, status, started, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?)
      `).run(id, tick.id, item.id, memberId, item.task_id, item.kind, tick.scheduled_at, prompt, now);
      this.audit({
        actorId: "system",
        action: "task.prompt_dispatch_claimed",
        entityType: "task_prompt_tick",
        entityId: tick.id,
        after: { dispatchId: id, poolItemId: item.id, memberId, taskId: item.task_id, kind: item.kind },
      });
      return { ...mapTaskPromptDispatch({
        ...this.db.prepare("SELECT * FROM task_prompt_dispatches WHERE id = ?").get(id) as Row,
        target_runtime_agent_id: this.runtimeAgentId(memberId),
      }), claimed: true };
    });
  }

  markTaskPromptDispatchStarted(dispatchId: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM task_prompt_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running" || row.started) return false;
      const startedAt = nowIso();
      if (row.pool_item_id) {
        const item = this.db.prepare("SELECT * FROM task_prompt_pool_items WHERE id = ?").get(row.pool_item_id) as Row | undefined;
        if (item) {
          const maximum = this.db.prepare(`
            SELECT COALESCE(MAX(queue_seq), 0) AS max_seq FROM task_prompt_pool_items WHERE member_id = ?
          `).get(item.member_id) as Row;
          this.db.prepare(`
            UPDATE task_prompt_pool_items SET queue_seq = ?, updated_at = ?, last_prompted_at = ?,
              prompt_count = prompt_count + 1 WHERE id = ?
          `).run(Number(maximum.max_seq) + 1, startedAt, startedAt, item.id);
        }
      }
      this.db.prepare("UPDATE task_prompt_dispatches SET started = 1, started_at = ? WHERE id = ?")
        .run(startedAt, dispatchId);
      this.audit({
        actorId: "system",
        action: "task.prompt_dispatch_started",
        entityType: "task_prompt_tick",
        entityId: row.tick_id,
        after: { dispatchId, memberId: row.target_member_id, taskId: row.task_id },
      });
      return true;
    });
  }

  finishTaskPromptDispatch(dispatchId: string, result: { status: "succeeded" | "failed" | "skipped_busy" | "canceled"; error?: string }) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM task_prompt_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running") return false;
      const completedAt = nowIso();
      const error = result.error?.trim().slice(0, 1000) || null;
      this.db.prepare(`
        UPDATE task_prompt_dispatches SET status = ?, last_error = ?, completed_at = ? WHERE id = ?
      `).run(result.status, error, completedAt, dispatchId);
      this.audit({
        actorId: "system",
        action: result.status === "succeeded"
          ? "task.prompt_dispatch_delivered"
          : result.status === "skipped_busy"
            ? "task.prompt_dispatch_skipped_busy"
            : result.status === "canceled"
              ? "task.prompt_dispatch_canceled"
              : "task.prompt_dispatch_failed",
        entityType: "task_prompt_tick",
        entityId: row.tick_id,
        reason: error ?? undefined,
        after: { dispatchId, memberId: row.target_member_id, taskId: row.task_id, started: Boolean(row.started) },
      });
      return true;
    });
  }

  recoverTaskPromptDispatches() {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM task_prompt_dispatches WHERE status = 'running'").all() as Row[];
      const completedAt = nowIso();
      for (const row of rows) {
        const reason = row.started
          ? "Gateway restarted after task prompt injection started; duplicate replay suppressed"
          : "Gateway restarted before task prompt injection was confirmed";
        this.db.prepare(`
          UPDATE task_prompt_dispatches SET status = 'failed', last_error = ?, completed_at = ? WHERE id = ?
        `).run(reason, completedAt, row.id);
        this.audit({
          actorId: "system",
          action: "task.prompt_dispatch_failed",
          entityType: "task_prompt_tick",
          entityId: row.tick_id,
          reason,
          after: { dispatchId: row.id, memberId: row.target_member_id, taskId: row.task_id, started: Boolean(row.started) },
        });
      }
      return rows.length;
    });
  }

  private taskPromptInterval(memberId: string) {
    const member = this.listMembers(true).find((candidate) => candidate.id === memberId);
    if (!member || member.kind !== "agent") throw new Error(`task prompt member not found: ${memberId}`);
    const schedule = this.db.prepare("SELECT interval_override_minutes FROM task_prompt_schedules WHERE member_id = ?")
      .get(memberId) as Row | undefined;
    const defaultIntervalMinutes = Math.min(600, Math.max(1, member.level * 10));
    const intervalOverrideMinutes = schedule?.interval_override_minutes == null ? null : Number(schedule.interval_override_minutes);
    return {
      level: member.level,
      defaultIntervalMinutes,
      intervalOverrideMinutes,
      intervalMinutes: intervalOverrideMinutes ?? defaultIntervalMinutes,
      intervalSource: intervalOverrideMinutes === null ? "level_default" as const : "boss_override" as const,
    };
  }

  private reconcileTaskPromptSchedules(now = Date.now()) {
    if (!this.tableExists("task_prompt_schedules")) return;
    const createdAt = new Date(now).toISOString();
    const members = this.listMembers().filter((member) => member.kind === "agent");
    for (const member of members) {
      this.db.prepare(`
        INSERT OR IGNORE INTO task_prompt_schedules (member_id, created_at, updated_at)
        VALUES (?, ?, ?)
      `).run(member.id, createdAt, createdAt);
      const activeItems = this.db.prepare(`
        SELECT COUNT(*) AS count FROM task_prompt_pool_items WHERE member_id = ? AND paused_at IS NULL
      `).get(member.id) as Row;
      const schedule = this.db.prepare("SELECT * FROM task_prompt_schedules WHERE member_id = ?").get(member.id) as Row;
      if (Number(activeItems.count) === 0) {
        if (schedule.next_due_at) {
          this.db.prepare("UPDATE task_prompt_schedules SET next_due_at = NULL, updated_at = ? WHERE member_id = ?")
            .run(createdAt, member.id);
        }
        continue;
      }
      if (!schedule.next_due_at && this.taskPromptConfig.enabled) {
        const interval = this.taskPromptInterval(member.id).intervalMinutes;
        const nextDueAt = addShanghaiWorkMinutes(now, interval, this.taskPromptConfig.startHour, this.taskPromptConfig.endHour);
        this.db.prepare("UPDATE task_prompt_schedules SET next_due_at = ?, updated_at = ? WHERE member_id = ?")
          .run(nextDueAt, createdAt, member.id);
      }
    }
  }

  setTaskPromptInterval(memberId: string, intervalMinutes: number | null, now = Date.now()) {
    this.requireAgentMember(memberId);
    if (intervalMinutes !== null && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 600)) {
      throw new Error("intervalMinutes must be null or an integer between 1 and 600");
    }
    return this.transaction(() => {
      const timestamp = new Date(now).toISOString();
      this.db.prepare(`
        INSERT INTO task_prompt_schedules (member_id, interval_override_minutes, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(member_id) DO UPDATE SET
          interval_override_minutes = excluded.interval_override_minutes,
          updated_at = excluded.updated_at
      `).run(memberId, intervalMinutes, timestamp, timestamp);
      const queue = this.db.prepare(`
        SELECT 1 AS ok FROM task_prompt_pool_items WHERE member_id = ? AND paused_at IS NULL LIMIT 1
      `).get(memberId);
      const effective = this.taskPromptInterval(memberId);
      const nextDueAt = queue && this.taskPromptConfig.enabled
        ? addShanghaiWorkMinutes(now, effective.intervalMinutes, this.taskPromptConfig.startHour, this.taskPromptConfig.endHour)
        : null;
      this.db.prepare("UPDATE task_prompt_schedules SET next_due_at = ? WHERE member_id = ?").run(nextDueAt, memberId);
      this.audit({
        actorId: "boss",
        action: "task.prompt_interval_updated",
        entityType: "member",
        entityId: memberId,
        after: { intervalOverrideMinutes: intervalMinutes, effectiveIntervalMinutes: effective.intervalMinutes, nextDueAt },
      });
      return { memberId, ...effective, nextDueAt };
    });
  }

  nextTaskPromptDueAt() {
    if (!this.taskPromptConfig.enabled) return null;
    this.reconcileTaskPromptPool();
    const row = this.db.prepare(`
      SELECT next_due_at FROM task_prompt_schedules WHERE next_due_at IS NOT NULL ORDER BY next_due_at LIMIT 1
    `).get() as Row | undefined;
    return (row?.next_due_at ?? null) as string | null;
  }

  dueTaskPromptMembers(now = Date.now()) {
    this.reconcileTaskPromptPool();
    return (this.db.prepare(`
      SELECT member_id FROM task_prompt_schedules
      WHERE next_due_at IS NOT NULL AND next_due_at <= ? ORDER BY next_due_at, member_id
    `).all(new Date(now).toISOString()) as Row[]).map((row) => row.member_id as string);
  }

  recoverOverdueTaskPromptSchedules(now = Date.now()) {
    return this.transaction(() => {
      this.reconcileTaskPromptPool();
      const due = this.db.prepare(`
        SELECT * FROM task_prompt_schedules WHERE next_due_at IS NOT NULL AND next_due_at <= ?
      `).all(new Date(now).toISOString()) as Row[];
      for (const schedule of due) {
        const interval = this.taskPromptInterval(schedule.member_id).intervalMinutes;
        const cycleId = randomUUID();
        const completedAt = new Date(now).toISOString();
        this.db.prepare(`
          INSERT INTO task_prompt_cycles (
            id, member_id, scheduled_at, interval_minutes, status, last_error, created_at, completed_at
          ) VALUES (?, ?, ?, ?, 'skipped_offline', 'Gateway was offline at the persisted due time', ?, ?)
        `).run(cycleId, schedule.member_id, schedule.next_due_at, interval, completedAt, completedAt);
        this.db.prepare(`
          INSERT INTO task_prompt_cycle_dispatches (
            id, cycle_id, target_member_id, scheduled_at, status, started,
            last_error, created_at, completed_at
          ) VALUES (?, ?, ?, ?, 'skipped_offline', 0, 'Gateway was offline at the persisted due time', ?, ?)
        `).run(randomUUID(), cycleId, schedule.member_id, schedule.next_due_at, completedAt, completedAt);
        const nextDueAt = addShanghaiWorkMinutes(now, interval, this.taskPromptConfig.startHour, this.taskPromptConfig.endHour);
        this.db.prepare(`
          UPDATE task_prompt_schedules SET last_due_at = ?, next_due_at = ?, updated_at = ? WHERE member_id = ?
        `).run(schedule.next_due_at, nextDueAt, completedAt, schedule.member_id);
        this.audit({
          actorId: "system",
          action: "task.prompt_cycle_skipped_offline",
          entityType: "task_prompt_cycle",
          entityId: cycleId,
          after: { memberId: schedule.member_id, scheduledAt: schedule.next_due_at, nextDueAt },
        });
      }
      return due.length;
    });
  }

  createTaskPromptCycleDispatch(
    memberId: string,
    busy: boolean,
    busyReason = "main session is active or reserved",
    now = Date.now(),
  ): TaskPromptDispatch & { claimed: boolean } {
    return this.transaction(() => {
      this.reconcileTaskPromptPool();
      const schedule = this.db.prepare("SELECT * FROM task_prompt_schedules WHERE member_id = ?").get(memberId) as Row | undefined;
      if (!schedule?.next_due_at || Date.parse(schedule.next_due_at) > now) throw new Error("task prompt countdown is not due");
      const interval = this.taskPromptInterval(memberId).intervalMinutes;
      const cycleId = randomUUID();
      const createdAt = new Date(now).toISOString();
      const nextDueAt = addShanghaiWorkMinutes(now, interval, this.taskPromptConfig.startHour, this.taskPromptConfig.endHour);
      this.db.prepare(`
        INSERT INTO task_prompt_cycles (id, member_id, scheduled_at, interval_minutes, status, created_at)
        VALUES (?, ?, ?, ?, 'running', ?)
      `).run(cycleId, memberId, schedule.next_due_at, interval, createdAt);
      this.db.prepare(`
        UPDATE task_prompt_schedules SET last_due_at = ?, next_due_at = ?, updated_at = ? WHERE member_id = ?
      `).run(schedule.next_due_at, nextDueAt, createdAt, memberId);
      if (busy) {
        this.db.prepare(`
          UPDATE task_prompt_cycles SET status = 'skipped_busy', last_error = ?, completed_at = ? WHERE id = ?
        `).run(busyReason, createdAt, cycleId);
        this.audit({ actorId: "system", action: "task.prompt_cycle_skipped_busy", entityType: "task_prompt_cycle", entityId: cycleId, reason: busyReason, after: { memberId, nextDueAt } });
        return this.emptyCycleDispatch(cycleId, memberId, schedule.next_due_at, "skipped_busy", busyReason);
      }
      const item = this.db.prepare(`
        SELECT * FROM task_prompt_pool_items WHERE member_id = ? AND paused_at IS NULL ORDER BY queue_seq LIMIT 1
      `).get(memberId) as Row | undefined;
      if (!item) {
        this.db.prepare("UPDATE task_prompt_cycles SET status = 'skipped_empty', completed_at = ? WHERE id = ?").run(createdAt, cycleId);
        this.db.prepare("UPDATE task_prompt_schedules SET next_due_at = NULL, updated_at = ? WHERE member_id = ?").run(createdAt, memberId);
        return this.emptyCycleDispatch(cycleId, memberId, schedule.next_due_at, "skipped_empty", "task prompt pool is empty");
      }
      const dispatchId = randomUUID();
      const prompt = this.buildTaskPromptPoolPrompt(item, dispatchId);
      this.db.prepare(`
        INSERT INTO task_prompt_cycle_dispatches (
          id, cycle_id, pool_item_id, target_member_id, task_id, kind, scheduled_at,
          prompt, status, started, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?)
      `).run(dispatchId, cycleId, item.id, memberId, item.task_id, item.kind, schedule.next_due_at, prompt, createdAt);
      this.audit({
        actorId: "system",
        action: "task.prompt_cycle_claimed",
        entityType: "task_prompt_cycle",
        entityId: cycleId,
        after: { dispatchId, memberId, taskId: item.task_id, kind: item.kind, nextDueAt },
      });
      const row = this.db.prepare("SELECT * FROM task_prompt_cycle_dispatches WHERE id = ?").get(dispatchId) as Row;
      return { ...mapTaskPromptCycleDispatch({ ...row, target_runtime_agent_id: this.runtimeAgentId(memberId) }), claimed: true };
    });
  }

  private emptyCycleDispatch(
    cycleId: string,
    memberId: string,
    scheduledAt: string,
    status: "skipped_busy" | "skipped_empty",
    reason: string,
  ): TaskPromptDispatch & { claimed: false } {
    const id = randomUUID();
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO task_prompt_cycle_dispatches (
        id, cycle_id, target_member_id, scheduled_at, status, started,
        last_error, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, cycleId, memberId, scheduledAt, status, reason, createdAt, createdAt);
    const row = this.db.prepare("SELECT * FROM task_prompt_cycle_dispatches WHERE id = ?").get(id) as Row;
    return {
      ...mapTaskPromptCycleDispatch({ ...row, target_runtime_agent_id: this.runtimeAgentId(memberId) }),
      claimed: false,
    };
  }

  markTaskPromptCycleDispatchStarted(dispatchId: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM task_prompt_cycle_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running" || row.started) return false;
      const startedAt = nowIso();
      if (row.pool_item_id) {
        const item = this.db.prepare("SELECT * FROM task_prompt_pool_items WHERE id = ?").get(row.pool_item_id) as Row | undefined;
        if (item) {
          const maximum = this.db.prepare("SELECT COALESCE(MAX(queue_seq), 0) AS value FROM task_prompt_pool_items WHERE member_id = ?")
            .get(item.member_id) as Row;
          this.db.prepare(`
            UPDATE task_prompt_pool_items SET queue_seq = ?, updated_at = ?, last_prompted_at = ?,
              prompt_count = prompt_count + 1 WHERE id = ?
          `).run(Number(maximum.value) + 1, startedAt, startedAt, item.id);
        }
      }
      this.db.prepare("UPDATE task_prompt_cycle_dispatches SET started = 1, started_at = ? WHERE id = ?")
        .run(startedAt, dispatchId);
      this.audit({
        actorId: "system",
        action: "task.prompt_cycle_started",
        entityType: "task_prompt_cycle",
        entityId: row.cycle_id,
        after: { dispatchId, memberId: row.target_member_id, taskId: row.task_id, rotated: Boolean(row.pool_item_id) },
      });
      return true;
    });
  }

  finishTaskPromptCycleDispatch(dispatchId: string, result: { status: "succeeded" | "failed" | "skipped_busy" | "canceled"; error?: string }) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM task_prompt_cycle_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running") return false;
      const completedAt = nowIso();
      const error = result.error?.trim().slice(0, 1000) || null;
      this.db.prepare(`
        UPDATE task_prompt_cycle_dispatches SET status = ?, last_error = ?, completed_at = ? WHERE id = ?
      `).run(result.status, error, completedAt, dispatchId);
      this.db.prepare(`
        UPDATE task_prompt_cycles SET status = ?, last_error = ?, completed_at = ? WHERE id = ?
      `).run(result.status, error, completedAt, row.cycle_id);
      this.audit({ actorId: "system", action: `task.prompt_cycle_${result.status}`, entityType: "task_prompt_cycle", entityId: row.cycle_id, reason: error ?? undefined, after: { dispatchId, memberId: row.target_member_id, taskId: row.task_id, started: Boolean(row.started) } });
      return true;
    });
  }

  recoverTaskPromptCycleDispatches() {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM task_prompt_cycle_dispatches WHERE status = 'running'").all() as Row[];
      const completedAt = nowIso();
      for (const row of rows) {
        const reason = row.started
          ? "Gateway restarted after task prompt injection started; duplicate replay suppressed"
          : "Gateway restarted before task prompt injection was confirmed";
        this.db.prepare("UPDATE task_prompt_cycle_dispatches SET status = 'failed', last_error = ?, completed_at = ? WHERE id = ?")
          .run(reason, completedAt, row.id);
        this.db.prepare("UPDATE task_prompt_cycles SET status = 'failed', last_error = ?, completed_at = ? WHERE id = ?")
          .run(reason, completedAt, row.cycle_id);
      }
      return rows.length;
    });
  }

  taskPromptPoolSummary(now = Date.now()): TaskPromptPoolSummary {
    this.reconcileTaskPromptPool();
    const members = this.taskPromptTickMembers();
    const items = this.db.prepare("SELECT * FROM task_prompt_pool_items ORDER BY member_id, queue_seq").all() as Row[];
    const byMember = new Map<string, Row[]>();
    for (const item of items) {
      const list = byMember.get(item.member_id) ?? [];
      list.push(item);
      byMember.set(item.member_id, list);
    }
    const queues = members.map((member) => {
      const queue = byMember.get(member.id) ?? [];
      const queueItems = queue.map((item) => {
        const task = this.db.prepare("SELECT title FROM tasks WHERE id = ?").get(item.task_id) as Row | undefined;
        const parent = item.parent_task_id
          ? this.db.prepare("SELECT title FROM tasks WHERE id = ?").get(item.parent_task_id) as Row | undefined
          : undefined;
        return {
          taskId: item.task_id as string,
          parentTaskId: (item.parent_task_id ?? null) as string | null,
          title: (task?.title ?? item.task_id) as string,
          parentTitle: (parent?.title ?? null) as string | null,
          kind: item.kind as TaskPromptPoolItemKind,
          enqueuedAt: item.enqueued_at as string,
          lastPromptedAt: (item.last_prompted_at ?? null) as string | null,
          promptCount: Number(item.prompt_count),
        };
      });
      const last = this.db.prepare(`
        SELECT * FROM task_prompt_cycle_dispatches WHERE target_member_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(member.id) as Row | undefined;
      const schedule = this.db.prepare("SELECT * FROM task_prompt_schedules WHERE member_id = ?").get(member.id) as Row | undefined;
      const interval = this.taskPromptInterval(member.id);
      const activeHeadIndex = queue.findIndex((item) => !item.paused_at);
      return {
        memberId: member.id,
        memberName: member.name,
        ...interval,
        nextDueAt: schedule?.next_due_at ?? null,
        remainingWorkMinutes: schedule?.next_due_at
          ? remainingShanghaiWorkMinutes(now, Date.parse(schedule.next_due_at), this.taskPromptConfig.startHour, this.taskPromptConfig.endHour)
          : null,
        count: queue.length,
        head: activeHeadIndex >= 0 ? queueItems[activeHeadIndex] ?? null : null,
        items: queueItems,
        lastDispatch: last ? {
          status: last.status,
          taskId: last.task_id ?? null,
          kind: last.kind ?? null,
          scheduledAt: last.scheduled_at,
          completedAt: last.completed_at ?? null,
          lastError: last.last_error ?? null,
        } : null,
      };
    });
    return {
      enabled: this.taskPromptConfig.enabled,
      timeZone: "Asia/Shanghai",
      startHour: this.taskPromptConfig.startHour,
      endHour: this.taskPromptConfig.endHour,
      nextDueAt: this.taskPromptConfig.enabled
        ? queues.map((queue) => queue.nextDueAt).filter(Boolean).sort()[0] ?? null
        : null,
      totals: {
        employees: queues.filter((queue) => queue.count > 0).length,
        items: items.length,
        execution: items.filter((item) => item.kind === "execution").length,
        review: items.filter((item) => item.kind === "review").length,
        blockedReview: items.filter((item) => item.kind === "blocked_review").length,
      },
      queues,
    };
  }

  private insertSkippedTaskPromptDispatch(
    tick: Row,
    memberId: string,
    status: "skipped_busy" | "skipped_empty",
    reason: string,
    createdAt: string,
  ) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO task_prompt_dispatches (
        id, tick_id, target_member_id, scheduled_at, status, started, last_error, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, tick.id, memberId, tick.scheduled_at, status, reason, createdAt, createdAt);
    this.audit({
      actorId: "system",
      action: status === "skipped_busy" ? "task.prompt_dispatch_skipped_busy" : "task.prompt_dispatch_skipped_empty",
      entityType: "task_prompt_tick",
      entityId: tick.id,
      reason,
      after: { dispatchId: id, memberId },
    });
    return mapTaskPromptDispatch({
      ...this.db.prepare("SELECT * FROM task_prompt_dispatches WHERE id = ?").get(id) as Row,
      target_runtime_agent_id: this.runtimeAgentId(memberId),
    });
  }

  private buildTaskPromptPoolPrompt(item: Row, promptId: string) {
    const task = this.getTaskRow(item.task_id);
    const parent = task.parent_id ? this.getTaskRow(task.parent_id) : null;
    const member = this.getMember(task.assignee_id, { active: false });
    const progress = this.db.prepare(`
      SELECT * FROM task_progress WHERE task_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(task.id) as Row | undefined;
    const directTasks = (this.db.prepare("SELECT id, status FROM tasks WHERE parent_id = ?").all(task.id) as Row[])
      .filter((child) => this.taskAvailability(child.id) !== "retired");
    const directCounts = {
      total: directTasks.length,
      closed: directTasks.filter((child) => child.status === "closed").length,
      canceled: directTasks.filter((child) => child.status === "canceled").length,
      active: directTasks.filter((child) => child.status !== "closed" && child.status !== "canceled").length,
    };
    const stage = this.taskStageRow(task.id);
    const stageTaskSummary = stage ? (this.db.prepare(`
      SELECT t.title, t.status FROM task_flow_stage_tasks st
      JOIN tasks t ON t.id = st.task_id WHERE st.stage_id = ? ORDER BY st.position
    `).all(stage.id) as Row[]).map((row) => `${row.title}:${row.status}`).join("；") : null;
    const priorStageSummary = stage ? (this.db.prepare(`
      SELECT name, status FROM task_flow_stages
      WHERE flow_id = ? AND position < ? AND status != 'retired' ORDER BY position
    `).all(stage.flow_id, stage.position) as Row[]).map((row) => `${row.name}:${row.status}`).join("；") : null;
    const common = [
      `回转池提示 ID：${promptId}（本次只处理这一项）`,
      `任务：${task.title}`,
      `任务 ID：${task.id}`,
      `负责人：${member.name}（${task.assignee_id}）`,
      ...(parent ? [`所属父任务：${parent.title}`, `父任务 ID：${parent.id}`] : []),
      ...(stage ? [
        `当前阶段：${stage.name}（第 ${Number(stage.position) + 1} 阶段）`,
        `阶段目标：${stage.objective}`,
        `前序阶段：${priorStageSummary || "无（当前为首阶段）"}`,
        `同阶段状态：${stageTaskSummary}`,
      ] : []),
    ];
    const meetingRequirement = item.kind === "execution" ? this.taskMeetingRequirementRow(task.id) : undefined;
    if (meetingRequirement && meetingRequirement.status !== "fulfilled") {
      const openMeeting = meetingRequirement.meeting_id
        ? this.db.prepare("SELECT * FROM meetings WHERE id = ?").get(meetingRequirement.meeting_id) as Row | undefined
        : undefined;
      if (openMeeting?.status === "queued") {
        return [
          "【Company OS 根任务任务会准备提醒】",
          ...common,
          `任务会：${openMeeting.title}（会议 ID：${openMeeting.id}）`,
          "该任务会已经进入会议室队列，不要重复创建会议。",
          "请调用 company_task_read 核对任务目标，并准备阶段划分、每阶段目标、并行任务、负责人和验收标准；等待会议进入会议室后再按会议编排推进。",
          "本次只准备这一个根任务，不要直接创建任务流或提交根任务验收。",
        ].join("\n");
      }
      if (openMeeting?.status === "active") {
        return ["【Company OS 根任务任务会提醒】", ...common, `会议 ID：${openMeeting.id}`, "任务会正在进行，请在会议编排中完成阶段化拆解，不要重复创建会议。"].join("\n");
      }
      const workers = this.db.prepare(`
        SELECT id, name, title FROM members WHERE manager_id = ? AND active = 1 ORDER BY created_at, id
      `).all(task.assignee_id) as Row[];
      return [
        "【Company OS 根任务任务会要求】",
        ...common,
        "Boss 要求你先与全部在职直属下属召开任务拆解会，并由 Boss 参与；本次提醒仍遵守回转池顺序。",
        `必须邀请的 worker：${workers.map((worker) => `${worker.name}（${worker.id}）`).join("、") || "当前无在职直属下属"}`,
        "请先调用 company_task_read 和 company_org_list，然后实际调用 company_meeting_request：",
        `- type: task；parentTaskId: ${task.id}；host 为你本人；bossParticipates: true；`,
        "- participants 必须包含上列全部人员且 role=worker；会议议题必须要求产出分阶段任务流。",
        "请实际创建会议，不要只回复已收到；不得绕过会议直接调用 company_task_create 或提交根任务验收。",
      ].join("\n");
    }
    if (item.kind === "review") {
      const submission = this.db.prepare(`
        SELECT * FROM task_submissions WHERE task_id = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `).get(task.id) as Row | undefined;
      const evidence = parseJson<EvidenceInput[]>(submission?.evidence_json, []);
      return [
        "【Company OS 任务回转池 · 待验收子任务】",
        ...common,
        `提交时间：${submission?.created_at ?? task.submitted_at ?? task.last_activity_at}`,
        `验收标准：${task.acceptance_criteria}`,
        `提交摘要：${submission?.summary ?? "未找到待验收摘要"}`,
        ...submissionGitPromptLines(submission),
        `提交证据：${evidence.length ? evidence.map((entry, index) => `${index}: ${entry.label}（${entry.type}）`).join("；") : "无"}`,
        `直接子任务：共 ${Number(directCounts.total)}，已关闭 ${Number(directCounts.closed ?? 0)}，已取消 ${Number(directCounts.canceled ?? 0)}，活动 ${Number(directCounts.active ?? 0)}`,
        "请先调用 company_task_read 读取当前提交。随后逐项核对验收标准和证据，并调用 company_task_review：",
        reviewerInterventionPromptLine(),
        "- accept：所有检查项必须通过并引用有效证据索引；",
        "- reject：至少指出一个失败项、具体发现和整改要求。",
        "必须提交结构化 reviewReport，不要看到 review 状态就直接通过。",
      ].join("\n");
    }
    if (item.kind === "blocked_review") {
      const blockedAt = task.blocked_at ?? task.last_activity_at;
      const waitingMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(blockedAt)) / 60_000));
      return [
        "【Company OS 任务回转池 · 子任务阻塞审查】",
        ...common,
        `阻塞开始：${blockedAt}`,
        `已等待：${waitingMinutes} 分钟`,
        `阻塞原因：${task.blocked_reason ?? "未记录"}`,
        `最近进度：${progress ? `${progress.created_at} · ${progress.body}` : "无进度记录"}`,
        "请调用 company_task_read 核查阻塞原因、已有进展和任务上下文，然后必须完成一个真实决策：",
        `- 需要上级协助：${parent?.status === "blocked" ? `调用 company_task_progress 更新父任务 ${parent.id} 的阻塞升级进展` : parent ? `调用 company_task_block 阻塞父任务 ${parent.id}，说明本子任务阻塞及所需协助` : "该任务没有可向上阻塞的父任务"}；`,
        `- 不需要上级协助：调用 company_task_unblock 解除子任务 ${task.id} 的阻塞，reason 必须包含可执行解决方案，系统会立即通知负责人继续执行；`,
        `- 确实应终止：调用 company_task_cancel 为子任务 ${task.id} 创建 Boss 取消审批申请。`,
        "不要只回复分析结果，必须完成对应任务工具操作。",
      ].join("\n");
    }
    return [
      "【Company OS 任务回转池 · 执行任务】",
      ...common,
      `当前状态：${task.status}`,
      `验收标准：${task.acceptance_criteria}`,
      `最后活动：${task.last_activity_at}`,
      `最近进度：${progress ? `${progress.created_at} · ${progress.body}` : "无进度记录"}`,
      `直接子任务：共 ${Number(directCounts.total)}，已关闭 ${Number(directCounts.closed ?? 0)}，已取消 ${Number(directCounts.canceled ?? 0)}，活动 ${Number(directCounts.active ?? 0)}`,
      "请先调用 company_task_read 获取最新版本，再实际推进这一项任务：",
      "- assigned：调用 company_task_start 后开始执行；",
      "- in_progress：完成当前可执行工作并调用 company_task_progress 记录成果；",
      ...executionReviewBoundaryPromptLines(),
      "- 当本人可执行交付已完成且直接子任务全部终结：先将成果推送到远端分支，读取远端 tip，再调用 company_task_submit 提交摘要、proof/artifact 和 gitLocation（远端、分支、40 位 tip commit）。",
      "遇到真实阻塞请调用 company_task_block。不要只回复进度说明。",
    ].join("\n");
  }

  private latestPendingTaskSubmission(taskId: string) {
    return this.db.prepare(`
      SELECT * FROM task_submissions WHERE task_id = ? AND status = 'pending'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(taskId) as Row | undefined;
  }

  // ── Hourly task check-ins ──────────────────────────────────

  queueTaskCheckinRun(scheduledAtInput: string | number | Date) {
    const scheduledAt = new Date(scheduledAtInput);
    if (!Number.isFinite(scheduledAt.getTime())) throw new Error("task check-in scheduledAt is invalid");
    const slot = shanghaiSlot(scheduledAt.getTime());
    if (slot.minute !== 0 || slot.second !== 0 || slot.millisecond !== 0) {
      throw new Error("task check-in runs must be scheduled on an exact hour");
    }
    if (slot.hour < this.taskCheckinConfig.startHour || slot.hour > this.taskCheckinConfig.endHour) {
      throw new Error("task check-in run is outside the configured schedule");
    }
    const slotKey = `${slot.localDate}T${String(slot.hour).padStart(2, "0")}`;
    const existing = this.db.prepare("SELECT id FROM task_checkin_runs WHERE slot_key = ?").get(slotKey) as Row | undefined;
    if (existing) return this.taskCheckinRun(existing.id);

    return this.transaction(() => {
      const runId = randomUUID();
      const createdAt = nowIso();
      this.db.prepare(`
        INSERT INTO task_checkin_runs (id, slot_key, scheduled_at, local_date, local_hour, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(runId, slotKey, scheduledAt.toISOString(), slot.localDate, slot.hour, createdAt);

      let employeeCount = 0;
      let plannedReminders = 0;
      const employees = this.listMembers().filter((member) => member.kind === "agent" && member.active)
        .sort((a, b) => a.level - b.level || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const employee of employees) {
        const candidates = this.taskCheckinCandidates(employee.id, slot.localDate);
        if (candidates.length === 0) continue;
        employeeCount += 1;
        const batchId = randomUUID();
        this.db.prepare(`
          INSERT INTO task_checkin_batches (
            id, run_id, target_member_id, channel, candidate_json, candidate_count, created_at
          ) VALUES (?, ?, ?, 'agent', ?, ?, ?)
        `).run(batchId, runId, employee.id, JSON.stringify(candidates), candidates.length, createdAt);
        const slotCount = Math.min(3, candidates.length);
        for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
          const dispatchId = randomUUID();
          const dispatchAt = new Date(scheduledAt.getTime() + slotIndex * 15 * 60 * 1000).toISOString();
          this.db.prepare(`
            INSERT INTO task_checkin_dispatches (
              id, run_id, batch_id, target_member_id, channel, slot_index, scheduled_at, status, created_at
            ) VALUES (?, ?, ?, ?, 'agent', ?, ?, 'pending', ?)
          `).run(dispatchId, runId, batchId, employee.id, slotIndex, dispatchAt, createdAt);
          this.audit({
            actorId: "system",
            action: "task.checkin_dispatch_queued",
            entityType: "task_checkin",
            entityId: runId,
            after: { dispatchId, targetMemberId: employee.id, slotIndex, scheduledAt: dispatchAt },
          });
          plannedReminders += 1;
        }
      }

      const bossCandidates = this.bossTaskCheckinCandidates();
      if (bossCandidates.length > 0) {
        const batchId = randomUUID();
        const dispatchId = randomUUID();
        const status = this.bossEmailEnabled ? "pending" : "skipped";
        const lastError = this.bossEmailEnabled ? null : "Boss email notifications are disabled";
        this.db.prepare(`
          INSERT INTO task_checkin_batches (
            id, run_id, target_member_id, channel, candidate_json, candidate_count, created_at
          ) VALUES (?, ?, 'boss', 'boss_email', ?, ?, ?)
        `).run(batchId, runId, JSON.stringify(bossCandidates), bossCandidates.length, createdAt);
        this.db.prepare(`
          INSERT INTO task_checkin_dispatches (
            id, run_id, batch_id, target_member_id, channel, slot_index, scheduled_at,
            action_kind, status, last_error, created_at, completed_at
          ) VALUES (?, ?, ?, 'boss', 'boss_email', 0, ?, 'boss_digest', ?, ?, ?, ?)
        `).run(
          dispatchId,
          runId,
          batchId,
          scheduledAt.toISOString(),
          status,
          lastError,
          createdAt,
          status === "skipped" ? createdAt : null,
        );
        this.audit({
          actorId: "system",
          action: status === "pending" ? "task.checkin_dispatch_queued" : "task.checkin_dispatch_skipped",
          entityType: "task_checkin",
          entityId: runId,
          reason: lastError ?? undefined,
          after: { dispatchId, targetMemberId: "boss", channel: "boss_email", candidateCount: bossCandidates.length },
        });
      }

      this.audit({
        actorId: "system",
        action: employeeCount === 0 && bossCandidates.length === 0 ? "task.checkin_empty" : "task.checkin_created",
        entityType: "task_checkin",
        entityId: runId,
        after: {
          scheduledAt: scheduledAt.toISOString(),
          localDate: slot.localDate,
          localHour: slot.hour,
          employeeCount,
          plannedReminders,
          bossCandidateCount: bossCandidates.length,
        },
      });
      return this.taskCheckinRun(runId);
    });
  }

  recoverTaskCheckinDispatches() {
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM task_checkin_dispatches
        WHERE status = 'running' OR (channel = 'agent' AND status = 'pending' AND attempts > 0)
      `).all() as Row[];
      for (const row of rows) {
        const exhausted = Number(row.attempts) >= 3;
        const progressed = row.channel === "agent" && this.taskCheckinDispatchHasProgress(row.id);
        const singleInjectionAgentDispatch = row.channel === "agent";
        const status = progressed ? "succeeded" : exhausted || singleInjectionAgentDispatch ? "failed" : "pending";
        const completedAt = status === "pending" ? null : nowIso();
        const lastError = progressed
          ? null
          : singleInjectionAgentDispatch
            ? "Task patrol dispatch had already been attempted; automatic retry suppressed to avoid duplicate delivery"
            : exhausted
              ? "Gateway restarted during the final task check-in attempt"
              : "Gateway restarted during task check-in dispatch";
        this.db.prepare(`
          UPDATE task_checkin_dispatches SET status = ?, lease_expires_at = NULL,
            last_error = ?, completed_at = ? WHERE id = ?
        `).run(status, lastError, completedAt, row.id);
        this.audit({
          actorId: "system",
          action: progressed ? "task.checkin_dispatch_delivered" : status === "failed" ? "task.checkin_dispatch_failed" : "task.checkin_dispatch_recovered",
          entityType: "task_checkin",
          entityId: row.run_id,
          reason: progressed
            ? "Gateway restart recovery found verified task progress"
            : singleInjectionAgentDispatch
              ? "task patrol dispatch is single-injection; duplicate retry suppressed"
              : exhausted
                ? "Gateway restarted during the final task check-in attempt"
                : undefined,
          after: { dispatchId: row.id, targetMemberId: row.target_member_id, taskId: row.task_id, attempts: row.attempts },
        });
      }
      return rows.length;
    });
  }

  claimNextTaskCheckinDispatch(now = Date.now(), leaseMs = 15 * 60 * 1000) {
    return this.transaction(() => {
      while (true) {
        const row = this.db.prepare(`
          SELECT d.*, b.candidate_json, r.local_date
          FROM task_checkin_dispatches d
          JOIN task_checkin_batches b ON b.id = d.batch_id
          JOIN task_checkin_runs r ON r.id = d.run_id
          WHERE d.status = 'pending'
            AND ((d.channel = 'agent' AND d.attempts = 0) OR (d.channel = 'boss_email' AND d.attempts < 3))
            AND d.scheduled_at <= ?
          ORDER BY d.scheduled_at, d.created_at, d.rowid LIMIT 1
        `).get(new Date(now).toISOString()) as Row | undefined;
        if (!row) return null;

        let prompt: string;
        let taskId: string | null = row.task_id ?? null;
        let actionKind: TaskCheckinActionKind | null = row.action_kind ?? null;
        let emailNotification: TaskCheckinEmailNotification | undefined;
        if (row.channel === "agent") {
          const candidates = parseJson<TaskCheckinCandidate[]>(row.candidate_json, []);
          const used = this.db.prepare(`
            SELECT task_id, action_kind FROM task_checkin_dispatches
            WHERE batch_id = ? AND id != ? AND task_id IS NOT NULL
          `).all(row.batch_id, row.id) as Row[];
          const usedKeys = new Set(used.map((item) => `${item.task_id}:${item.action_kind}`));
          let selected = taskId && actionKind && actionKind !== "boss_digest"
            ? candidates.find((item) => item.taskId === taskId && item.actionKind === actionKind)
            : undefined;
          if (!selected || !this.taskCheckinCandidateIsRelevant(row.target_member_id, selected)) {
            selected = candidates.find((candidate) => !usedKeys.has(`${candidate.taskId}:${candidate.actionKind}`)
              && this.taskCheckinCandidateIsRelevant(row.target_member_id, candidate));
          }
          if (!selected) {
            this.skipTaskCheckinDispatch(row, "no eligible task remains in this hourly candidate snapshot");
            continue;
          }
          const task = this.getTaskRow(selected.taskId);
          taskId = selected.taskId;
          actionKind = selected.actionKind;
          const submission = selected.actionKind === "review" ? this.latestPendingTaskSubmission(task.id) : undefined;
          prompt = buildTaskCheckinPrompt(task, selected.actionKind, row.id, submission);
        } else {
          const snapshot = parseJson<BossTaskCheckinCandidate[]>(row.candidate_json, []);
          emailNotification = this.buildBossTaskCheckinEmail(row.id, row.run_id, row.scheduled_at, snapshot);
          if (emailNotification.reviews.length === 0 && emailNotification.anomalies.length === 0) {
            this.skipTaskCheckinDispatch(row, "no eligible Boss task remains in this hourly snapshot");
            continue;
          }
          taskId = null;
          actionKind = "boss_digest";
          prompt = `Boss task check-in digest: ${emailNotification.reviews.length} reviews, ${emailNotification.anomalies.length} anomalies`;
        }

        const startedAt = nowIso();
        this.db.prepare(`
          UPDATE task_checkin_dispatches SET task_id = ?, action_kind = ?, prompt = ?, status = 'running',
            attempts = attempts + 1, started_at = ?, lease_expires_at = ?, last_error = NULL WHERE id = ?
        `).run(taskId, actionKind, prompt, startedAt, new Date(now + leaseMs).toISOString(), row.id);
        this.audit({
          actorId: "system",
          action: "task.checkin_dispatch_started",
          entityType: "task_checkin",
          entityId: row.run_id,
          after: { dispatchId: row.id, targetMemberId: row.target_member_id, taskId, actionKind, attempts: Number(row.attempts) + 1 },
        });
        return {
          ...mapTaskCheckinDispatch({
            ...row,
            task_id: taskId,
            action_kind: actionKind,
            prompt,
            status: "running",
            attempts: Number(row.attempts) + 1,
            started_at: startedAt,
            target_runtime_agent_id: row.channel === "agent" ? this.runtimeAgentId(row.target_member_id) : null,
          }),
          emailNotification,
        };
      }
    });
  }

  completeTaskCheckinDispatch(dispatchId: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM task_checkin_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running") return false;
      const completedAt = nowIso();
      this.db.prepare(`
        UPDATE task_checkin_dispatches SET status = 'succeeded', completed_at = ?, lease_expires_at = NULL,
          last_error = NULL WHERE id = ?
      `).run(completedAt, dispatchId);
      this.audit({
        actorId: "system",
        action: "task.checkin_dispatch_delivered",
        entityType: "task_checkin",
        entityId: row.run_id,
        after: { dispatchId, targetMemberId: row.target_member_id, taskId: row.task_id, actionKind: row.action_kind, attempts: row.attempts },
      });
      return true;
    });
  }

  failTaskCheckinDispatch(dispatchId: string, error: string, allowRetry = true) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM task_checkin_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running") return false;
      const reason = required(error, "task check-in dispatch error").slice(0, 1000);
      const bossSnapshot = row.channel === "boss_email"
        ? parseJson<BossTaskCheckinCandidate[]>((this.db.prepare("SELECT candidate_json FROM task_checkin_batches WHERE id = ?").get(row.batch_id) as Row)?.candidate_json, [])
        : [];
      const bossStillRelevant = row.channel === "boss_email"
        ? (() => {
            const notification = this.buildBossTaskCheckinEmail(row.id, row.run_id, row.scheduled_at, bossSnapshot);
            return notification.reviews.length > 0 || notification.anomalies.length > 0;
          })()
        : false;
      const retry = row.channel === "boss_email" && allowRetry && Number(row.attempts) < 3 && bossStillRelevant;
      this.db.prepare(`
        UPDATE task_checkin_dispatches SET status = ?, last_error = ?, lease_expires_at = NULL,
          completed_at = ? WHERE id = ?
      `).run(retry ? "pending" : "failed", reason, retry ? null : nowIso(), dispatchId);
      this.audit({
        actorId: "system",
        action: retry ? "task.checkin_dispatch_retry" : "task.checkin_dispatch_failed",
        entityType: "task_checkin",
        entityId: row.run_id,
        reason,
        after: { dispatchId, targetMemberId: row.target_member_id, taskId: row.task_id, attempts: row.attempts },
      });
      return retry;
    });
  }

  taskCheckinDispatchHasProgress(dispatchId: string) {
    const row = this.db.prepare(`
      SELECT task_id, target_member_id, action_kind, started_at
      FROM task_checkin_dispatches WHERE id = ?
    `).get(dispatchId) as Row | undefined;
    if (!row?.task_id || !row.started_at || row.action_kind === "boss_digest") return false;
    const actions = row.action_kind === "review"
      ? ["task.closed", "task.rejected"]
      : ["task.started", "task.progress", "task.blocked", "task.unblocked", "task.submitted"];
    const placeholders = actions.map(() => "?").join(", ");
    return Boolean(this.db.prepare(`
      SELECT 1 AS ok FROM audit_events
      WHERE entity_type = 'task' AND entity_id = ? AND actor_id = ? AND created_at >= ?
        AND action IN (${placeholders}) LIMIT 1
    `).get(row.task_id, row.target_member_id, row.started_at, ...actions));
  }

  hasDueTaskCheckinDispatches(now = Date.now()) {
    return Boolean(this.db.prepare(`
      SELECT 1 AS ok FROM task_checkin_dispatches
      WHERE status = 'pending'
        AND ((channel = 'agent' AND attempts = 0) OR (channel = 'boss_email' AND attempts < 3))
        AND scheduled_at <= ? LIMIT 1
    `).get(new Date(now).toISOString()));
  }

  nextPendingTaskCheckinDispatchAt() {
    const row = this.db.prepare(`
      SELECT scheduled_at FROM task_checkin_dispatches
      WHERE status = 'pending'
        AND ((channel = 'agent' AND attempts = 0) OR (channel = 'boss_email' AND attempts < 3))
      ORDER BY scheduled_at, created_at LIMIT 1
    `).get() as Row | undefined;
    return row?.scheduled_at as string | undefined;
  }

  nextPendingTaskCheckinDispatchPreview() {
    const row = this.db.prepare(`
      SELECT d.*, b.candidate_json
      FROM task_checkin_dispatches d
      JOIN task_checkin_batches b ON b.id = d.batch_id
      WHERE d.status = 'pending'
        AND ((d.channel = 'agent' AND d.attempts = 0) OR (d.channel = 'boss_email' AND d.attempts < 3))
      ORDER BY d.scheduled_at, d.created_at, d.rowid LIMIT 1
    `).get() as Row | undefined;
    if (!row) return null;
    if (row.channel === "boss_email") {
      return {
        scheduledAt: row.scheduled_at,
        targetMemberId: "boss",
        channel: "boss_email" as const,
        taskId: null,
        title: "Boss 根任务巡检汇总",
        actionKind: "boss_digest" as const,
      };
    }
    const candidates = parseJson<TaskCheckinCandidate[]>(row.candidate_json, []);
    const used = this.db.prepare(`
      SELECT task_id, action_kind FROM task_checkin_dispatches
      WHERE batch_id = ? AND id != ? AND task_id IS NOT NULL
    `).all(row.batch_id, row.id) as Row[];
    const usedKeys = new Set(used.map((item) => `${item.task_id}:${item.action_kind}`));
    const current = row.task_id && row.action_kind
      ? candidates.find((item) => item.taskId === row.task_id && item.actionKind === row.action_kind)
      : undefined;
    const candidate = current && this.taskCheckinCandidateIsRelevant(row.target_member_id, current)
      ? current
      : candidates.find((item) => !usedKeys.has(`${item.taskId}:${item.actionKind}`)
        && this.taskCheckinCandidateIsRelevant(row.target_member_id, item));
    const task = candidate ? this.db.prepare("SELECT title FROM tasks WHERE id = ?").get(candidate.taskId) as Row | undefined : undefined;
    return {
      scheduledAt: row.scheduled_at,
      targetMemberId: row.target_member_id,
      channel: "agent" as const,
      taskId: candidate?.taskId ?? null,
      title: task?.title ?? "等待实时递补",
      actionKind: candidate?.actionKind ?? null,
    };
  }

  taskCheckinSummary(now = Date.now()) {
    const localDate = shanghaiSlot(now).localDate;
    const latestRun = this.db.prepare(`
      SELECT * FROM task_checkin_runs WHERE local_date = ? ORDER BY scheduled_at DESC LIMIT 1
    `).get(localDate) as Row | undefined;
    const nextRunAt = this.taskCheckinConfig.enabled
      ? nextTaskCheckinRunAt(now, this.taskCheckinConfig.startHour, this.taskCheckinConfig.endHour)
      : null;
    const nextDispatch = this.nextPendingTaskCheckinDispatchPreview();
    const nextDispatchAt = nextDispatch?.scheduledAt ?? null;
    const backlog = this.db.prepare(`
      SELECT COUNT(*) AS count FROM task_checkin_dispatches WHERE status = 'pending' AND scheduled_at <= ?
    `).get(new Date(now).toISOString()) as Row;
    const bossCurrent = this.bossTaskCheckinCandidates();
    const bossReviewCount = bossCurrent.filter((item) => item.review).length;
    const bossAnomalyCount = bossCurrent.filter((item) => item.anomaly).length;
    if (!latestRun) {
      return {
        enabled: this.taskCheckinConfig.enabled,
        timeZone: this.taskCheckinConfig.timeZone,
        startHour: this.taskCheckinConfig.startHour,
        endHour: this.taskCheckinConfig.endHour,
        nextRunAt,
        nextDispatchAt,
        nextDispatch,
        backlog: Number(backlog.count),
        today: { localDate, latestRun: null },
        boss: { reviewCount: bossReviewCount, anomalyCount: bossAnomalyCount, emailStatus: null, lastError: null },
      };
    }
    const statusRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM task_checkin_dispatches
      WHERE run_id = ? AND channel = 'agent' GROUP BY status
    `).all(latestRun.id) as Row[];
    const counts = Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)]));
    const employeeBatchCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM task_checkin_batches WHERE run_id = ? AND channel = 'agent'
    `).get(latestRun.id) as Row;
    const planned = this.db.prepare("SELECT COUNT(*) AS count FROM task_checkin_dispatches WHERE run_id = ? AND channel = 'agent'")
      .get(latestRun.id) as Row;
    const bossDispatch = this.db.prepare(`
      SELECT * FROM task_checkin_dispatches WHERE run_id = ? AND channel = 'boss_email' LIMIT 1
    `).get(latestRun.id) as Row | undefined;
    return {
      enabled: this.taskCheckinConfig.enabled,
      timeZone: this.taskCheckinConfig.timeZone,
      startHour: this.taskCheckinConfig.startHour,
      endHour: this.taskCheckinConfig.endHour,
      nextRunAt,
      nextDispatchAt,
      nextDispatch,
      backlog: Number(backlog.count),
      today: {
        localDate,
        latestRun: {
          id: latestRun.id,
          scheduledAt: latestRun.scheduled_at,
          candidateEmployees: Number(employeeBatchCount.count),
          plannedReminders: Number(planned.count),
          pending: counts.pending ?? 0,
          running: counts.running ?? 0,
          delivered: counts.succeeded ?? 0,
          failed: counts.failed ?? 0,
          skipped: counts.skipped ?? 0,
          canceled: counts.canceled ?? 0,
        },
      },
      boss: {
        reviewCount: bossReviewCount,
        anomalyCount: bossAnomalyCount,
        emailStatus: bossDispatch?.status ?? null,
        lastError: bossDispatch?.last_error ?? null,
      },
    };
  }

  private taskCheckinRun(runId: string) {
    const run = this.db.prepare("SELECT * FROM task_checkin_runs WHERE id = ?").get(runId) as Row;
    const batches = this.db.prepare("SELECT * FROM task_checkin_batches WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as Row[];
    const dispatches = this.db.prepare("SELECT * FROM task_checkin_dispatches WHERE run_id = ? ORDER BY scheduled_at, created_at, rowid")
      .all(runId) as Row[];
    return {
      id: run.id,
      slotKey: run.slot_key,
      scheduledAt: run.scheduled_at,
      localDate: run.local_date,
      localHour: Number(run.local_hour),
      batches: batches.map((row) => ({
        id: row.id,
        targetMemberId: row.target_member_id,
        channel: row.channel,
        candidateCount: Number(row.candidate_count),
        candidates: parseJson(row.candidate_json, []),
      })),
      dispatches: dispatches.map(mapTaskCheckinDispatch),
    };
  }

  private taskCheckinCandidates(memberId: string, localDate: string): TaskCheckinCandidate[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE (issuer_id = ? AND status = 'review')
         OR (assignee_id = ? AND status IN ('assigned', 'in_progress', 'blocked'))
    `).all(memberId, memberId) as Row[];
    const rotationRows = this.db.prepare(`
      SELECT d.task_id, d.action_kind, MAX(d.completed_at) AS last_reminded_at
      FROM task_checkin_dispatches d
      JOIN task_checkin_runs r ON r.id = d.run_id
      WHERE d.target_member_id = ? AND d.channel = 'agent' AND d.status = 'succeeded'
        AND r.local_date = ? AND d.task_id IS NOT NULL
      GROUP BY d.task_id, d.action_kind
    `).all(memberId, localDate) as Row[];
    const remindedAt = new Map(rotationRows.map((row) => [`${row.task_id}:${row.action_kind}`, row.last_reminded_at as string]));
    const candidates = rows.map((row): TaskCheckinCandidate => ({
      taskId: row.id,
      actionKind: row.status === "review" ? "review" : "execute",
      actionAt: row.status === "review" ? row.submitted_at ?? row.last_activity_at : row.last_activity_at,
    }));
    return candidates.sort((a, b) => {
      const aReminded = remindedAt.get(`${a.taskId}:${a.actionKind}`);
      const bReminded = remindedAt.get(`${b.taskId}:${b.actionKind}`);
      if (Boolean(aReminded) !== Boolean(bReminded)) return aReminded ? 1 : -1;
      if (aReminded && bReminded && aReminded !== bReminded) return aReminded.localeCompare(bReminded);
      return a.actionAt.localeCompare(b.actionAt) || a.taskId.localeCompare(b.taskId);
    });
  }

  private taskCheckinCandidateIsRelevant(memberId: string, candidate: Partial<TaskCheckinCandidate>) {
    if (!candidate.taskId || (candidate.actionKind !== "review" && candidate.actionKind !== "execute")) return false;
    const task = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(candidate.taskId) as Row | undefined;
    if (!task) return false;
    return candidate.actionKind === "review"
      ? task.issuer_id === memberId && task.status === "review"
      : task.assignee_id === memberId && (["assigned", "in_progress", "blocked"] as string[]).includes(task.status);
  }

  private bossTaskCheckinCandidates(): BossTaskCheckinCandidate[] {
    const roots = this.db.prepare("SELECT * FROM tasks WHERE parent_id IS NULL ORDER BY created_at").all() as Row[];
    return this.decorateTasks(roots).flatMap((task) => {
      const review = task.issuerId === "boss" && task.status === "review";
      const anomaly = (["assigned", "in_progress", "blocked"] as string[]).includes(task.status)
        && (task.status === "blocked" || task.risks.stale || task.risks.blockedDescendants > 0 || task.risks.staleDescendants > 0);
      return review || anomaly ? [{ taskId: task.id, review, anomaly }] : [];
    });
  }

  private buildBossTaskCheckinEmail(
    dispatchId: string,
    runId: string,
    scheduledAt: string,
    snapshot: BossTaskCheckinCandidate[],
  ): TaskCheckinEmailNotification {
    const allowed = new Map(snapshot.map((item) => [item.taskId, item]));
    const current = this.bossTaskCheckinCandidates().filter((item) => allowed.has(item.taskId));
    const itemFor = (candidate: BossTaskCheckinCandidate): TaskCheckinEmailItem => {
      const task = this.decorateTasks([this.getTaskRow(candidate.taskId)])[0]!;
      const assignee = this.getMember(task.assigneeId, { active: false });
      return {
        taskId: task.id,
        title: task.title,
        assigneeId: task.assigneeId,
        assigneeName: assignee.name,
        status: task.status,
        submittedAt: task.submittedAt,
        lastActivityAt: task.lastActivityAt,
        blocked: task.status === "blocked",
        stale: task.risks.stale,
        blockedDescendants: task.risks.blockedDescendants,
        staleDescendants: task.risks.staleDescendants,
      };
    };
    return {
      id: dispatchId,
      kind: "task_checkin",
      runId,
      scheduledAt,
      reviews: current.filter((item) => item.review).map(itemFor),
      anomalies: current.filter((item) => item.anomaly).map(itemFor),
    };
  }

  private skipTaskCheckinDispatch(row: Row, reason: string) {
    const completedAt = nowIso();
    this.db.prepare(`
      UPDATE task_checkin_dispatches SET status = 'skipped', last_error = ?, completed_at = ?,
        lease_expires_at = NULL WHERE id = ?
    `).run(reason, completedAt, row.id);
    this.audit({
      actorId: "system",
      action: "task.checkin_dispatch_skipped",
      entityType: "task_checkin",
      entityId: row.run_id,
      reason,
      after: { dispatchId: row.id, targetMemberId: row.target_member_id, taskId: row.task_id },
    });
  }

  createRootTask(input: { title: string; description: string; acceptanceCriteria: string; assigneeId: string; requireTaskMeeting?: boolean }) {
    if (input.requireTaskMeeting !== undefined && typeof input.requireTaskMeeting !== "boolean") {
      throw new Error("requireTaskMeeting must be a boolean");
    }
    if (!this.isDirectReport("boss", input.assigneeId)) throw new Error("root tasks can only be assigned to Boss direct reports");
    if (input.requireTaskMeeting) {
      const reports = this.db.prepare("SELECT COUNT(*) AS count FROM members WHERE manager_id = ? AND active = 1")
        .get(input.assigneeId) as Row;
      if (Number(reports.count) === 0) throw new Error("a required task meeting needs at least one active direct report");
    }
    return this.transaction(() => {
      const task = this.insertTask({
        actorId: "boss",
        parentId: null,
        issuerId: "boss",
        assigneeId: input.assigneeId,
        title: input.title,
        description: input.description,
        acceptanceCriteria: input.acceptanceCriteria,
      }, false);
      if (input.requireTaskMeeting) {
        const requiredAt = nowIso();
        this.db.prepare(`
          INSERT INTO task_meeting_requirements (task_id, status, required_at)
          VALUES (?, 'required', ?)
        `).run(task.id, requiredAt);
        this.audit({
          actorId: "boss",
          action: "task.meeting_required",
          entityType: "task",
          entityId: task.id,
          after: { requiredAt },
        });
      }
      this.reconcileTaskPromptPool();
      return this.readTask("boss", task.id, false);
    });
  }

  createTaskFlow(actorId: string, input: { parentId: string; stages: TaskFlowStageInput[] }) {
    this.requireAgentMember(actorId);
    return this.createTaskFlowInternal(actorId, input.parentId, input.stages);
  }

  private createTaskFlowInternal(
    actorId: Actor,
    parentId: string,
    stagesInput: TaskFlowStageInput[],
    sourceMeetingId?: string,
  ) {
    const parent = this.getTaskRow(parentId);
    if (parent.assignee_id !== actorId) throw new Error("only the parent task assignee can create its task flow");
    this.assertTaskActionable(parent, "create a task flow");
    if (parent.status !== "assigned" && parent.status !== "in_progress") {
      throw new Error("task flows can only be created for assigned or in-progress tasks");
    }
    if (this.db.prepare("SELECT 1 AS ok FROM task_flows WHERE parent_task_id = ?").get(parentId)) {
      throw new Error("the parent task already has a task flow");
    }
    if (this.db.prepare("SELECT 1 AS ok FROM tasks WHERE parent_id = ? LIMIT 1").get(parentId)) {
      throw new Error("the parent task already has direct child tasks");
    }
    const requirement = this.taskMeetingRequirementRow(parentId);
    if (requirement && requirement.status !== "fulfilled" && !sourceMeetingId) {
      throw new Error("this root task must be decomposed by its required Boss-participating task meeting");
    }
    const stages = this.normalizeTaskFlowStages(actorId as string, stagesInput);
    return this.transaction(() => {
      const now = nowIso();
      const flowId = randomUUID();
      this.db.prepare(`
        INSERT INTO task_flows (id, parent_task_id, revision, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `).run(flowId, parentId, now, now);
      stages.forEach((stage, stagePosition) => {
        const stageId = randomUUID();
        this.db.prepare(`
          INSERT INTO task_flow_stages (
            id, flow_id, position, name, objective, status, created_at, activated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          stageId,
          flowId,
          stagePosition,
          stage.name,
          stage.objective,
          stagePosition === 0 ? "active" : "waiting",
          now,
          stagePosition === 0 ? now : null,
        );
        stage.tasks.forEach((taskInput, taskPosition) => {
          const task = this.insertTask({
            actorId,
            parentId,
            issuerId: actorId as string,
            assigneeId: taskInput.assigneeId,
            title: taskInput.title,
            description: taskInput.description,
            acceptanceCriteria: taskInput.acceptanceCriteria,
            sourceMeetingId,
          }, false);
          this.db.prepare(`
            INSERT INTO task_flow_stage_tasks (stage_id, task_id, position, completion_required)
            VALUES (?, ?, ?, 1)
          `).run(stageId, task.id, taskPosition);
        });
      });
      this.audit({
        actorId,
        action: "task.flow_created",
        entityType: "task",
        entityId: parentId,
        after: { flowId, sourceMeetingId: sourceMeetingId ?? null, stages },
      });
      this.reconcileTaskPromptPool();
      return this.taskFlowDetail(flowId)!;
    });
  }

  updateTaskFlow(actorId: string, input: {
    parentId: string;
    expectedRevision: number;
    operation: "append" | "replace_waiting";
    stages: TaskFlowStageInput[];
    reason: string;
  }) {
    this.requireAgentMember(actorId);
    const parent = this.getTaskRow(input.parentId);
    if (parent.assignee_id !== actorId) throw new Error("only the parent task assignee can update its task flow");
    this.assertTaskActionable(parent, "update a task flow");
    if (parent.status !== "in_progress") throw new Error("task flows can only be updated while the parent is in progress");
    if (input.operation !== "append" && input.operation !== "replace_waiting") throw new Error("task flow update operation is invalid");
    const stages = this.normalizeTaskFlowStages(actorId, input.stages, input.operation === "replace_waiting");
    const reason = required(input.reason, "reason");
    const flow = this.db.prepare("SELECT * FROM task_flows WHERE parent_task_id = ?").get(input.parentId) as Row | undefined;
    if (!flow) throw new Error("task flow not found");
    if (Number(flow.revision) !== Number(input.expectedRevision)) throw new Error("task flow revision conflict");
    return this.transaction(() => {
      const now = nowIso();
      if (input.operation === "replace_waiting") {
        const waiting = this.db.prepare(`
          SELECT * FROM task_flow_stages WHERE flow_id = ? AND status = 'waiting' ORDER BY position
        `).all(flow.id) as Row[];
        for (const stage of waiting) {
          this.db.prepare(`
            UPDATE task_flow_stages SET status = 'retired', retired_at = ? WHERE id = ?
          `).run(now, stage.id);
          this.audit({ actorId, action: "task.flow_stage_retired", entityType: "task", entityId: input.parentId, reason, after: { stageId: stage.id } });
        }
      } else if (stages.length === 0) {
        throw new Error("append requires at least one stage");
      }
      let position = Number((this.db.prepare("SELECT COALESCE(MAX(position), -1) AS value FROM task_flow_stages WHERE flow_id = ?")
        .get(flow.id) as Row).value) + 1;
      const hasIncomplete = Boolean(this.db.prepare(`
        SELECT 1 AS ok FROM task_flow_stages WHERE flow_id = ? AND status NOT IN ('completed', 'retired') LIMIT 1
      `).get(flow.id));
      stages.forEach((stage, stageIndex) => {
        const stageId = randomUUID();
        const activate = !hasIncomplete && stageIndex === 0;
        this.db.prepare(`
          INSERT INTO task_flow_stages (
            id, flow_id, position, name, objective, status, created_at, activated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(stageId, flow.id, position++, stage.name, stage.objective, activate ? "active" : "waiting", now, activate ? now : null);
        stage.tasks.forEach((taskInput, taskPosition) => {
          const task = this.insertTask({
            actorId,
            parentId: input.parentId,
            issuerId: actorId,
            assigneeId: taskInput.assigneeId,
            title: taskInput.title,
            description: taskInput.description,
            acceptanceCriteria: taskInput.acceptanceCriteria,
          }, false);
          this.db.prepare(`
            INSERT INTO task_flow_stage_tasks (stage_id, task_id, position, completion_required)
            VALUES (?, ?, ?, 1)
          `).run(stageId, task.id, taskPosition);
        });
      });
      this.db.prepare("UPDATE task_flows SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, flow.id);
      this.audit({
        actorId,
        action: "task.flow_updated",
        entityType: "task",
        entityId: input.parentId,
        reason,
        after: { flowId: flow.id, operation: input.operation, stages },
      });
      this.reconcileTaskPromptPool();
      return this.taskFlowDetail(flow.id)!;
    });
  }

  private normalizeTaskFlowStages(actorId: string, input: TaskFlowStageInput[], allowEmpty = false) {
    if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) throw new Error("at least one task flow stage is required");
    return input.map((stage, stageIndex) => {
      if (!Array.isArray(stage?.tasks) || stage.tasks.length === 0) throw new Error(`stages[${stageIndex}].tasks must contain at least one task`);
      return {
        name: required(stage.name, `stages[${stageIndex}].name`),
        objective: required(stage.objective, `stages[${stageIndex}].objective`),
        tasks: stage.tasks.map((task, taskIndex) => {
          if (!this.isDirectReport(actorId, task.assigneeId)) {
            throw new Error(`stages[${stageIndex}].tasks[${taskIndex}].assigneeId must be a direct report`);
          }
          return {
            title: required(task.title, `stages[${stageIndex}].tasks[${taskIndex}].title`),
            description: required(task.description, `stages[${stageIndex}].tasks[${taskIndex}].description`),
            acceptanceCriteria: required(task.acceptanceCriteria, `stages[${stageIndex}].tasks[${taskIndex}].acceptanceCriteria`),
            assigneeId: task.assigneeId,
          };
        }),
      };
    });
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
    const existingFlow = this.db.prepare("SELECT id FROM task_flows WHERE parent_task_id = ?").get(input.parentId) as Row | undefined;
    if (!existingFlow) {
      const flow = this.createTaskFlow(actorId, {
        parentId: input.parentId,
        stages: [{ name: "阶段 1", objective: input.description, tasks: [input] }],
      });
      return this.readTask(actorId, flow.stages[0]!.taskIds[0]!, false);
    }
    return this.transaction(() => {
      const stage = this.db.prepare(`
        SELECT * FROM task_flow_stages WHERE flow_id = ? AND status = 'active' ORDER BY position LIMIT 1
      `).get(existingFlow.id) as Row | undefined;
      if (!stage) throw new Error("the parent task has no active stage for a legacy child task");
      const task = this.insertTask({
        actorId,
        parentId: input.parentId,
        issuerId: actorId,
        assigneeId: input.assigneeId,
        title: input.title,
        description: input.description,
        acceptanceCriteria: input.acceptanceCriteria,
      }, false);
      const position = Number((this.db.prepare("SELECT COALESCE(MAX(position), -1) AS value FROM task_flow_stage_tasks WHERE stage_id = ?")
        .get(stage.id) as Row).value) + 1;
      this.db.prepare(`
        INSERT INTO task_flow_stage_tasks (stage_id, task_id, position, completion_required) VALUES (?, ?, ?, 1)
      `).run(stage.id, task.id, position);
      this.audit({ actorId, action: "task.flow_legacy_child_appended", entityType: "task", entityId: input.parentId, after: { stageId: stage.id, taskId: task.id } });
      this.reconcileTaskPromptPool();
      return this.readTask(actorId, task.id, false);
    });
  }

  startTask(actorId: string, taskId: string) {
    const member = this.requireAgentMember(actorId);
    const before = this.getTaskRow(taskId);
    this.assertTaskActionable(before, "start the task");
    if (before.assignee_id !== member.id) throw new Error("only the assignee can start a task");
    if (before.status !== "assigned") throw new Error("only assigned tasks can start");
    const now = nowIso();
    this.transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ?")
        .run(now, now, now, taskId);
      this.audit({ actorId, action: "task.started", entityType: "task", entityId: taskId, before: mapTaskRow(before) });
      this.reconcileTaskPromptPool();
    });
    return this.readTask(actorId, taskId, false);
  }

  addTaskProgress(actorId: string, taskId: string, body: string) {
    this.requireAgentMember(actorId);
    const task = this.getTaskRow(taskId);
    this.assertTaskActionable(task, "report task progress");
    if (task.assignee_id !== actorId) throw new Error("only the assignee can report progress");
    if (task.status !== "assigned" && task.status !== "in_progress" && task.status !== "blocked") {
      throw new Error("task is not accepting progress");
    }
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
      this.reconcileTaskPromptPool();
    });
    return this.readTask(actorId, taskId, false);
  }

  reviseTask(actorId: Actor, taskId: string, patch: { title?: string; description?: string; acceptanceCriteria?: string }, reason: string) {
    const before = this.getTaskRow(taskId);
    this.assertTaskActionable(before, "revise the task");
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
      this.reconcileTaskPromptPool();
    });
    return this.readTask(actorId, taskId, false);
  }

  blockTask(actorId: string, taskId: string, reason: string) {
    this.requireAgentMember(actorId);
    const before = this.getTaskRow(taskId);
    this.assertTaskActionable(before, "block the task");
    if (before.assignee_id !== actorId) throw new Error("only the assignee can block a task");
    if (before.status !== "assigned" && before.status !== "in_progress") throw new Error("task cannot be blocked in its current state");
    const now = nowIso();
    const blockEventId = randomUUID();
    const normalizedReason = required(reason, "reason");
    this.transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'blocked', blocked_reason = ?, blocked_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ?")
        .run(normalizedReason, now, now, now, taskId);
      this.audit({ actorId, action: "task.blocked", entityType: "task", entityId: taskId, reason: normalizedReason, before: mapTaskRow(before), after: { blockEventId } });
      if (before.issuer_id === "boss") {
        if (this.bossEmailEnabled) {
          this.queueBossTaskActionEmail(taskId, "block_escalated", blockEventId, {
            reason: normalizedReason,
            blockedReason: normalizedReason,
            parentTaskId: before.parent_id,
          }, now);
        }
      } else if (before.issuer_id !== actorId) {
        const prompt = [
          "【Company OS 任务阻塞上报】",
          `通知 ID：${blockEventId}（同一通知只处理一次）`,
          `任务：${before.title}`,
          `任务 ID：${before.id}`,
          `负责人：${before.assignee_id}`,
          `阻塞原因：${normalizedReason}`,
          "该阻塞审查事项已进入你的任务回转提示池。请读取任务真实现状，判断是否需要向上升级、给出解决建议并解除阻塞，或申请 Boss 取消审批。",
        ].join("\n");
        this.insertTaskAgentDispatch(taskId, before.issuer_id, "block_escalated", prompt, now, blockEventId);
      }
      this.reconcileTaskPromptPool();
    });
    return this.readTask(actorId, taskId, false);
  }

  unblockTask(actorId: Actor, taskId: string, reason: string) {
    const before = this.getTaskRow(taskId);
    this.assertTaskActionable(before, "unblock the task");
    if (actorId !== "boss") this.requireAgentMember(actorId);
    if (actorId !== "boss" && before.assignee_id !== actorId && before.issuer_id !== actorId) {
      throw new Error("only the assignee, issuer, or Boss can unblock a task");
    }
    if (before.status !== "blocked") throw new Error("only blocked tasks can be unblocked");
    const now = nowIso();
    const guidanceEventId = randomUUID();
    const normalizedReason = required(reason, "reason");
    this.transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'in_progress', blocked_reason = NULL, blocked_at = NULL, updated_at = ?, last_activity_at = ? WHERE id = ?")
        .run(now, now, taskId);
      this.audit({ actorId, action: "task.unblocked", entityType: "task", entityId: taskId, reason: normalizedReason, before: mapTaskRow(before), after: { guidanceEventId } });
      if (actorId !== before.assignee_id) {
        const prompt = [
          "【Company OS 阻塞解决建议】",
          `通知 ID：${guidanceEventId}（同一通知只处理一次）`,
          `任务：${before.title}`,
          `任务 ID：${before.id}`,
          `原阻塞原因：${before.blocked_reason ?? "未记录"}`,
          `派发者解决建议：${normalizedReason}`,
          "任务已恢复为 in_progress，并重新进入你的执行回转池。请读取最新任务，按建议继续实际推进并记录进度。",
        ].join("\n");
        this.insertTaskAgentDispatch(taskId, before.assignee_id, "block_guidance", prompt, now, guidanceEventId);
      }
      this.cancelPendingTaskCancelRequest(taskId, actorId, "task was unblocked");
      this.reconcileTaskPromptPool();
    });
    return this.readTask(actorId, taskId, false);
  }

  submitTask(
    actorId: string,
    taskId: string,
    summary: string,
    evidence: EvidenceInput[],
    gitLocation: VerifiedGitLocation,
  ) {
    this.requireAgentMember(actorId);
    const before = this.getTaskRow(taskId);
    this.assertTaskActionable(before, "submit the task");
    if (before.assignee_id !== actorId) throw new Error("only the assignee can submit a task");
    if (before.status !== "in_progress") throw new Error("only in-progress tasks can be submitted");
    const requirement = this.taskMeetingRequirementRow(taskId);
    if (requirement && requirement.status !== "fulfilled") {
      throw new Error("the required Boss-participating task meeting must produce a task flow before submission");
    }
    if (this.taskFlowIsComplete(taskId) === false) throw new Error("all child tasks and task flow stages must be completed before review");
    if (!Array.isArray(evidence) || evidence.length === 0) throw new Error("at least one proof or artifact is required");
    const normalizedGitLocation = normalizeVerifiedGitLocation(gitLocation);
    const activeChildren = (this.db.prepare(`
      SELECT id, status FROM tasks WHERE parent_id = ? AND status NOT IN ('closed', 'canceled') ORDER BY created_at
    `).all(taskId) as Row[]).filter((child) => this.taskAvailability(child.id) !== "retired");
    if (activeChildren.length > 0) throw new Error(`all direct child tasks must be terminal before review: ${activeChildren.map((row) => row.id).join(", ")}`);
    const submissionId = randomUUID();
    const now = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO task_submissions (
          id, task_id, submitter_id, summary, evidence_json, status,
          git_remote_url, git_branch, git_commit, git_verified_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      `).run(
        submissionId,
        taskId,
        actorId,
        required(summary, "summary"),
        JSON.stringify(normalizeEvidence(evidence)),
        normalizedGitLocation.remoteUrl,
        normalizedGitLocation.branch,
        normalizedGitLocation.commit,
        normalizedGitLocation.verifiedAt,
        now,
      );
      this.db.prepare("UPDATE tasks SET status = 'review', submitted_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ?")
        .run(now, now, now, taskId);
      this.audit({
        actorId,
        action: "task.submitted",
        entityType: "task",
        entityId: taskId,
        before: mapTaskRow(before),
        after: { submissionId, summary, evidence, gitLocation: normalizedGitLocation },
      });
      if (before.parent_id === null && before.issuer_id === "boss" && this.bossEmailEnabled) {
        this.queueTaskReviewEmail(taskId, submissionId, now);
      }
      this.reconcileTaskPromptPool();
    });
    return this.readTask(actorId, taskId, false);
  }

  reviewTask(
    actorId: Actor,
    taskId: string,
    decision: "accept" | "reject",
    feedback?: string,
    reviewReport?: TaskReviewReport,
  ) {
    const before = this.getTaskRow(taskId);
    this.assertTaskActionable(before, "review the task");
    if (actorId !== "boss") this.requireAgentMember(actorId);
    if (before.issuer_id !== actorId) throw new Error("only the task issuer can review a task");
    if (before.status !== "review") throw new Error("task is not awaiting review");
    const submission = this.db.prepare("SELECT * FROM task_submissions WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(taskId) as Row | undefined;
    if (!submission) throw new Error("pending task submission not found");
    const reviewer = this.getMember(actorId);
    const evidence = parseJson<EvidenceInput[]>(submission.evidence_json, []);
    const normalizedReport = actorId === "boss" && !reviewReport
      ? null
      : normalizeTaskReviewReport(reviewReport, decision, evidence.length);
    if (actorId !== "boss") {
      const inspection = this.db.prepare(`
        SELECT read_at FROM task_review_inspections WHERE submission_id = ? AND reviewer_id = ?
      `).get(submission.id, actorId) as Row | undefined;
      if (!inspection || inspection.read_at < submission.created_at) {
        throw new Error("reviewer must read the current task submission before reviewing it");
      }
    }
    const reportFeedback = normalizedReport ? taskReviewReportText(normalizedReport) : null;
    const normalizedFeedback = actorId === "boss"
      ? decision === "reject" ? required(feedback, "feedback") : feedback?.trim() || null
      : feedback?.trim() || reportFeedback;
    const now = this.nextTaskActivityAt(taskId, before.updated_at);
    this.transaction(() => {
      if (decision === "accept") {
        this.db.prepare("UPDATE task_submissions SET status = 'accepted', reviewer_id = ?, feedback = ?, review_report_json = ?, reviewed_at = ? WHERE id = ?")
          .run(actorId, normalizedFeedback, normalizedReport ? JSON.stringify(normalizedReport) : null, now, submission.id);
        this.db.prepare("UPDATE tasks SET status = 'closed', review_feedback = ?, closed_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ?")
          .run(normalizedFeedback, now, now, now, taskId);
        this.audit({ actorId, action: "task.closed", entityType: "task", entityId: taskId, reason: normalizedFeedback ?? undefined, before: mapTaskRow(before) });
      } else {
        this.db.prepare("UPDATE task_submissions SET status = 'rejected', reviewer_id = ?, feedback = ?, review_report_json = ?, reviewed_at = ? WHERE id = ?")
          .run(actorId, normalizedFeedback, normalizedReport ? JSON.stringify(normalizedReport) : null, now, submission.id);
        this.db.prepare("UPDATE tasks SET status = 'in_progress', review_feedback = ?, submitted_at = NULL, updated_at = ?, last_activity_at = ? WHERE id = ?")
          .run(normalizedFeedback, now, now, taskId);
        this.audit({ actorId, action: "task.rejected", entityType: "task", entityId: taskId, reason: normalizedFeedback ?? undefined, before: mapTaskRow(before) });
      }
      this.queueTaskReviewNotification(
        before,
        reviewer,
        decision === "accept" ? "review_accepted" : "review_rejected",
        normalizedFeedback,
        now,
      );
      this.reconcileTaskPromptPool();
    });
    return this.readTask(actorId, taskId, false);
  }

  private queueTaskReviewNotification(
    task: Row,
    reviewer: Row,
    kind: "review_accepted" | "review_rejected",
    feedback: string | null,
    createdAt: string,
  ) {
    const dispatchId = randomUUID();
    const prompt = buildTaskReviewNotificationPrompt(task, reviewer, kind, feedback, dispatchId);
    this.insertTaskAgentDispatch(task.id, task.assignee_id, kind, prompt, createdAt, undefined, dispatchId);
  }

  private insertTaskAgentDispatch(
    taskId: string,
    targetAgentId: string,
    kind: TaskAgentDispatchKind,
    prompt: string,
    createdAt: string,
    sourceEventId?: string,
    requestedDispatchId?: string,
  ) {
    const dispatchId = requestedDispatchId ?? randomUUID();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO task_agent_dispatches (
        id, task_id, target_agent_id, kind, source_event_id, prompt, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(dispatchId, taskId, targetAgentId, kind, sourceEventId ?? null, prompt, createdAt);
    if (Number(result.changes) === 0 && sourceEventId) {
      const existing = this.db.prepare(`
        SELECT id FROM task_agent_dispatches WHERE kind = ? AND source_event_id = ? AND target_agent_id = ?
      `).get(kind, sourceEventId, targetAgentId) as Row;
      return existing.id as string;
    }
    this.audit({
      actorId: "system",
      action: taskDispatchAuditAction(kind, "queued"),
      entityType: "task",
      entityId: taskId,
      after: { dispatchId, kind, targetAgentId, sourceEventId: sourceEventId ?? null },
    });
    return dispatchId;
  }

  reassignTask(actorId: Actor, taskId: string, assigneeId: string, reason: string) {
    const before = this.getTaskRow(taskId);
    this.assertTaskActionable(before, "reassign the task");
    if (actorId !== "boss") this.requireAgentMember(actorId);
    if (actorId !== "boss" && before.issuer_id !== actorId) throw new Error("only the issuer or Boss can reassign a task");
    if (!ACTIVE_TASK_STATUSES.has(before.status as TaskStatus) || before.status === "review") throw new Error("task cannot be reassigned in its current state");
    if (this.taskFlowIsComplete(taskId) === false) throw new Error("a parent task with an unfinished task flow cannot be reassigned");
    if (!this.isDirectReport(before.issuer_id, assigneeId)) throw new Error("new assignee must remain a direct report of the task issuer");
    if (this.openDirectChildRows(taskId).length > 0) throw new Error("task with active child tasks cannot be reassigned");
    const now = this.nextTaskActivityAt(taskId, before.updated_at);
    this.transaction(() => {
      this.db.prepare(`
        UPDATE tasks SET assignee_id = ?, status = 'assigned', blocked_reason = NULL, review_feedback = NULL,
          blocked_at = NULL, started_at = NULL, submitted_at = NULL, updated_at = ?, last_activity_at = ? WHERE id = ?
      `).run(assigneeId, now, now, taskId);
      this.audit({ actorId, action: "task.reassigned", entityType: "task", entityId: taskId, reason: required(reason, "reason"), before: mapTaskRow(before), after: { assigneeId } });
      this.cancelPendingTaskCancelRequest(taskId, actorId, "task was reassigned");
      this.reconcileTaskPromptPool();
    });
    return this.readTask(actorId, taskId, false);
  }

  cancelTask(actorId: Actor, taskId: string, reason: string) {
    const before = this.getTaskRow(taskId);
    this.assertTaskActionable(before, "cancel the task");
    if (actorId !== "boss") this.requireAgentMember(actorId);
    if (actorId !== "boss" && before.issuer_id !== actorId) throw new Error("only the issuer or Boss can cancel a task");
    if (actorId !== "boss" && before.status === "blocked") {
      throw new Error("blocked tasks require a Boss cancellation request");
    }
    return this.performTaskCancellation(actorId, before, reason);
  }

  requestTaskCancellation(actorId: string, taskId: string, reason: string) {
    this.requireAgentMember(actorId);
    const task = this.getTaskRow(taskId);
    this.assertTaskActionable(task, "request task cancellation");
    if (task.issuer_id !== actorId) throw new Error("only the task issuer can request cancellation");
    if (task.status !== "blocked") throw new Error("only blocked tasks require a Boss cancellation request");
    const openChildren = this.openDirectChildRows(taskId);
    if (openChildren.length > 0) throw new Error("cascade cancellation is forbidden; resolve child tasks first");
    const existing = this.db.prepare("SELECT * FROM task_cancel_requests WHERE task_id = ? AND status = 'pending'").get(taskId) as Row | undefined;
    if (existing) return mapTaskCancelRequest(existing);
    return this.transaction(() => {
      const id = randomUUID();
      const createdAt = nowIso();
      const normalizedReason = required(reason, "reason");
      this.db.prepare(`
        INSERT INTO task_cancel_requests (id, task_id, requester_id, reason, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `).run(id, taskId, actorId, normalizedReason, createdAt);
      this.audit({
        actorId,
        action: "task.cancel_requested",
        entityType: "task",
        entityId: taskId,
        reason: normalizedReason,
        after: { requestId: id },
      });
      if (this.bossEmailEnabled) {
        this.queueBossTaskActionEmail(taskId, "cancel_requested", id, {
          requestId: id,
          requesterId: actorId,
          reason: normalizedReason,
          blockedReason: task.blocked_reason,
        }, createdAt);
      }
      return mapTaskCancelRequest(this.db.prepare("SELECT * FROM task_cancel_requests WHERE id = ?").get(id) as Row);
    });
  }

  reviewTaskCancellationRequest(
    actorId: "boss",
    taskId: string,
    requestId: string,
    decision: "accept" | "reject",
    feedback?: string,
  ) {
    if (actorId !== "boss") throw new Error("only Boss can review task cancellation requests");
    const request = this.db.prepare("SELECT * FROM task_cancel_requests WHERE id = ? AND task_id = ?").get(requestId, taskId) as Row | undefined;
    if (!request) throw new Error("task cancellation request not found");
    if (request.status !== "pending") throw new Error("task cancellation request is no longer pending");
    const task = this.getTaskRow(taskId);
    if (task.status !== "blocked") {
      this.transaction(() => this.cancelPendingTaskCancelRequest(taskId, "boss", "task is no longer blocked"));
      throw new Error("task cancellation request is stale because the task is no longer blocked");
    }
    const now = nowIso();
    if (decision === "accept") {
      return this.transaction(() => {
        this.db.prepare(`
          UPDATE task_cancel_requests SET status = 'approved', reviewer_id = 'boss', feedback = ?, reviewed_at = ? WHERE id = ?
        `).run(feedback?.trim() || null, now, requestId);
        const canceled = this.performTaskCancellation("boss", task, request.reason, requestId);
        this.queueCancelRequestResultNotifications(task, request, "cancel_request_accepted", feedback?.trim() || null, now);
        this.audit({
          actorId: "boss",
          action: "task.cancel_request_approved",
          entityType: "task",
          entityId: taskId,
          reason: feedback?.trim() || undefined,
          after: { requestId },
        });
        return { request: mapTaskCancelRequest(this.db.prepare("SELECT * FROM task_cancel_requests WHERE id = ?").get(requestId) as Row), task: canceled };
      });
    }
    const normalizedFeedback = required(feedback, "feedback");
    return this.transaction(() => {
      this.db.prepare(`
        UPDATE task_cancel_requests SET status = 'rejected', reviewer_id = 'boss', feedback = ?, reviewed_at = ? WHERE id = ?
      `).run(normalizedFeedback, now, requestId);
      this.queueCancelRequestResultNotifications(task, request, "cancel_request_rejected", normalizedFeedback, now);
      this.audit({
        actorId: "boss",
        action: "task.cancel_request_rejected",
        entityType: "task",
        entityId: taskId,
        reason: normalizedFeedback,
        after: { requestId },
      });
      return {
        request: mapTaskCancelRequest(this.db.prepare("SELECT * FROM task_cancel_requests WHERE id = ?").get(requestId) as Row),
        task: this.readTask("boss", taskId, false),
      };
    });
  }

  private performTaskCancellation(actorId: Actor, before: Row, reason: string, requestId?: string) {
    const taskId = before.id as string;
    if (TERMINAL_TASK_STATUSES.has(before.status as TaskStatus)) throw new Error("task is already terminal");
    const openChildren = this.openDirectChildRows(taskId);
    if (openChildren.length > 0) throw new Error("cascade cancellation is forbidden; resolve child tasks first");
    const now = nowIso();
    return this.transaction(() => {
      const cancellationId = randomUUID();
      const normalizedReason = required(reason, "reason");
      this.db.prepare(`
        INSERT INTO task_cancellation_events (
          id, task_id, actor_id, request_id, status_before, reason, canceled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(cancellationId, taskId, actorId, requestId ?? null, before.status, normalizedReason, now);
      this.db.prepare("UPDATE tasks SET status = 'canceled', canceled_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ?")
        .run(now, now, now, taskId);
      this.audit({ actorId, action: "task.canceled", entityType: "task", entityId: taskId, reason: normalizedReason, before: mapTaskRow(before), after: { cancellationId, requestId: requestId ?? null } });
      if (actorId !== before.assignee_id && !requestId) {
        const prompt = [
          "【Company OS 任务取消通知】",
          `通知 ID：${cancellationId}（同一通知只处理一次）`,
          `任务：${before.title}`,
          `任务 ID：${before.id}`,
          `取消人：${actorId}`,
          `取消原因：${normalizedReason}`,
          "任务现已取消。原取消人或 Boss 后续可恢复到取消前状态。",
        ].join("\n");
        this.insertTaskAgentDispatch(taskId, before.assignee_id, "cancel_request_accepted", prompt, now, cancellationId);
      }
      this.cancelPendingTaskCancelRequest(taskId, actorId, requestId ? "cancellation request approved" : "task canceled directly", requestId);
      this.reconcileTaskPromptPool();
      return this.readTask(actorId, taskId, false);
    });
  }

  private cancelPendingTaskCancelRequest(taskId: string, actorId: Actor, reason: string, exceptRequestId?: string) {
    const rows = this.db.prepare(`
      SELECT * FROM task_cancel_requests WHERE task_id = ? AND status = 'pending'
        ${exceptRequestId ? "AND id != ?" : ""}
    `).all(...(exceptRequestId ? [taskId, exceptRequestId] : [taskId])) as Row[];
    for (const row of rows) {
      const completedAt = nowIso();
      this.db.prepare(`
        UPDATE task_cancel_requests SET status = 'canceled', reviewer_id = ?, feedback = ?, reviewed_at = ? WHERE id = ?
      `).run(actorId, reason, completedAt, row.id);
      this.audit({
        actorId,
        action: "task.cancel_request_canceled",
        entityType: "task",
        entityId: taskId,
        reason,
        after: { requestId: row.id },
      });
    }
  }

  private queueCancelRequestResultNotifications(
    task: Row,
    request: Row,
    kind: "cancel_request_accepted" | "cancel_request_rejected",
    feedback: string | null,
    createdAt: string,
  ) {
    const recipients = [...new Set([request.requester_id as string, task.assignee_id as string])].filter((id) => id !== "boss");
    for (const recipient of recipients) {
      const id = randomUUID();
      const prompt = [
        "【Company OS 任务取消申请结果】",
        `通知 ID：${id}（同一通知只处理一次）`,
        `任务：${task.title}`,
        `任务 ID：${task.id}`,
        `审批结果：${kind === "cancel_request_accepted" ? "Boss 已批准取消" : "Boss 已驳回取消申请"}`,
        `申请理由：${request.reason}`,
        ...(feedback ? [`Boss 意见：${feedback}`] : []),
        kind === "cancel_request_accepted"
          ? "任务现已取消，无需继续执行。"
          : "任务保持阻塞，请读取最新任务并继续处理阻塞或按 Boss 意见调整方案。",
      ].join("\n");
      this.insertTaskAgentDispatch(task.id, recipient, kind, prompt, createdAt, request.id);
    }
  }

  correctTaskTerminalDecision(
    actorId: Actor,
    taskId: string,
    action: TaskCorrectionAction,
    reason: string,
    reviewReport?: TaskReviewReport,
  ) {
    if (actorId !== "boss") this.requireAgentMember(actorId);
    const task = this.getTaskRow(taskId);
    const normalizedReason = required(reason, "reason");
    const ancestors: Row[] = [];
    let parentId = task.parent_id as string | null;
    while (parentId) {
      const parent = this.getTaskRow(parentId);
      ancestors.push(parent);
      parentId = parent.parent_id as string | null;
    }
    const highestCanceledAncestor = [...ancestors].reverse().find((ancestor) => ancestor.status === "canceled");
    if (highestCanceledAncestor) {
      throw new Error(`restore the highest canceled ancestor first: ${highestCanceledAncestor.id}`);
    }

    let sourceSubmission: Row | undefined;
    let sourceCancellation: Row | undefined;
    let backfillSourceCancellation = false;
    let normalizedReport: TaskReviewReport | null = null;
    let correctionKind: "acceptance_revoked" | "cancellation_restored";
    let restoredStatus: TaskStatus = "in_progress";
    let originalDecider: string;
    if (action === "revoke_acceptance") {
      if (task.status !== "closed") throw new Error("only a closed task can fail a second acceptance review");
      sourceSubmission = this.db.prepare(`
        SELECT * FROM task_submissions WHERE task_id = ? AND status = 'accepted'
        ORDER BY reviewed_at DESC, created_at DESC LIMIT 1
      `).get(taskId) as Row | undefined;
      if (!sourceSubmission) throw new Error("accepted task submission not found");
      originalDecider = sourceSubmission.reviewer_id as string;
      if (actorId !== "boss" && originalDecider !== actorId) {
        throw new Error("only Boss or the original reviewer can revoke this acceptance");
      }
      const evidence = parseJson<EvidenceInput[]>(sourceSubmission.evidence_json, []);
      normalizedReport = actorId === "boss" && !reviewReport
        ? null
        : normalizeTaskReviewReport(reviewReport, "reject", evidence.length);
      correctionKind = "acceptance_revoked";
    } else {
      if (task.status !== "canceled") throw new Error("only a canceled task can be restored");
      sourceCancellation = this.db.prepare(`
        SELECT * FROM task_cancellation_events
        WHERE task_id = ? AND restored_at IS NULL ORDER BY canceled_at DESC LIMIT 1
      `).get(taskId) as Row | undefined;
      if (!sourceCancellation) {
        const cancellationAudit = this.db.prepare(`
          SELECT * FROM audit_events
          WHERE entity_type = 'task' AND entity_id = ? AND action = 'task.canceled'
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get(taskId) as Row | undefined;
        const before = cancellationAudit
          ? parseJson<Record<string, unknown> | null>(cancellationAudit.before_json, null)
          : null;
        const statusBefore = before?.status;
        if (!cancellationAudit || !(["assigned", "in_progress", "review", "blocked"] as unknown[]).includes(statusBefore)) {
          throw new Error("active task cancellation event not found");
        }
        sourceCancellation = {
          id: randomUUID(),
          task_id: taskId,
          actor_id: cancellationAudit.actor_id,
          request_id: null,
          status_before: statusBefore,
          reason: cancellationAudit.reason || "historical task cancellation",
          canceled_at: task.canceled_at || cancellationAudit.created_at,
          restored_by: null,
          restored_reason: null,
          restored_at: null,
        };
        backfillSourceCancellation = true;
      }
      originalDecider = sourceCancellation.actor_id as string;
      if (actorId !== "boss" && originalDecider !== actorId) {
        throw new Error("only Boss or the original canceler can restore this task");
      }
      restoredStatus = sourceCancellation.status_before as TaskStatus;
      if (restoredStatus === "review") {
        const pending = this.db.prepare("SELECT 1 AS ok FROM task_submissions WHERE task_id = ? AND status = 'pending'").get(taskId);
        if (!pending) restoredStatus = "in_progress";
      }
      correctionKind = "cancellation_restored";
    }

    const correctionId = randomUUID();
    const now = nowIso();
    return this.transaction(() => {
      if (backfillSourceCancellation) {
        this.db.prepare(`
          INSERT INTO task_cancellation_events (
            id, task_id, actor_id, request_id, status_before, reason, canceled_at
          ) VALUES (?, ?, ?, NULL, ?, ?, ?)
        `).run(
          sourceCancellation!.id,
          sourceCancellation!.task_id,
          sourceCancellation!.actor_id,
          sourceCancellation!.status_before,
          sourceCancellation!.reason,
          sourceCancellation!.canceled_at,
        );
        this.audit({
          actorId: "system",
          action: "task.cancellation_event_backfilled",
          entityType: "task",
          entityId: taskId,
          reason: "reconstructed from pre-v13 task.canceled audit",
          after: {
            cancellationId: sourceCancellation!.id,
            actorId: sourceCancellation!.actor_id,
            statusBefore: sourceCancellation!.status_before,
            canceledAt: sourceCancellation!.canceled_at,
          },
        });
      }
      this.db.prepare(`
        INSERT INTO task_corrections (id, target_task_id, kind, actor_id, reason, report_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(correctionId, taskId, correctionKind, actorId, normalizedReason, normalizedReport ? JSON.stringify(normalizedReport) : null, now);

      const impacts: Array<{ row: Row; role: "target" | "ancestor"; before: TaskStatus; after: TaskStatus; submissionId?: string }> = [];
      if (action === "revoke_acceptance") {
        this.db.prepare(`
          UPDATE tasks SET status = 'in_progress', review_feedback = ?, submitted_at = NULL,
            closed_at = NULL, canceled_at = NULL, updated_at = ?, last_activity_at = ? WHERE id = ?
        `).run(normalizedReason, now, now, taskId);
        impacts.push({ row: task, role: "target", before: "closed", after: "in_progress", submissionId: sourceSubmission!.id });
      } else {
        this.db.prepare(`
          UPDATE tasks SET status = ?, canceled_at = NULL, updated_at = ?, last_activity_at = ? WHERE id = ?
        `).run(restoredStatus, now, now, taskId);
        this.db.prepare(`
          UPDATE task_cancellation_events SET restored_by = ?, restored_reason = ?, restored_at = ? WHERE id = ?
        `).run(actorId, normalizedReason, now, sourceCancellation!.id);
        impacts.push({ row: task, role: "target", before: "canceled", after: restoredStatus });
      }

      for (const ancestor of ancestors) {
        if (ancestor.status === "closed") {
          this.db.prepare(`
            UPDATE tasks SET status = 'in_progress', closed_at = NULL, submitted_at = NULL,
              review_feedback = ?, updated_at = ?, last_activity_at = ? WHERE id = ?
          `).run(`Descendant correction ${correctionId}: ${normalizedReason}`, now, now, ancestor.id);
          impacts.push({ row: ancestor, role: "ancestor", before: "closed", after: "in_progress" });
        } else if (ancestor.status === "review") {
          const submission = this.db.prepare(`
            SELECT * FROM task_submissions WHERE task_id = ? AND status = 'pending'
            ORDER BY created_at DESC LIMIT 1
          `).get(ancestor.id) as Row | undefined;
          if (submission) {
            this.db.prepare(`
              UPDATE task_submissions SET status = 'invalidated', reviewer_id = ?, feedback = ?, reviewed_at = ? WHERE id = ?
            `).run(actorId, `Descendant correction ${correctionId}: ${normalizedReason}`, now, submission.id);
            this.db.prepare(`
              DELETE FROM task_review_email_notifications WHERE submission_id = ? AND status != 'sent'
            `).run(submission.id);
          }
          this.db.prepare(`
            UPDATE tasks SET status = 'in_progress', submitted_at = NULL, review_feedback = ?,
              updated_at = ?, last_activity_at = ? WHERE id = ?
          `).run(`Descendant correction ${correctionId}: ${normalizedReason}`, now, now, ancestor.id);
          impacts.push({ row: ancestor, role: "ancestor", before: "review", after: "in_progress", submissionId: submission?.id });
        }
      }

      for (const impact of impacts) {
        this.db.prepare(`
          INSERT INTO task_correction_impacts (
            correction_id, task_id, role, status_before, status_after, submission_id
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(correctionId, impact.row.id, impact.role, impact.before, impact.after, impact.submissionId ?? null);
      }

      const recipients = new Set<string>([task.assignee_id, originalDecider]);
      impacts.filter((impact) => impact.role === "ancestor").forEach((impact) => recipients.add(impact.row.assignee_id));
      recipients.delete("boss");
      recipients.delete(actorId);
      for (const recipient of recipients) {
        const prompt = [
          action === "revoke_acceptance"
            ? "【Company OS 二次审查不通过】"
            : "【Company OS 任务取消恢复】",
          `纠错 ID：${correctionId}（同一通知只处理一次）`,
          `任务：${task.title}`,
          `任务 ID：${task.id}`,
          `纠错人：${actorId}`,
          `原因：${normalizedReason}`,
          action === "revoke_acceptance"
            ? "原 accepted 提交与验收报告已永久保留；任务和必要祖先已恢复为 in_progress。请读取最新任务、按纠错意见整改并重新提交验收。"
            : `任务已从 canceled 恢复为 ${restoredStatus}。请读取最新任务并按恢复后的真实状态继续处理。`,
        ].join("\n");
        this.insertTaskAgentDispatch(taskId, recipient, correctionKind, prompt, now, correctionId);
      }
      this.audit({
        actorId,
        action: `task.${correctionKind}`,
        entityType: "task",
        entityId: taskId,
        reason: normalizedReason,
        before: mapTaskRow(task),
        after: { correctionId, impacts: impacts.map((impact) => ({ taskId: impact.row.id, before: impact.before, after: impact.after })) },
      });
      this.reconcileTaskPromptPool();
      return this.readTask(actorId, taskId, false);
    });
  }

  private mapTaskCorrection(row: Row): TaskCorrection {
    const impacts = this.db.prepare(`
      SELECT * FROM task_correction_impacts WHERE correction_id = ?
      ORDER BY CASE role WHEN 'target' THEN 0 ELSE 1 END, rowid
    `).all(row.id) as Row[];
    return {
      id: row.id,
      taskId: row.target_task_id,
      actorId: row.actor_id,
      action: row.kind === "acceptance_revoked" ? "revoke_acceptance" : "restore_cancellation",
      reason: row.reason,
      reviewReport: parseJson<TaskReviewReport | null>(row.report_json, null),
      createdAt: row.created_at,
      impacts: impacts.map((impact) => ({
        taskId: impact.task_id,
        statusBefore: impact.status_before,
        statusAfter: impact.status_after,
        invalidatedSubmissionId: impact.submission_id ?? null,
      })),
    };
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
  }, reconcile = true) {
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
    if (reconcile) this.reconcileTaskPromptPool();
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
    const availability = this.taskAvailability(task.id);
    if (availability !== "active") {
      const stage = this.taskStageRow(task.id);
      const flowParent = stage
        ? this.db.prepare(`
            SELECT t.* FROM task_flows f JOIN tasks t ON t.id = f.parent_task_id WHERE f.id = ?
          `).get(stage.flow_id) as Row | undefined
        : undefined;
      if (!flowParent || flowParent.assignee_id !== actorId) {
        throw new Error("task is not visible until its flow stage becomes active");
      }
    }
    let current: Row | undefined = task;
    while (current) {
      if (current.assignee_id === actorId || current.issuer_id === actorId) return;
      current = current.parent_id ? this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(current.parent_id) as Row | undefined : undefined;
    }
    throw new Error("task is outside the caller's responsibility tree");
  }

  private assertTaskActionable(task: Row, action: string) {
    const availability = this.taskAvailability(task.id);
    if (availability !== "active") throw new Error(`cannot ${action} while the task flow stage is ${availability}`);
  }

  private taskStageRow(taskId: string) {
    return this.db.prepare(`
      SELECT s.*, f.parent_task_id FROM task_flow_stage_tasks st
      JOIN task_flow_stages s ON s.id = st.stage_id
      JOIN task_flows f ON f.id = s.flow_id
      WHERE st.task_id = ?
    `).get(taskId) as Row | undefined;
  }

  private openDirectChildRows(taskId: string) {
    return (this.db.prepare(`
      SELECT id, status FROM tasks
      WHERE parent_id = ? AND status NOT IN ('closed', 'canceled') ORDER BY created_at, rowid
    `).all(taskId) as Row[]).filter((child) => this.taskAvailability(child.id) !== "retired");
  }

  private taskAvailability(taskId: string, visiting = new Set<string>()): "active" | "waiting_stage" | "suspended_stage" | "retired" {
    if (visiting.has(taskId)) return "suspended_stage";
    visiting.add(taskId);
    const stage = this.taskStageRow(taskId);
    if (!stage) return "active";
    if (stage.status === "retired") return "retired";
    if (stage.status === "waiting") return "waiting_stage";
    if (stage.status === "suspended") return "suspended_stage";
    const parentStage = this.taskStageRow(stage.parent_task_id);
    if (!parentStage) return "active";
    const parentAvailability = this.taskAvailability(stage.parent_task_id, visiting);
    return parentAvailability === "active" ? "active" : parentAvailability === "retired" ? "retired" : "suspended_stage";
  }

  private taskFlowDetail(flowId: string): TaskFlow | null {
    const flow = this.db.prepare("SELECT * FROM task_flows WHERE id = ?").get(flowId) as Row | undefined;
    if (!flow) return null;
    const stages = this.db.prepare(`
      SELECT * FROM task_flow_stages WHERE flow_id = ? ORDER BY position
    `).all(flowId) as Row[];
    return {
      id: flow.id,
      parentTaskId: flow.parent_task_id,
      revision: Number(flow.revision),
      createdAt: flow.created_at,
      updatedAt: flow.updated_at,
      stages: stages.map((stage) => {
        const tasks = this.db.prepare(`
          SELECT st.*, t.status FROM task_flow_stage_tasks st
          JOIN tasks t ON t.id = st.task_id WHERE st.stage_id = ? ORDER BY st.position
        `).all(stage.id) as Row[];
        const requiredTasks = tasks.filter((task) => Boolean(task.completion_required));
        return {
          id: stage.id,
          position: Number(stage.position),
          name: stage.name,
          objective: stage.objective,
          status: stage.status as TaskFlowStageStatus,
          taskIds: tasks.map((task) => task.task_id as string),
          requiredTaskCount: requiredTasks.length,
          closedTaskCount: requiredTasks.filter((task) => task.status === "closed").length,
          createdAt: stage.created_at,
          activatedAt: stage.activated_at ?? null,
          completedAt: stage.completed_at ?? null,
          suspendedAt: stage.suspended_at ?? null,
          retiredAt: stage.retired_at ?? null,
        };
      }),
    };
  }

  private reconcileTaskFlows() {
    if (!this.tableExists("task_flows")) return;
    const flows = this.db.prepare("SELECT * FROM task_flows ORDER BY created_at, rowid").all() as Row[];
    for (const flow of flows) {
      const stages = this.db.prepare(`
        SELECT * FROM task_flow_stages WHERE flow_id = ? AND status != 'retired' ORDER BY position
      `).all(flow.id) as Row[];
      const completion = new Map<string, boolean>();
      for (const stage of stages) {
        const pending = this.db.prepare(`
          SELECT 1 AS pending FROM task_flow_stage_tasks st
          JOIN tasks t ON t.id = st.task_id
          WHERE st.stage_id = ? AND st.completion_required = 1 AND t.status != 'closed' LIMIT 1
        `).get(stage.id);
        completion.set(stage.id, !pending);
      }
      const frontier = stages.find((stage) => !completion.get(stage.id));
      const now = nowIso();
      for (const stage of stages) {
        let status: TaskFlowStageStatus;
        if (completion.get(stage.id)) status = "completed";
        else if (stage.id === frontier?.id) status = "active";
        else status = stage.activated_at ? "suspended" : "waiting";
        if (stage.status === status) continue;
        this.db.prepare(`
          UPDATE task_flow_stages SET status = ?,
            activated_at = CASE WHEN ? = 'active' THEN COALESCE(activated_at, ?) ELSE activated_at END,
            completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END,
            suspended_at = CASE WHEN ? = 'suspended' THEN ? ELSE NULL END
          WHERE id = ?
        `).run(status, status, now, status, now, status, now, stage.id);
        this.audit({
          actorId: "system",
          action: `task.flow_stage_${status}`,
          entityType: "task",
          entityId: flow.parent_task_id,
          before: { stageId: stage.id, status: stage.status },
          after: { stageId: stage.id, status },
        });
      }
    }
  }

  private taskFlowIsComplete(parentTaskId: string) {
    const flow = this.db.prepare("SELECT id FROM task_flows WHERE parent_task_id = ?").get(parentTaskId) as Row | undefined;
    if (!flow) return null;
    return !this.db.prepare(`
      SELECT 1 AS pending FROM task_flow_stages WHERE flow_id = ? AND status NOT IN ('completed', 'retired') LIMIT 1
    `).get(flow.id);
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
      const effectiveDirect = direct.filter((child) => this.taskAvailability(child.id) !== "retired");
      const descendants = collectDescendants(row.id).filter((child) => this.taskAvailability(child.id) !== "retired");
      const availability = this.taskAvailability(row.id);
      const stale = availability === "active" && isTaskStale(row, now, this.staleAfterMs);
      const stage = this.taskStageRow(row.id);
      return {
        ...mapTaskRow(row),
        availability,
        flowStage: stage ? {
          flowId: stage.flow_id,
          stageId: stage.id,
          position: Number(stage.position),
          name: stage.name,
          objective: stage.objective,
          status: stage.status,
        } : null,
        childIds: effectiveDirect.map((child) => child.id),
        childCounts: {
          total: effectiveDirect.length,
          active: effectiveDirect.filter((child) => !TERMINAL_TASK_STATUSES.has(child.status as TaskStatus)).length,
          closed: effectiveDirect.filter((child) => child.status === "closed").length,
          canceled: effectiveDirect.filter((child) => child.status === "canceled").length,
        },
        risks: {
          blockedDescendants: descendants.filter((child) => child.status === "blocked").length,
          staleDescendants: descendants.filter((child) => this.taskAvailability(child.id) === "active" && isTaskStale(child, now, this.staleAfterMs)).length,
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

  deleteNotice(actorId: Actor, noticeId: string) {
    if (actorId !== "boss")
      throw new Error("only Boss can delete notices");
    const notice = this.db.prepare("SELECT id FROM notices WHERE id = ?").get(noticeId) as Row | undefined;
    if (!notice) throw new Error(`notice not found: ${noticeId}`);
    this.db.prepare("DELETE FROM notices WHERE id = ?").run(noticeId);
    this.audit({ actorId, action: "notice.deleted", entityType: "notice", entityId: noticeId });
  }

  publishNotice(actorId: Actor, input: { title: string; body: string; supersedesNoticeId?: string }) {
    if (actorId !== "boss") this.requireAgentMember(actorId);
    if (!this.canPublishNotice(actorId)) throw new Error("only Boss, the organization admin, or a current manager can publish notices");
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

  // ── Unread notice reminders ──────────────────────────────

  queueNoticeReminderRun(scheduledAtInput: string | number | Date) {
    const scheduledAt = new Date(scheduledAtInput);
    if (!Number.isFinite(scheduledAt.getTime())) throw new Error("notice reminder scheduledAt is invalid");
    const slot = shanghaiSlot(scheduledAt.getTime());
    if (slot.minute !== 30 || slot.second !== 0 || slot.millisecond !== 0) {
      throw new Error("notice reminder runs must be scheduled on an exact half-hour");
    }
    if (slot.hour < this.noticeReminderConfig.startHour || slot.hour > this.noticeReminderConfig.endHour) {
      throw new Error("notice reminder run is outside the configured schedule");
    }
    const slotKey = `${slot.localDate}T${String(slot.hour).padStart(2, "0")}:30`;
    const existing = this.db.prepare("SELECT id FROM notice_reminder_runs WHERE slot_key = ?").get(slotKey) as Row | undefined;
    if (existing) return this.noticeReminderRun(existing.id);

    return this.transaction(() => {
      const runId = randomUUID();
      const createdAt = nowIso();
      this.db.prepare(`
        INSERT INTO notice_reminder_runs (id, slot_key, scheduled_at, local_date, local_hour, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(runId, slotKey, scheduledAt.toISOString(), slot.localDate, slot.hour, createdAt);

      let candidateAgents = 0;
      let candidateUnreadEntries = 0;
      const employees = this.listMembers().filter((member) => member.kind === "agent" && member.active)
        .sort((a, b) => a.level - b.level || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const employee of employees) {
        const candidates = this.unreadNoticeReminderCandidates(employee.id);
        if (candidates.length === 0) continue;
        candidateAgents += 1;
        candidateUnreadEntries += candidates.length;
        const open = this.db.prepare(`
          SELECT id FROM notice_reminder_dispatches
          WHERE target_member_id = ? AND status IN ('pending', 'running')
          ORDER BY created_at, rowid LIMIT 1
        `).get(employee.id) as Row | undefined;
        const id = randomUUID();
        const status = open ? "skipped" : "pending";
        const lastError = open ? `earlier notice reminder is still open: ${open.id}` : null;
        this.db.prepare(`
          INSERT INTO notice_reminder_dispatches (
            id, run_id, target_member_id, scheduled_at, candidate_json, candidate_count,
            status, last_error, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          runId,
          employee.id,
          scheduledAt.toISOString(),
          JSON.stringify(candidates),
          candidates.length,
          status,
          lastError,
          createdAt,
          open ? createdAt : null,
        );
        this.audit({
          actorId: "system",
          action: open ? "notice.reminder_dispatch_skipped" : "notice.reminder_dispatch_queued",
          entityType: "notice_reminder",
          entityId: runId,
          reason: lastError ?? undefined,
          after: { dispatchId: id, targetMemberId: employee.id, candidateCount: candidates.length },
        });
      }

      this.audit({
        actorId: "system",
        action: candidateAgents === 0 ? "notice.reminder_empty" : "notice.reminder_created",
        entityType: "notice_reminder",
        entityId: runId,
        after: {
          scheduledAt: scheduledAt.toISOString(),
          localDate: slot.localDate,
          localHour: slot.hour,
          candidateAgents,
          candidateUnreadEntries,
        },
      });
      return this.noticeReminderRun(runId);
    });
  }

  recoverNoticeReminderDispatches() {
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM notice_reminder_dispatches
        WHERE status = 'running' OR (status = 'pending' AND attempts > 0)
      `).all() as Row[];
      for (const row of rows) {
        const progressed = this.noticeReminderDispatchHasReadProgress(row.id);
        const status = progressed ? "succeeded" : "failed";
        const error = progressed
          ? null
          : "Notice patrol dispatch had already been attempted; automatic retry suppressed to avoid duplicate delivery";
        this.db.prepare(`
          UPDATE notice_reminder_dispatches SET status = ?, lease_expires_at = NULL,
            last_error = ?, completed_at = ? WHERE id = ?
        `).run(
          status,
          error,
          nowIso(),
          row.id,
        );
        this.audit({
          actorId: "system",
          action: progressed ? "notice.reminder_dispatch_delivered" : "notice.reminder_dispatch_failed",
          entityType: "notice_reminder",
          entityId: row.run_id,
          reason: progressed
            ? "Gateway restart recovery found verified notice read progress"
            : "notice patrol dispatch is single-injection; duplicate retry suppressed",
          after: { dispatchId: row.id, targetMemberId: row.target_member_id, attempts: row.attempts },
        });
      }
      return rows.length;
    });
  }

  claimNextNoticeReminderDispatch(now = Date.now(), leaseMs = 15 * 60 * 1000): NoticeReminderDispatch | null {
    return this.transaction(() => {
      while (true) {
        const row = this.db.prepare(`
          SELECT * FROM notice_reminder_dispatches
          WHERE status = 'pending' AND attempts = 0 AND scheduled_at <= ?
          ORDER BY scheduled_at, created_at, rowid LIMIT 1
        `).get(new Date(now).toISOString()) as Row | undefined;
        if (!row) return null;
        const member = this.getMember(row.target_member_id, { active: false });
        if (!member.active) {
          this.finishNoticeReminderWithoutDelivery(row, "canceled", "target member is inactive");
          continue;
        }
        const candidates = this.relevantNoticeReminderCandidates(row.target_member_id, parseJson(row.candidate_json, []));
        if (candidates.length === 0) {
          this.finishNoticeReminderWithoutDelivery(row, "skipped", "all candidate notices are already read or no longer effective");
          continue;
        }
        const targetAgentId = this.runtimeAgentId(row.target_member_id);
        const prompt = buildNoticeReminderPrompt(candidates, row.scheduled_at, row.id);
        const startedAt = nowIso();
        this.db.prepare(`
          UPDATE notice_reminder_dispatches SET prompt = ?, status = 'running', attempts = attempts + 1,
            started_at = ?, lease_expires_at = ?, last_error = NULL WHERE id = ?
        `).run(prompt, startedAt, new Date(now + leaseMs).toISOString(), row.id);
        this.audit({
          actorId: "system",
          action: "notice.reminder_dispatch_started",
          entityType: "notice_reminder",
          entityId: row.run_id,
          after: { dispatchId: row.id, targetMemberId: row.target_member_id, candidateCount: candidates.length, attempts: Number(row.attempts) + 1 },
        });
        return mapNoticeReminderDispatch({
          ...row,
          candidate_json: JSON.stringify(candidates),
          target_runtime_agent_id: targetAgentId,
          prompt,
          status: "running",
          attempts: Number(row.attempts) + 1,
          started_at: startedAt,
        });
      }
    });
  }

  hasDueNoticeReminderDispatches(now = Date.now()) {
    return Boolean(this.db.prepare(`
      SELECT 1 AS ok FROM notice_reminder_dispatches
      WHERE status = 'pending' AND attempts = 0 AND scheduled_at <= ? LIMIT 1
    `).get(new Date(now).toISOString()));
  }

  noticeReminderDispatchHasReadProgress(dispatchId: string) {
    const row = this.db.prepare(`
      SELECT target_member_id, candidate_json, started_at FROM notice_reminder_dispatches WHERE id = ?
    `).get(dispatchId) as Row | undefined;
    if (!row?.started_at) return false;
    const candidates = parseJson<NoticeReminderCandidate[]>(row.candidate_json, []);
    if (candidates.length === 0) return false;
    const placeholders = candidates.map(() => "?").join(", ");
    return Boolean(this.db.prepare(`
      SELECT 1 AS ok FROM notice_reads
      WHERE member_id = ? AND read_at >= ? AND notice_id IN (${placeholders}) LIMIT 1
    `).get(row.target_member_id, row.started_at, ...candidates.map((candidate) => candidate.noticeId)));
  }

  completeNoticeReminderDispatch(dispatchId: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM notice_reminder_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running") return false;
      const completedAt = nowIso();
      this.db.prepare(`
        UPDATE notice_reminder_dispatches SET status = 'succeeded', completed_at = ?,
          lease_expires_at = NULL, last_error = NULL WHERE id = ?
      `).run(completedAt, dispatchId);
      this.audit({
        actorId: "system",
        action: "notice.reminder_dispatch_delivered",
        entityType: "notice_reminder",
        entityId: row.run_id,
        after: { dispatchId, targetMemberId: row.target_member_id, attempts: row.attempts },
      });
      return true;
    });
  }

  failNoticeReminderDispatch(dispatchId: string, error: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM notice_reminder_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running") return false;
      const reason = required(error, "notice reminder dispatch error").slice(0, 1000);
      const member = this.getMember(row.target_member_id, { active: false });
      if (!member.active) {
        this.finishNoticeReminderWithoutDelivery(row, "canceled", "target member is inactive");
        return false;
      }
      const candidates = this.relevantNoticeReminderCandidates(row.target_member_id, parseJson(row.candidate_json, []));
      if (candidates.length === 0) {
        this.finishNoticeReminderWithoutDelivery(row, "skipped", "all candidate notices are already read or no longer effective");
        return false;
      }
      this.db.prepare(`
        UPDATE notice_reminder_dispatches SET status = ?, last_error = ?, lease_expires_at = NULL,
          completed_at = ? WHERE id = ?
      `).run("failed", reason, nowIso(), dispatchId);
      this.audit({
        actorId: "system",
        action: "notice.reminder_dispatch_failed",
        entityType: "notice_reminder",
        entityId: row.run_id,
        reason,
        after: { dispatchId, targetMemberId: row.target_member_id, attempts: row.attempts },
      });
      return false;
    });
  }

  noticeReminderSummary(now = Date.now()) {
    const localDate = shanghaiSlot(now).localDate;
    const latestRun = this.db.prepare(`
      SELECT * FROM notice_reminder_runs WHERE local_date = ? ORDER BY scheduled_at DESC LIMIT 1
    `).get(localDate) as Row | undefined;
    const nextRunAt = this.noticeReminderConfig.enabled
      ? nextNoticeReminderRunAt(now, this.noticeReminderConfig.startHour, this.noticeReminderConfig.endHour)
      : null;
    const backlog = this.db.prepare(`
      SELECT COUNT(*) AS count FROM notice_reminder_dispatches
      WHERE status = 'pending' AND scheduled_at <= ?
    `).get(new Date(now).toISOString()) as Row;
    const current = this.currentNoticeReminderCounts();
    const base = {
      enabled: this.noticeReminderConfig.enabled,
      timeZone: this.noticeReminderConfig.timeZone,
      startHour: this.noticeReminderConfig.startHour,
      endHour: this.noticeReminderConfig.endHour,
      nextRunAt,
      backlog: Number(backlog.count),
      currentUnreadAgents: current.agents,
      currentUnreadEntries: current.entries,
      today: { localDate, latestRun: null },
    };
    if (!latestRun) return base;
    const statusRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM notice_reminder_dispatches WHERE run_id = ? GROUP BY status
    `).all(latestRun.id) as Row[];
    const counts = Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)]));
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS candidate_agents, COALESCE(SUM(candidate_count), 0) AS candidate_unread_entries
      FROM notice_reminder_dispatches WHERE run_id = ?
    `).get(latestRun.id) as Row;
    return {
      ...base,
      today: {
        localDate,
        latestRun: {
          id: latestRun.id,
          scheduledAt: latestRun.scheduled_at,
          candidateAgents: Number(totals.candidate_agents),
          candidateUnreadEntries: Number(totals.candidate_unread_entries),
          pending: counts.pending ?? 0,
          running: counts.running ?? 0,
          delivered: counts.succeeded ?? 0,
          failed: counts.failed ?? 0,
          skipped: counts.skipped ?? 0,
          canceled: counts.canceled ?? 0,
        },
      },
    };
  }

  private noticeReminderRun(runId: string) {
    const run = this.db.prepare("SELECT * FROM notice_reminder_runs WHERE id = ?").get(runId) as Row;
    const dispatches = this.db.prepare(`
      SELECT * FROM notice_reminder_dispatches WHERE run_id = ? ORDER BY created_at, rowid
    `).all(runId) as Row[];
    return {
      id: run.id,
      slotKey: run.slot_key,
      scheduledAt: run.scheduled_at,
      localDate: run.local_date,
      localHour: Number(run.local_hour),
      dispatches: dispatches.map((row) => mapNoticeReminderDispatch({ ...row, target_runtime_agent_id: row.target_member_id })),
    };
  }

  private unreadNoticeReminderCandidates(memberId: string): NoticeReminderCandidate[] {
    const rows = this.db.prepare(`
      SELECT n.* FROM notices n
      LEFT JOIN notices replacement ON replacement.supersedes_notice_id = n.id
      LEFT JOIN notice_reads reads ON reads.notice_id = n.id AND reads.member_id = ?
      WHERE replacement.id IS NULL AND reads.notice_id IS NULL
      ORDER BY n.created_at, n.rowid
    `).all(memberId) as Row[];
    return rows.map(mapNoticeReminderCandidate);
  }

  private relevantNoticeReminderCandidates(memberId: string, candidates: NoticeReminderCandidate[]) {
    if (candidates.length === 0) return [];
    const placeholders = candidates.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT n.id FROM notices n
      LEFT JOIN notices replacement ON replacement.supersedes_notice_id = n.id
      LEFT JOIN notice_reads reads ON reads.notice_id = n.id AND reads.member_id = ?
      WHERE n.id IN (${placeholders}) AND replacement.id IS NULL AND reads.notice_id IS NULL
    `).all(memberId, ...candidates.map((candidate) => candidate.noticeId)) as Row[];
    const relevant = new Set(rows.map((row) => row.id as string));
    return candidates.filter((candidate) => relevant.has(candidate.noticeId));
  }

  private currentNoticeReminderCounts() {
    const rows = this.db.prepare(`
      SELECT member.id AS member_id, COUNT(n.id) AS unread_count
      FROM members member
      JOIN notices n
      LEFT JOIN notices replacement ON replacement.supersedes_notice_id = n.id
      LEFT JOIN notice_reads reads ON reads.notice_id = n.id AND reads.member_id = member.id
      WHERE member.kind = 'agent' AND member.active = 1
        AND replacement.id IS NULL AND reads.notice_id IS NULL
      GROUP BY member.id
    `).all() as Row[];
    return {
      agents: rows.length,
      entries: rows.reduce((total, row) => total + Number(row.unread_count), 0),
    };
  }

  private finishNoticeReminderWithoutDelivery(row: Row, status: "skipped" | "canceled", reason: string) {
    const completedAt = nowIso();
    this.db.prepare(`
      UPDATE notice_reminder_dispatches SET status = ?, last_error = ?, completed_at = ?,
        lease_expires_at = NULL WHERE id = ?
    `).run(status, reason, completedAt, row.id);
    this.audit({
      actorId: "system",
      action: `notice.reminder_dispatch_${status}`,
      entityType: "notice_reminder",
      entityId: row.run_id,
      reason,
      after: { dispatchId: row.id, targetMemberId: row.target_member_id },
    });
  }

  // ── Daily self-governance ───────────────────────────────────

  queueDailyAgentRun(kind: DailyAgentKind, scheduledAtInput: string | number | Date) {
    const scheduledAt = new Date(scheduledAtInput);
    if (!Number.isFinite(scheduledAt.getTime())) throw new Error("daily agent run scheduledAt is invalid");
    const slot = shanghaiSlot(scheduledAt.getTime());
    const config = this.dailyAgentConfig(kind);
    if (slot.hour !== config.hour || slot.minute !== config.minute || slot.second !== 0 || slot.millisecond !== 0) {
      throw new Error(`daily agent run does not match the configured ${kind} schedule`);
    }
    const slotKey = `${kind}:${slot.localDate}`;
    const existing = this.db.prepare("SELECT id FROM daily_agent_runs WHERE slot_key = ?").get(slotKey) as Row | undefined;
    if (existing) return this.dailyAgentRunSummary(existing.id);

    return this.transaction(() => {
      const runId = randomUUID();
      const createdAt = nowIso();
      this.db.prepare(`
        INSERT INTO daily_agent_runs (
          id, kind, slot_key, scheduled_at, local_date, local_hour, local_minute, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(runId, kind, slotKey, scheduledAt.toISOString(), slot.localDate, slot.hour, slot.minute, createdAt);

      const employees = this.listMembers()
        .filter((member) => member.kind === "agent" && member.active && member.agentId)
        .sort((a, b) => a.level - b.level || (a.agentId ?? a.id).localeCompare(b.agentId ?? b.id));
      employees.forEach((employee, position) => {
        const dispatchId = randomUUID();
        const targetAgentId = employee.agentId ?? employee.id;
        const dispatchAt = new Date(scheduledAt.getTime() + position * 60_000).toISOString();
        const sessionKey = `agent:${targetAgentId}:${DAILY_SELF_AUDIT_SESSION_NAME}`;
        this.db.prepare(`
          INSERT INTO daily_agent_dispatches (
            id, run_id, target_member_id, position, scheduled_at, session_key, prompt, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(dispatchId, runId, employee.id, position, dispatchAt, sessionKey, DAILY_AGENT_PROMPTS[kind], createdAt);
        this.audit({
          actorId: "system",
          action: `${dailyAgentAuditPrefix(kind)}_dispatch_queued`,
          entityType: "daily_agent_run",
          entityId: runId,
          after: { dispatchId, targetMemberId: employee.id, position, scheduledAt: dispatchAt, sessionKey },
        });
      });

      this.audit({
        actorId: "system",
        action: employees.length === 0 ? `${dailyAgentAuditPrefix(kind)}_empty` : `${dailyAgentAuditPrefix(kind)}_created`,
        entityType: "daily_agent_run",
        entityId: runId,
        after: {
          kind,
          scheduledAt: scheduledAt.toISOString(),
          localDate: slot.localDate,
          employeeCount: employees.length,
        },
      });
      return this.dailyAgentRunSummary(runId);
    });
  }

  recoverDailyAgentDispatches() {
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT d.*, r.kind FROM daily_agent_dispatches d
        JOIN daily_agent_runs r ON r.id = d.run_id
        WHERE d.status = 'running' OR (d.status = 'pending' AND d.attempts > 0)
      `).all() as Row[];
      const completedAt = nowIso();
      for (const row of rows) {
        const reason = "Daily self-governance dispatch had already been attempted; automatic retry suppressed to avoid duplicate workspace edits";
        this.db.prepare(`
          UPDATE daily_agent_dispatches SET status = 'failed', lease_expires_at = NULL,
            last_error = ?, completed_at = ? WHERE id = ?
        `).run(reason, completedAt, row.id);
        this.audit({
          actorId: "system",
          action: `${dailyAgentAuditPrefix(row.kind)}_dispatch_failed`,
          entityType: "daily_agent_run",
          entityId: row.run_id,
          reason,
          after: { dispatchId: row.id, targetMemberId: row.target_member_id, attempts: row.attempts },
        });
      }
      return rows.length;
    });
  }

  claimNextDailyAgentDispatch(
    now = Date.now(),
    excludedTargetMemberIds: ReadonlySet<string> = new Set(),
    leaseMs = 15 * 60 * 1000,
  ): DailyAgentDispatch | null {
    return this.transaction(() => {
      while (true) {
        const rows = this.pendingDailyAgentDispatchRows(now);
        const row = rows.find((candidate) => !excludedTargetMemberIds.has(candidate.target_member_id));
        if (!row) return null;
        const member = this.getMember(row.target_member_id, { active: false });
        if (!member.active) {
          this.cancelDailyAgentDispatch(row, "target member is inactive");
          continue;
        }
        const targetAgentId = this.runtimeAgentId(row.target_member_id);
        const startedAt = nowIso();
        this.db.prepare(`
          UPDATE daily_agent_dispatches SET status = 'running', attempts = attempts + 1,
            started_at = ?, lease_expires_at = ?, last_error = NULL WHERE id = ?
        `).run(startedAt, new Date(now + leaseMs).toISOString(), row.id);
        this.audit({
          actorId: "system",
          action: `${dailyAgentAuditPrefix(row.kind)}_dispatch_started`,
          entityType: "daily_agent_run",
          entityId: row.run_id,
          after: { dispatchId: row.id, targetMemberId: row.target_member_id, attempts: Number(row.attempts) + 1 },
        });
        return mapDailyAgentDispatch({
          ...row,
          target_runtime_agent_id: targetAgentId,
          status: "running",
          attempts: Number(row.attempts) + 1,
          started_at: startedAt,
        });
      }
    });
  }

  nextPendingDailyAgentDispatchAt(excludedTargetMemberIds: ReadonlySet<string> = new Set()) {
    const row = this.pendingDailyAgentDispatchRows()
      .find((candidate) => !excludedTargetMemberIds.has(candidate.target_member_id));
    return row?.scheduled_at as string | undefined;
  }

  completeDailyAgentDispatch(dispatchId: string) {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT d.*, r.kind FROM daily_agent_dispatches d
        JOIN daily_agent_runs r ON r.id = d.run_id WHERE d.id = ?
      `).get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running") return false;
      const completedAt = nowIso();
      this.db.prepare(`
        UPDATE daily_agent_dispatches SET status = 'succeeded', completed_at = ?,
          lease_expires_at = NULL, last_error = NULL WHERE id = ?
      `).run(completedAt, dispatchId);
      this.audit({
        actorId: "system",
        action: `${dailyAgentAuditPrefix(row.kind)}_dispatch_delivered`,
        entityType: "daily_agent_run",
        entityId: row.run_id,
        after: { dispatchId, targetMemberId: row.target_member_id, attempts: row.attempts },
      });
      return true;
    });
  }

  failDailyAgentDispatch(dispatchId: string, error: string) {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT d.*, r.kind FROM daily_agent_dispatches d
        JOIN daily_agent_runs r ON r.id = d.run_id WHERE d.id = ?
      `).get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running") return false;
      const reason = required(error, "daily agent dispatch error").slice(0, 1000);
      this.db.prepare(`
        UPDATE daily_agent_dispatches SET status = 'failed', last_error = ?, completed_at = ?,
          lease_expires_at = NULL WHERE id = ?
      `).run(reason, nowIso(), dispatchId);
      this.audit({
        actorId: "system",
        action: `${dailyAgentAuditPrefix(row.kind)}_dispatch_failed`,
        entityType: "daily_agent_run",
        entityId: row.run_id,
        reason,
        after: { dispatchId, targetMemberId: row.target_member_id, attempts: row.attempts },
      });
      return true;
    });
  }

  dailySelfGovernanceSummary(now = Date.now()): DailySelfGovernanceSummary {
    const localDate = shanghaiSlot(now).localDate;
    const firstLocalDate = shanghaiLocalDateDaysAgo(now, 6);
    const runRows = this.db.prepare(`
      SELECT * FROM daily_agent_runs
      WHERE local_date BETWEEN ? AND ?
      ORDER BY local_date DESC,
        CASE kind WHEN 'daily_self_improvement' THEN 0 ELSE 1 END,
        scheduled_at DESC
    `).all(firstLocalDate, localDate) as Row[];
    const history = runRows.map((row) => this.dailyAgentRunSummary(row.id));
    const backlog = this.db.prepare(`
      SELECT COUNT(*) AS count FROM daily_agent_dispatches
      WHERE status = 'pending' AND attempts = 0 AND scheduled_at <= ?
    `).get(new Date(now).toISOString()) as Row;
    const selfToday = history.find((run) => run.kind === "daily_self_improvement" && run.localDate === localDate) ?? null;
    const personaToday = history.find((run) => run.kind === "daily_persona_audit" && run.localDate === localDate) ?? null;
    return {
      timeZone: "Asia/Shanghai",
      sessionName: DAILY_SELF_AUDIT_SESSION_NAME,
      backlog: Number(backlog.count),
      mechanisms: {
        selfImprovement: {
          enabled: this.dailySelfImprovementConfig.enabled,
          hour: this.dailySelfImprovementConfig.hour,
          minute: this.dailySelfImprovementConfig.minute,
          nextRunAt: this.dailySelfImprovementConfig.enabled
            ? nextDailyAgentRunAt(now, this.dailySelfImprovementConfig.hour, this.dailySelfImprovementConfig.minute)
            : null,
          today: selfToday,
        },
        personaAudit: {
          enabled: this.dailyPersonaAuditConfig.enabled,
          hour: this.dailyPersonaAuditConfig.hour,
          minute: this.dailyPersonaAuditConfig.minute,
          nextRunAt: this.dailyPersonaAuditConfig.enabled
            ? nextDailyAgentRunAt(now, this.dailyPersonaAuditConfig.hour, this.dailyPersonaAuditConfig.minute)
            : null,
          today: personaToday,
        },
      },
      history,
    };
  }

  private dailyAgentConfig(kind: DailyAgentKind) {
    return kind === "daily_self_improvement" ? this.dailySelfImprovementConfig : this.dailyPersonaAuditConfig;
  }

  private pendingDailyAgentDispatchRows(now?: number) {
    return this.db.prepare(`
      SELECT d.*, r.kind FROM daily_agent_dispatches d
      JOIN daily_agent_runs r ON r.id = d.run_id
      WHERE d.status = 'pending' AND d.attempts = 0
        ${now === undefined ? "" : "AND d.scheduled_at <= ?"}
      ORDER BY d.scheduled_at,
        CASE r.kind WHEN 'daily_self_improvement' THEN 0 ELSE 1 END,
        d.position, d.created_at, d.rowid
    `).all(...(now === undefined ? [] : [new Date(now).toISOString()])) as Row[];
  }

  private cancelDailyAgentDispatch(row: Row, reason: string) {
    const completedAt = nowIso();
    this.db.prepare(`
      UPDATE daily_agent_dispatches SET status = 'canceled', last_error = ?, completed_at = ?,
        lease_expires_at = NULL WHERE id = ?
    `).run(reason, completedAt, row.id);
    this.audit({
      actorId: "system",
      action: `${dailyAgentAuditPrefix(row.kind)}_dispatch_canceled`,
      entityType: "daily_agent_run",
      entityId: row.run_id,
      reason,
      after: { dispatchId: row.id, targetMemberId: row.target_member_id },
    });
  }

  private dailyAgentRunSummary(runId: string): DailyAgentRunSummary {
    const run = this.db.prepare("SELECT * FROM daily_agent_runs WHERE id = ?").get(runId) as Row;
    const rows = this.db.prepare(`
      SELECT d.*, r.kind FROM daily_agent_dispatches d
      JOIN daily_agent_runs r ON r.id = d.run_id
      WHERE d.run_id = ? ORDER BY d.position, d.created_at, d.rowid
    `).all(runId) as Row[];
    const dispatches = rows.map((row) => {
      const { prompt: _prompt, ...dispatch } = mapDailyAgentDispatch(row);
      return dispatch;
    });
    const count = (status: string) => dispatches.filter((dispatch) => dispatch.status === status).length;
    return {
      id: run.id,
      kind: run.kind,
      localDate: run.local_date,
      scheduledAt: run.scheduled_at,
      planned: dispatches.length,
      pending: count("pending"),
      running: count("running"),
      succeeded: count("succeeded"),
      failed: count("failed"),
      canceled: count("canceled"),
      dispatches,
    };
  }

  // ── Meetings ──────────────────────────────────────────────

  requestMeeting(actorId: Actor, input: {
    type: MeetingType;
    title: string;
    agenda: string;
    parentTaskId?: string;
    hostId?: string;
    participants?: MeetingParticipantInput[];
    bossParticipates?: boolean;
  }): { meeting: ReturnType<CompanyOsStore["meetingView"]>; advance: MeetingAdvance } {
    if (actorId !== "boss") this.requireAgentMember(actorId);
    const hostId = actorId === "boss" ? required(input.hostId, "hostId") : actorId;
    this.getMember(hostId);
    const participants = dedupeParticipants(input.participants ?? [], hostId);
    let parentTaskId: string | null = null;
    let meetingRequirement: Row | undefined;
    if (input.type === "task") {
      parentTaskId = required(input.parentTaskId, "parentTaskId");
      const parent = this.getTaskRow(parentTaskId);
      if (parent.assignee_id !== hostId) throw new Error("a task meeting must be hosted by the parent task assignee");
      if (!ACTIVE_TASK_STATUSES.has(parent.status as TaskStatus) || parent.status === "review") {
        throw new Error("the bound parent task is not active");
      }
      this.assertTaskActionable(parent, "request a task meeting");
      meetingRequirement = this.taskMeetingRequirementRow(parentTaskId);
      if (meetingRequirement && meetingRequirement.status !== "fulfilled") {
        if (actorId !== hostId) throw new Error("the required task meeting must be requested by the root task assignee");
        if (!input.bossParticipates) throw new Error("the required task meeting must include Boss");
        const existingMeeting = this.db.prepare(`
          SELECT id FROM meetings WHERE parent_task_id = ? AND type = 'task' AND status IN ('queued', 'active') LIMIT 1
        `).get(parentTaskId) as Row | undefined;
        if (existingMeeting) throw new Error(`a task meeting is already open for this root task: ${existingMeeting.id}`);
        const requiredWorkers = this.db.prepare("SELECT id FROM members WHERE manager_id = ? AND active = 1 ORDER BY created_at, id")
          .all(hostId) as Row[];
        if (requiredWorkers.length === 0) throw new Error("the required task meeting needs at least one active direct report");
        const actualWorkers = new Set(participants.filter((participant) => participant.role === "worker").map((participant) => participant.agentId));
        const missing = requiredWorkers.filter((worker) => !actualWorkers.has(worker.id));
        if (missing.length > 0) throw new Error(`the required task meeting must include every active direct report as worker: ${missing.map((worker) => worker.id).join(", ")}`);
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
    const bossParticipates = Boolean(input.bossParticipates);
    const advance = this.transaction(() => {
      const active = this.roomIsOccupied();
      const queue = this.db.prepare("SELECT COALESCE(MAX(queue_position), 0) AS position FROM meetings WHERE status = 'queued'").get() as Row;
      const status: MeetingStatus = active ? "queued" : "active";
      const position = status === "active" ? 0 : Number(queue.position) + 1;
      this.db.prepare(`
        INSERT INTO meetings (
          id, type, status, title, agenda, host_id, requested_by, parent_task_id, boss_participates, queue_position,
          waiting_on_host_since, created_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        meetingId,
        input.type,
        status,
        required(input.title, "title"),
        required(input.agenda, "agenda"),
        hostId,
        actorId,
        parentTaskId,
        bossParticipates ? 1 : 0,
        position,
        status === "active" && !bossParticipates ? createdAt : null,
        createdAt,
        status === "active" ? createdAt : null,
      );
      for (const participant of participants) {
        this.db.prepare("INSERT INTO meeting_participants (meeting_id, member_id, role) VALUES (?, ?, ?)")
          .run(meetingId, participant.agentId, participant.role);
      }
      if (meetingRequirement && meetingRequirement.status !== "fulfilled") {
        this.db.prepare(`
          UPDATE task_meeting_requirements SET status = ?, meeting_id = ? WHERE task_id = ?
        `).run(status === "active" ? "active" : "scheduled", meetingId, parentTaskId);
        this.audit({
          actorId,
          action: "task.required_meeting_scheduled",
          entityType: "task",
          entityId: parentTaskId!,
          after: { meetingId, status },
        });
      }
      if (bossParticipates) {
        this.queueMeetingEmail(meetingId, "created");
        if (status === "active") this.queueMeetingEmail(meetingId, "room_entered");
      }
      if (status === "active") {
        this.addMeetingMessage(
          meetingId,
          "system",
          null,
          null,
          bossParticipates
            ? "会议已进入会议室，正在等待 Boss 点击“开始会议”。"
            : "会议室已开放，主持人开始组织会议。",
        );
      }
      this.audit({ actorId, action: "meeting.requested", entityType: "meeting", entityId: meetingId, after: { ...input, hostId, status, bossParticipates } });
      if (status !== "active" || bossParticipates) return status === "active" ? { activatedMeetingId: meetingId } : {};
      if (actorId !== "boss") return { activatedMeetingId: meetingId };
      return {
        activatedMeetingId: meetingId,
        hostDispatchId: this.enqueueHostDispatch(meetingId, "host_start", "Boss 创建的会议已开始，请组织第一轮发言。", `host-request:${meetingId}`),
      };
    });
    return { meeting: this.meetingView(meetingId), advance };
  }

  pendingMeetingEmailNotifications(limit = 20): MeetingEmailNotification[] {
    const rows = this.db.prepare(`
      SELECT n.id AS notification_id, n.kind, m.id AS meeting_id, m.title, m.agenda, m.type,
        m.host_id, host.name AS host_name, m.created_at, m.started_at
      FROM meeting_email_notifications n
      JOIN meetings m ON m.id = n.meeting_id
      JOIN members host ON host.id = m.host_id
      WHERE n.status IN ('pending', 'failed') AND n.attempts < 5
      ORDER BY n.created_at, n.rowid LIMIT ?
    `).all(Math.min(Math.max(Math.floor(limit), 1), 100)) as Row[];
    return rows.map((row) => ({
      id: row.notification_id,
      meetingId: row.meeting_id,
      kind: row.kind as MeetingEmailKind,
      title: row.title,
      agenda: row.agenda,
      type: row.type as MeetingType,
      hostId: row.host_id,
      hostName: row.host_name,
      createdAt: row.created_at,
      startedAt: row.started_at,
    }));
  }

  pendingTaskReviewEmailNotifications(limit = 20): TaskReviewEmailNotification[] {
    const rows = this.db.prepare(`
      SELECT n.id AS notification_id, n.task_id, n.submission_id,
        t.title, t.acceptance_criteria, t.assignee_id,
        assignee.name AS assignee_name, s.summary, s.evidence_json,
        s.git_remote_url, s.git_branch, s.git_commit, s.git_verified_at,
        s.created_at AS submitted_at
      FROM task_review_email_notifications n
      JOIN tasks t ON t.id = n.task_id
      JOIN task_submissions s ON s.id = n.submission_id
      JOIN members assignee ON assignee.id = t.assignee_id
      WHERE n.status IN ('pending', 'failed') AND n.attempts < 5
      ORDER BY n.created_at, n.rowid LIMIT ?
    `).all(Math.min(Math.max(Math.floor(limit), 1), 100)) as Row[];
    return rows.map((row) => ({
      id: row.notification_id,
      kind: "task_review_requested",
      taskId: row.task_id,
      submissionId: row.submission_id,
      title: row.title,
      acceptanceCriteria: row.acceptance_criteria,
      assigneeId: row.assignee_id,
      assigneeName: row.assignee_name,
      submittedAt: row.submitted_at,
      summary: row.summary,
      evidence: parseJson<EvidenceInput[]>(row.evidence_json, []),
      gitLocation: requireSubmissionGitLocation(row),
    }));
  }

  pendingBossTaskActionEmailNotifications(limit = 20): BossTaskActionEmailNotification[] {
    const rows = this.db.prepare(`
      SELECT n.id AS notification_id, n.kind, n.source_id, n.payload_json, n.created_at,
        t.id AS task_id, t.title, t.assignee_id, t.issuer_id,
        assignee.name AS assignee_name
      FROM boss_task_action_email_notifications n
      JOIN tasks t ON t.id = n.task_id
      JOIN members assignee ON assignee.id = t.assignee_id
      WHERE n.status IN ('pending', 'failed') AND n.attempts < 5
      ORDER BY n.created_at, n.rowid LIMIT ?
    `).all(Math.min(Math.max(Math.floor(limit), 1), 100)) as Row[];
    return rows.map((row) => {
      const payload = parseJson<Record<string, any>>(row.payload_json, {});
      return {
        id: row.notification_id,
        kind: row.kind === "block_escalated" ? "task_block_escalated" : "task_cancel_requested",
        taskId: row.task_id,
        title: row.title,
        assigneeId: row.assignee_id,
        assigneeName: row.assignee_name,
        issuerId: row.issuer_id,
        createdAt: row.created_at,
        reason: String(payload.reason ?? ""),
        blockedReason: payload.blockedReason ?? null,
        sourceId: row.source_id,
        ...(payload.requesterId ? { requesterId: String(payload.requesterId) } : {}),
        ...(payload.parentTaskId ? { parentTaskId: String(payload.parentTaskId) } : {}),
        ...(payload.parentTitle ? { parentTitle: String(payload.parentTitle) } : {}),
      } as BossTaskActionEmailNotification;
    });
  }

  markMeetingEmailSent(notificationId: string) {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM meeting_email_notifications WHERE id = ?").get(notificationId) as Row | undefined;
      if (!row || row.status === "sent") return;
      this.db.prepare(`
        UPDATE meeting_email_notifications SET status = 'sent', attempts = attempts + 1,
          last_error = NULL, sent_at = ? WHERE id = ?
      `).run(nowIso(), notificationId);
      this.audit({ actorId: "system", action: "meeting.email_sent", entityType: "meeting", entityId: row.meeting_id, after: { kind: row.kind } });
    });
  }

  markMeetingEmailFailed(notificationId: string, error: string) {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM meeting_email_notifications WHERE id = ?").get(notificationId) as Row | undefined;
      if (!row || row.status === "sent") return;
      const message = error.trim().slice(0, 1000) || "unknown SMTP error";
      this.db.prepare(`
        UPDATE meeting_email_notifications SET status = 'failed', attempts = attempts + 1,
          last_error = ? WHERE id = ?
      `).run(message, notificationId);
      this.audit({ actorId: "system", action: "meeting.email_failed", entityType: "meeting", entityId: row.meeting_id, reason: message, after: { kind: row.kind } });
    });
  }

  markTaskReviewEmailSent(notificationId: string) {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM task_review_email_notifications WHERE id = ?").get(notificationId) as Row | undefined;
      if (!row || row.status === "sent") return;
      this.db.prepare(`
        UPDATE task_review_email_notifications SET status = 'sent', attempts = attempts + 1,
          last_error = NULL, sent_at = ? WHERE id = ?
      `).run(nowIso(), notificationId);
      this.audit({
        actorId: "system",
        action: "task.review_email_sent",
        entityType: "task",
        entityId: row.task_id,
        after: { notificationId, submissionId: row.submission_id },
      });
    });
  }

  markTaskReviewEmailFailed(notificationId: string, error: string) {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM task_review_email_notifications WHERE id = ?").get(notificationId) as Row | undefined;
      if (!row || row.status === "sent") return;
      const message = error.trim().slice(0, 1000) || "unknown SMTP error";
      this.db.prepare(`
        UPDATE task_review_email_notifications SET status = 'failed', attempts = attempts + 1,
          last_error = ? WHERE id = ?
      `).run(message, notificationId);
      this.audit({
        actorId: "system",
        action: "task.review_email_failed",
        entityType: "task",
        entityId: row.task_id,
        reason: message,
        after: { notificationId, submissionId: row.submission_id },
      });
    });
  }

  markBossTaskActionEmailSent(notificationId: string) {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM boss_task_action_email_notifications WHERE id = ?").get(notificationId) as Row | undefined;
      if (!row || row.status === "sent") return;
      this.db.prepare(`
        UPDATE boss_task_action_email_notifications SET status = 'sent', attempts = attempts + 1,
          last_error = NULL, sent_at = ? WHERE id = ?
      `).run(nowIso(), notificationId);
      this.audit({
        actorId: "system",
        action: "task.boss_action_email_sent",
        entityType: "task",
        entityId: row.task_id,
        after: { notificationId, kind: row.kind, sourceId: row.source_id },
      });
    });
  }

  markBossTaskActionEmailFailed(notificationId: string, error: string) {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM boss_task_action_email_notifications WHERE id = ?").get(notificationId) as Row | undefined;
      if (!row || row.status === "sent") return;
      const message = error.trim().slice(0, 1000) || "unknown SMTP error";
      this.db.prepare(`
        UPDATE boss_task_action_email_notifications SET status = 'failed', attempts = attempts + 1,
          last_error = ? WHERE id = ?
      `).run(message, notificationId);
      this.audit({
        actorId: "system",
        action: "task.boss_action_email_failed",
        entityType: "task",
        entityId: row.task_id,
        reason: message,
        after: { notificationId, kind: row.kind, sourceId: row.source_id },
      });
    });
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
    const draftStages = this.db.prepare(`
      SELECT * FROM meeting_task_draft_stages WHERE meeting_id = ? ORDER BY position
    `).all(meetingId) as Row[];
    const currentTurn = row.current_turn_id
      ? this.db.prepare("SELECT * FROM meeting_turns WHERE id = ?").get(row.current_turn_id) as Row | undefined
      : undefined;
    const hostDispatch = this.db.prepare(`
      SELECT d.*, target.agent_id AS target_runtime_agent_id
      FROM meeting_agent_dispatches d
      JOIN members target ON target.id = d.target_agent_id
      WHERE d.meeting_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1
    `).get(meetingId) as Row | undefined;
    const closeoutDispatches = this.db.prepare(`
      SELECT d.*, member.name AS member_name
      FROM meeting_closeout_dispatches d
      JOIN members member ON member.id = d.member_id
      WHERE d.meeting_id = ? ORDER BY d.position, d.created_at, d.rowid
    `).all(meetingId) as Row[];
    return {
      ...this.mapMeetingSummary(row),
      participants: participants.map((participant) => ({
        agentId: participant.member_id,
        role: participant.role,
        name: participant.name,
        title: participant.title,
      })),
      messages: messages.map(mapMeetingMessage),
      taskDraftStages: draftStages.map((stage) => ({
        id: stage.id,
        position: Number(stage.position),
        name: stage.name,
        objective: stage.objective,
        tasks: (this.db.prepare(`
          SELECT * FROM meeting_task_drafts WHERE stage_id = ? ORDER BY position
        `).all(stage.id) as Row[]).map(mapTaskDraft),
      })),
      currentTurn: currentTurn ? mapMeetingTurn(currentTurn) : null,
      hostDispatchStatus: hostDispatch ? mapHostDispatch(hostDispatch) : null,
      closeoutDispatches: closeoutDispatches.map(mapMeetingCloseoutDispatch),
      audit: this.listAudit("meeting", meetingId),
    };
  }

  activeMeetingId(actorId: string) {
    this.requireAgentMember(actorId);
    const rows = this.db.prepare("SELECT * FROM meetings WHERE status = 'active' ORDER BY started_at, created_at").all() as Row[];
    const meeting = rows[0];
    if (!meeting) throw new Error("there is no active meeting in the meeting room");
    if (rows.length > 1) throw new Error("meeting room invariant violated: multiple active meetings");
    this.assertMeetingReadable(actorId, meeting);
    return meeting.id as string;
  }

  activeMeetingForMember(memberId: string) {
    this.requireAgentMember(memberId);
    const meeting = this.db.prepare(`
      SELECT m.id, m.title
      FROM meetings m
      WHERE m.status = 'active'
        AND (
          m.host_id = ?
          OR EXISTS (
            SELECT 1 FROM meeting_participants participant
            WHERE participant.meeting_id = m.id AND participant.member_id = ?
          )
        )
      ORDER BY m.started_at, m.created_at
      LIMIT 1
    `).get(memberId, memberId) as Row | undefined;
    return meeting ? { id: meeting.id as string, title: meeting.title as string } : null;
  }

  startMeetingByBoss(meetingId: string): MeetingAdvance {
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.status !== "active") throw new Error("meeting is not active");
    if (!meeting.boss_participates) throw new Error("this meeting does not require Boss to start it");
    if (meeting.boss_started_at) throw new Error("meeting has already been started by Boss");
    if (meeting.current_turn_id) throw new Error("meeting cannot start during an active speaking turn");
    return this.transaction(() => {
      const startedAt = nowIso();
      this.db.prepare("UPDATE meetings SET boss_started_at = ?, waiting_on_host_since = ? WHERE id = ?")
        .run(startedAt, startedAt, meetingId);
      this.addMeetingMessage(meetingId, "boss", "boss", null, "我已进入会议室，现在开始会议。");
      this.audit({ actorId: "boss", action: "meeting.started_by_boss", entityType: "meeting", entityId: meetingId });
      return {
        hostDispatchId: this.enqueueHostDispatch(
          meetingId,
          "host_start",
          "Boss 刚刚说：“我已进入会议室，现在开始会议。”\n请先回应 Boss，再按照会议议题主持讨论。",
          `host-start:${meetingId}`,
        ),
      };
    });
  }

  rejectMeetingByBoss(meetingId: string, reason: string) {
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.status !== "active") throw new Error("meeting is not active");
    if (!meeting.boss_participates) throw new Error("Boss can only reject a meeting that requires Boss participation");
    if (meeting.boss_started_at) throw new Error("a meeting that Boss already started cannot be rejected");
    if (meeting.current_turn_id) throw new Error("meeting cannot be rejected during an active speaking turn");
    const rejectionReason = required(reason, "reason");
    let advance: MeetingAdvance = {};
    this.transaction(() => {
      const endedAt = nowIso();
      this.db.prepare(`
        UPDATE meetings SET status = 'canceled', canceled_reason = ?, current_turn_id = NULL,
          waiting_on_host_since = NULL, ended_at = ? WHERE id = ?
      `).run(`Boss 拒绝：${rejectionReason}`, endedAt, meetingId);
      this.cancelOpenHostDispatches(meetingId);
      this.addMeetingMessage(meetingId, "system", null, null, `Boss 已拒绝召开本次会议：${rejectionReason}。`);
      this.queueMeetingCloseoutDispatches(meetingId, "canceled", true);
      this.resetRequiredTaskMeeting(meeting);
      this.audit({
        actorId: "boss",
        action: "meeting.rejected_by_boss",
        entityType: "meeting",
        entityId: meetingId,
        reason: rejectionReason,
      });
    });
    return { meeting: this.meetingView(meetingId), advance };
  }

  delegateMeeting(
    actorId: string,
    meetingId: string,
    speakerId: string,
    prompt: string,
    sessionIdentity?: MeetingToolSessionIdentity,
  ): MeetingTurnDispatch {
    this.requireAgentMember(actorId);
    const meeting = this.requireActiveHostedMeeting(actorId, meetingId);
    if (meeting.current_turn_id) throw new Error("the current speaker has not finished");
    const participant = this.db.prepare("SELECT 1 AS ok FROM meeting_participants WHERE meeting_id = ? AND member_id = ?")
      .get(meetingId, speakerId) as Row | undefined;
    if (!participant) throw new Error("the selected speaker is not a meeting participant");
    const trustedSession = sessionIdentity ? this.validateMeetingToolSession(actorId, sessionIdentity) : undefined;
    return this.transaction(() => {
      const normalizedPrompt = required(prompt, "prompt");
      const turn = this.createMeetingTurn(meetingId, speakerId, actorId, "delegate", normalizedPrompt);
      const pointMessage = this.addMeetingMessage(meetingId, "member", actorId, speakerId, normalizedPrompt, turn.id);
      const roundNumber = this.meetingRoundNumber(turn.id);
      const contextAppendId = trustedSession
        ? this.queueMeetingSessionContextAppend({
            meetingId,
            memberId: actorId,
            sessionIdentity: trustedSession,
            toolName: "company_meeting_delegate",
            message: pointMessage,
            turnId: turn.id,
            roundNumber,
            recordKind: "delegate",
            targetId: speakerId,
            body: normalizedPrompt,
          })
        : undefined;
      this.db.prepare("UPDATE meetings SET current_turn_id = ?, waiting_on_host_since = NULL WHERE id = ?").run(turn.id, meetingId);
      const context = this.buildMeetingContext(meetingId, speakerId, {
        turnId: turn.id,
        instruction: required(prompt, "prompt"),
        role: "speaker",
      });
      this.db.prepare("UPDATE meeting_turns SET context_from_sequence = ?, context_to_sequence = ? WHERE id = ?")
        .run(context.fromSequence, context.toSequence, turn.id);
      this.audit({ actorId, action: "meeting.delegated", entityType: "meeting", entityId: meetingId, after: { turnId: turn.id, speakerId, prompt: normalizedPrompt } });
      return {
        ...context,
        turnId: turn.id,
        speakerId,
        agentId: this.runtimeAgentId(speakerId),
        messageId: pointMessage.id,
        messageSequence: pointMessage.sequence,
        roundNumber,
        ...(contextAppendId ? { contextAppendId } : {}),
      };
    });
  }

  speakMeeting(
    actorId: string,
    meetingId: string,
    body: string,
    turnId?: string,
    sessionIdentity?: MeetingToolSessionIdentity,
  ): MeetingTurnDelivery | null {
    this.requireAgentMember(actorId);
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.status !== "active") throw new Error("meeting is not active");
    if (this.isAwaitingBossStart(meeting)) throw new Error("meeting is waiting for Boss to start it");
    if (meeting.end_requested_at) throw new Error("meeting is waiting for Boss to decide whether it can end");
    const message = required(body, "body");
    const trustedSession = sessionIdentity ? this.validateMeetingToolSession(actorId, sessionIdentity) : undefined;
    return this.transaction(() => {
      if (!meeting.current_turn_id) {
        if (meeting.host_id !== actorId) throw new Error("only the current speaker can speak");
        if (turnId) throw new Error("the supplied meeting turn is no longer current");
        const written = this.addMeetingMessage(meetingId, "member", actorId, null, message);
        const contextAppendId = trustedSession
          ? this.queueMeetingSessionContextAppend({
              meetingId,
              memberId: actorId,
              sessionIdentity: trustedSession,
              toolName: "company_meeting_speak",
              message: written,
              turnId: null,
              roundNumber: null,
              recordKind: "host_speech",
              targetId: null,
              body: message,
            })
          : undefined;
        if (contextAppendId) {
          this.enqueueHostDispatch(
            meetingId,
            "host_resume",
            "你刚刚完成了一次主持人发言。该发言已写回 main session，请继续主持会议。",
            `host-resume-after-speak:${meetingId}:${written.id}`,
            contextAppendId,
          );
        }
        this.db.prepare("UPDATE meetings SET waiting_on_host_since = ? WHERE id = ?").run(nowIso(), meetingId);
        this.audit({ actorId, action: "meeting.host_spoke", entityType: "meeting", entityId: meetingId, after: { body: message } });
        return null;
      }
      const turn = this.db.prepare("SELECT * FROM meeting_turns WHERE id = ?").get(meeting.current_turn_id) as Row | undefined;
      if (!turn || turn.status !== "waiting" || turn.speaker_id !== actorId) throw new Error("only the current speaker can speak");
      if (!turnId || turn.id !== turnId) throw new Error("meeting turn does not match the current speaking round");
      const completedAt = nowIso();
      this.db.prepare("UPDATE meeting_turns SET status = 'completed', completion_source = 'tool', completed_at = ? WHERE id = ?").run(completedAt, turn.id);
      const written = this.addMeetingMessage(meetingId, "member", actorId, null, message, turn.id);
      const roundNumber = this.meetingRoundNumber(turn.id);
      if (trustedSession) {
        this.queueMeetingSessionContextAppend({
          meetingId,
          memberId: actorId,
          sessionIdentity: trustedSession,
          toolName: "company_meeting_speak",
          message: written,
          turnId: turn.id,
          roundNumber,
          recordKind: "speech",
          targetId: null,
          body: message,
        });
      }
      if (turn.intervention_id) {
        this.db.prepare("UPDATE meeting_interventions SET status = 'delivered', delivered_at = ? WHERE id = ?")
          .run(completedAt, turn.intervention_id);
      }
      this.db.prepare("UPDATE meetings SET current_turn_id = NULL, waiting_on_host_since = ? WHERE id = ?").run(completedAt, meetingId);
      if (!trustedSession) this.advanceMeetingWatermark(meetingId, actorId, this.maxMeetingSequence(meetingId));
      this.audit({ actorId, action: "meeting.spoke", entityType: "meeting", entityId: meetingId, after: { turnId: turn.id, body: message } });
      return this.meetingTurnDelivery(turn.id);
    });
  }

  bossInterject(meetingId: string, body: string, targetId?: string): MeetingAdvance {
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.status !== "active") throw new Error("meeting is not active");
    if (this.isAwaitingBossStart(meeting)) throw new Error("start the meeting before speaking");
    if (meeting.end_requested_at) throw new Error("decide the pending end request before speaking");
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
      if (meeting.current_turn_id) return {};
      return {
        hostDispatchId: this.enqueueHostDispatch(
          meetingId,
          "host_resume",
          targetId ? `Boss @${targetId} 插话，请先处理定向插话再继续主持。` : "Boss 新增了会议发言，请先回应 Boss 再继续主持。",
          `host-intervention:${meetingId}:${interventionId}`,
        ),
      };
    });
  }

  setMeetingTaskDrafts(actorId: string, meetingId: string, stagesInput: TaskFlowStageInput[] | Array<TaskFlowStageInput["tasks"][number]>) {
    this.requireAgentMember(actorId);
    const meeting = this.requireActiveHostedMeeting(actorId, meetingId);
    if (meeting.type !== "task") throw new Error("only task meetings can create task drafts");
    if (meeting.current_turn_id) throw new Error("task drafts cannot change during an active speaking turn");
    const stagedInput = stagesInput.length > 0 && !("tasks" in stagesInput[0]!)
      ? [{ name: "阶段 1", objective: "完成本次会议规划的任务", tasks: stagesInput as Array<TaskFlowStageInput["tasks"][number]> }]
      : stagesInput as TaskFlowStageInput[];
    const normalized = this.normalizeTaskFlowStages(actorId, stagedInput);
    this.transaction(() => {
      this.db.prepare("DELETE FROM meeting_task_drafts WHERE meeting_id = ?").run(meetingId);
      this.db.prepare("DELETE FROM meeting_task_draft_stages WHERE meeting_id = ?").run(meetingId);
      normalized.forEach((stage, stagePosition) => {
        const stageId = randomUUID();
        this.db.prepare(`
          INSERT INTO meeting_task_draft_stages (id, meeting_id, position, name, objective)
          VALUES (?, ?, ?, ?, ?)
        `).run(stageId, meetingId, stagePosition, stage.name, stage.objective);
        stage.tasks.forEach((draft, position) => {
          this.db.prepare(`
            INSERT INTO meeting_task_drafts (
              id, meeting_id, stage_id, position, title, description, acceptance_criteria, assignee_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(randomUUID(), meetingId, stageId, position, draft.title, draft.description, draft.acceptanceCriteria, draft.assigneeId);
        });
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
    const prepared = this.prepareMeetingEnd(actorId, meetingId, summary, publishNotice);
    this.transaction(() => {
      if (prepared.meeting.end_requested_at) throw new Error("meeting end is already pending");
      const requestedAt = nowIso();
      const autoEndAt = prepared.meeting.boss_participates
        ? null
        : new Date(Date.parse(requestedAt) + this.automaticEndDelayMs).toISOString();
      this.db.prepare(`
        UPDATE meetings SET end_requested_at = ?, end_requested_summary = ?,
          end_requested_publish_notice = ?, waiting_on_host_since = NULL WHERE id = ?
      `).run(requestedAt, prepared.summary, publishNotice ? 1 : 0, meetingId);
      this.addMeetingMessage(
        meetingId,
        "system",
        null,
        null,
        prepared.meeting.boss_participates
          ? "主持人已提交会议总结并申请结束，正在等待 Boss 决定。"
          : `主持人已提交会议总结并申请结束，${Math.ceil(this.automaticEndDelayMs / 1000)} 秒后自动结束。`,
      );
      this.audit({
        actorId,
        action: "meeting.end_requested",
        entityType: "meeting",
        entityId: meetingId,
        after: { summary: prepared.summary, publishNotice, autoEndAt },
      });
    });
    return { meeting: this.meetingView(meetingId, actorId), createdTasks: [], notice: null, advance: {} };
  }

  nextAutomaticMeetingEnd() {
    const meeting = this.db.prepare(`
      SELECT id, end_requested_at FROM meetings
      WHERE status = 'active' AND boss_participates = 0 AND end_requested_at IS NOT NULL
      ORDER BY end_requested_at LIMIT 1
    `).get() as Row | undefined;
    if (!meeting) return null;
    return {
      meetingId: meeting.id as string,
      autoEndAt: new Date(Date.parse(meeting.end_requested_at) + this.automaticEndDelayMs).toISOString(),
    };
  }

  finalizeDueAutomaticMeetingEnd(now = Date.now()) {
    const pending = this.nextAutomaticMeetingEnd();
    if (!pending || now < Date.parse(pending.autoEndAt)) return null;
    const meeting = this.getMeetingRow(pending.meetingId);
    if (!meeting.end_requested_summary) throw new Error("automatic meeting end is missing the host summary");
    const publishNotice = Boolean(meeting.end_requested_publish_notice);
    const prepared = this.prepareMeetingEnd(meeting.host_id, meeting.id, meeting.end_requested_summary, publishNotice, true);
    return this.finalizeMeeting("system", meeting.host_id, prepared.meeting, prepared.summary, publishNotice, prepared.stages);
  }

  approveMeetingEndByBoss(meetingId: string) {
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.status !== "active") throw new Error("meeting is not active");
    if (!meeting.boss_participates) throw new Error("this meeting does not require Boss end approval");
    if (!meeting.boss_started_at) throw new Error("meeting has not been started by Boss");
    if (!meeting.end_requested_at || !meeting.end_requested_summary) throw new Error("the host has not requested to end this meeting");
    const publishNotice = Boolean(meeting.end_requested_publish_notice);
    const prepared = this.prepareMeetingEnd(meeting.host_id, meetingId, meeting.end_requested_summary, publishNotice, true);
    return this.finalizeMeeting("boss", meeting.host_id, prepared.meeting, prepared.summary, publishNotice, prepared.stages);
  }

  rejectMeetingEndByBoss(meetingId: string, feedback: string): MeetingAdvance {
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.status !== "active") throw new Error("meeting is not active");
    if (!meeting.boss_participates || !meeting.end_requested_at) throw new Error("there is no Boss end approval request");
    const reason = required(feedback, "feedback");
    return this.transaction(() => {
      const resumedAt = nowIso();
      this.db.prepare(`
        UPDATE meetings SET end_requested_at = NULL, end_requested_summary = NULL,
          end_requested_publish_notice = 0, waiting_on_host_since = ? WHERE id = ?
      `).run(resumedAt, meetingId);
      this.addMeetingMessage(meetingId, "boss", "boss", meeting.host_id, `暂不结束会议：${reason}`);
      this.audit({ actorId: "boss", action: "meeting.end_rejected", entityType: "meeting", entityId: meetingId, reason });
      return {
        hostDispatchId: this.enqueueHostDispatch(
          meetingId,
          "host_resume",
          `Boss 暂未批准结束会议：${reason}\n请先回应 Boss 的反馈，再继续主持。`,
          `host-end-rejected:${meetingId}:${resumedAt}`,
        ),
      };
    });
  }

  private prepareMeetingEnd(hostId: string, meetingId: string, summary: string, publishNotice: boolean, allowExistingRequest = false) {
    const meeting = this.requireActiveHostedMeeting(hostId, meetingId, allowExistingRequest);
    if (meeting.current_turn_id) throw new Error("the current speaking turn must finish before the meeting can end");
    const pendingInterventions = this.db.prepare("SELECT COUNT(*) AS count FROM meeting_interventions WHERE meeting_id = ? AND status != 'delivered'")
      .get(meetingId) as Row;
    if (Number(pendingInterventions.count) > 0) throw new Error("all Boss interventions must be handled before the meeting can end");
    const finalSummary = required(summary, "summary");
    const stages = this.meetingDraftStageInputs(meetingId);
    const drafts = stages.flatMap((stage) => stage.tasks);
    if (meeting.type === "task") {
      const parent = this.getTaskRow(meeting.parent_task_id);
      if (parent.assignee_id !== hostId || !ACTIVE_TASK_STATUSES.has(parent.status as TaskStatus) || parent.status === "review") {
        throw new Error("the bound parent task is no longer eligible for delegation");
      }
      const workers = this.db.prepare("SELECT member_id FROM meeting_participants WHERE meeting_id = ? AND role = 'worker'").all(meetingId) as Row[];
      if (workers.length === 0) throw new Error("a task meeting requires at least one worker");
      for (const worker of workers) {
        if (!drafts.some((draft) => draft.assigneeId === worker.member_id)) {
          throw new Error(`every worker must receive at least one task: ${worker.member_id}`);
        }
      }
      for (const draft of drafts) {
        if (!this.isDirectReport(hostId, draft.assigneeId)) throw new Error(`draft assignee is no longer a direct report: ${draft.assigneeId}`);
      }
    } else if (publishNotice && !this.canPublishNotice(hostId)) {
      throw new Error("the host does not have permission to publish a notice");
    }
    return { meeting, summary: finalSummary, stages };
  }

  private meetingDraftStageInputs(meetingId: string): TaskFlowStageInput[] {
    const stages = this.db.prepare(`
      SELECT * FROM meeting_task_draft_stages WHERE meeting_id = ? ORDER BY position
    `).all(meetingId) as Row[];
    return stages.map((stage) => ({
      name: stage.name,
      objective: stage.objective,
      tasks: (this.db.prepare(`
        SELECT * FROM meeting_task_drafts WHERE stage_id = ? ORDER BY position
      `).all(stage.id) as Row[]).map((draft) => ({
        title: draft.title,
        description: draft.description,
        acceptanceCriteria: draft.acceptance_criteria,
        assigneeId: draft.assignee_id,
      })),
    }));
  }

  private finalizeMeeting(
    actorId: Actor,
    hostId: string,
    meeting: Row,
    finalSummary: string,
    publishNotice: boolean,
    stages: TaskFlowStageInput[],
  ) {
    let createdTasks: ReturnType<CompanyOsStore["listTasks"]> = [];
    let notice: ReturnType<CompanyOsStore["listNotices"]>[number] | null = null;
    let advance: MeetingAdvance = {};
    this.transaction(() => {
      if (meeting.type === "task") {
        const flow = this.createTaskFlowInternal(hostId, meeting.parent_task_id, stages, meeting.id);
        createdTasks = flow.stages.flatMap((stage) => stage.taskIds)
          .map((taskId) => this.readTask("boss", taskId, false));
        const requirement = this.taskMeetingRequirementRow(meeting.parent_task_id);
        if (requirement && requirement.meeting_id === meeting.id) {
          this.db.prepare(`
            UPDATE task_meeting_requirements SET status = 'fulfilled', fulfilled_at = ? WHERE task_id = ?
          `).run(nowIso(), meeting.parent_task_id);
          this.audit({
            actorId,
            action: "task.required_meeting_fulfilled",
            entityType: "task",
            entityId: meeting.parent_task_id,
            after: { meetingId: meeting.id, flowId: flow.id },
          });
        }
        notice = this.insertNotice({
          actorId,
          authorId: hostId,
          kind: "meeting_report",
          title: `会议汇报：${meeting.title}`,
          body: meetingReportBody(finalSummary, meeting.parent_task_id, createdTasks),
          sourceMeetingId: meeting.id,
        });
      } else if (publishNotice) {
        notice = this.insertNotice({
          actorId,
          authorId: hostId,
          kind: "meeting_report",
          title: `讨论会汇报：${meeting.title}`,
          body: finalSummary,
          sourceMeetingId: meeting.id,
        });
      }
      if (notice) this.markMeetingNoticeRead(meeting.id, notice.id);
      const endedAt = nowIso();
      this.addMeetingMessage(meeting.id, "member", hostId, null, `【主持人最终总结】\n${finalSummary}`);
      this.db.prepare(`
        UPDATE meetings SET status = 'completed', summary = ?, publish_notice = ?, current_turn_id = NULL,
          waiting_on_host_since = NULL, end_requested_at = NULL, end_requested_summary = NULL,
          end_requested_publish_notice = 0, ended_at = ? WHERE id = ?
      `).run(finalSummary, notice ? 1 : 0, endedAt, meeting.id);
      this.cancelOpenHostDispatches(meeting.id);
      this.addMeetingMessage(meeting.id, "system", null, null, "会议讨论已结束，正在向全体参会者同步最终记录。");
      this.queueMeetingCloseoutDispatches(meeting.id, "completed", true);
      this.audit({ actorId, action: "meeting.completed", entityType: "meeting", entityId: meeting.id, after: { summary: finalSummary, createdTaskIds: createdTasks.map((task) => task.id), noticeId: notice?.id } });
    });
    return { meeting: this.meetingView(meeting.id), createdTasks, notice, advance };
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
      this.cancelOpenHostDispatches(meetingId);
      this.addMeetingMessage(meetingId, "system", null, null, `会议已取消：${required(reason, "reason")}。`);
      this.queueMeetingCloseoutDispatches(meetingId, "canceled", false);
      this.resetRequiredTaskMeeting(meeting);
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
    if (this.isAwaitingBossStart(meeting) || meeting.end_requested_at) return [];
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
        return [{
          hostDispatchId: this.enqueueHostDispatch(
            meeting.id,
            "host_resume",
            "参会者发言超时，控制权已经返回，请继续主持会议。",
            `host-turn-timeout:${meeting.id}:${turn.id}`,
          ),
        }];
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
    if (this.isAwaitingBossStart(meeting) || meeting.end_requested_at) return null;
    return this.transaction(() => {
      if (meeting.current_turn_id) {
        const turn = this.db.prepare("SELECT * FROM meeting_turns WHERE id = ? AND status = 'waiting'").get(meeting.current_turn_id) as Row | undefined;
        if (turn) this.failMeetingTurn(turn.id, "Gateway restarted during a synchronous speaking turn");
      }
      const existing = this.db.prepare(`
        SELECT id FROM meeting_agent_dispatches
        WHERE meeting_id = ? AND status IN ('pending', 'running')
        ORDER BY created_at, rowid LIMIT 1
      `).get(meeting.id) as Row | undefined;
      if (existing) return { hostDispatchId: existing.id };
      return {
        hostDispatchId: this.enqueueHostDispatch(
          meeting.id,
          "host_recovery",
          "Gateway 已恢复。请检查会议记录和失败轮次，然后从当前状态继续主持。",
          `host-recovery:${meeting.id}:${this.maxMeetingSequence(meeting.id)}`,
        ),
      };
    });
  }

  private requireActiveHostedMeeting(actorId: string, meetingId: string, allowExistingEndRequest = false) {
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.status !== "active") throw new Error("meeting is not active");
    if (meeting.host_id !== actorId) throw new Error("only the host can perform this meeting action");
    if (this.isAwaitingBossStart(meeting)) throw new Error("meeting is waiting for Boss to start it");
    if (!allowExistingEndRequest && meeting.end_requested_at) throw new Error("meeting is waiting for Boss to decide whether it can end");
    return meeting;
  }

  private isAwaitingBossStart(meeting: Row) {
    return Boolean(meeting.boss_participates) && !meeting.boss_started_at;
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
      bossParticipates: Boolean(row.boss_participates),
      bossStartedAt: row.boss_started_at,
      awaitingBossStart: row.status === "active" && this.isAwaitingBossStart(row),
      endRequestedAt: row.end_requested_at,
      endRequestedSummary: row.end_requested_summary,
      endRequestedPublishNotice: Boolean(row.end_requested_publish_notice),
      autoEndAt: row.status === "active" && row.end_requested_at && !row.boss_participates
        ? new Date(Date.parse(row.end_requested_at) + this.automaticEndDelayMs).toISOString()
        : null,
      queuePosition: Number(row.queue_position),
      participantCount: Number(participantCount.count),
      currentTurnId: row.current_turn_id,
      waitingOnHostSince: row.waiting_on_host_since,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      canceledReason: row.canceled_reason,
      closeoutStatus: this.meetingCloseoutStatus(row.id),
    };
  }

  private meetingCloseoutStatus(meetingId: string) {
    const aggregate = this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS delivered,
        MAX(blocks_room) AS blocks_room
      FROM meeting_closeout_dispatches WHERE meeting_id = ?
    `).get(meetingId) as Row;
    const total = Number(aggregate.total ?? 0);
    if (total === 0) return null;
    const delivered = Number(aggregate.delivered ?? 0);
    const current = this.db.prepare(`
      SELECT d.*, member.name AS member_name
      FROM meeting_closeout_dispatches d
      JOIN members member ON member.id = d.member_id
      WHERE d.meeting_id = ? AND d.status != 'succeeded'
      ORDER BY CASE d.status WHEN 'running' THEN 0 ELSE 1 END, d.position, d.created_at, d.rowid
      LIMIT 1
    `).get(meetingId) as Row | undefined;
    return {
      state: delivered === total ? "delivered" as const : "syncing" as const,
      blocksRoom: Boolean(aggregate.blocks_room),
      total,
      delivered,
      pending: total - delivered,
      currentMemberId: (current?.member_id ?? null) as string | null,
      currentMemberName: (current?.member_name ?? null) as string | null,
      attempts: Number(current?.attempts ?? 0),
      lastError: (current?.last_error ?? null) as string | null,
      nextAttemptAt: (current?.next_attempt_at ?? null) as string | null,
    };
  }

  private queueMeetingEmail(meetingId: string, kind: MeetingEmailKind) {
    const id = randomUUID();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO meeting_email_notifications (id, meeting_id, kind, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(id, meetingId, kind, nowIso());
    if (Number(result.changes) > 0) {
      this.audit({ actorId: "system", action: "meeting.email_queued", entityType: "meeting", entityId: meetingId, after: { kind } });
    }
  }

  private queueTaskReviewEmail(taskId: string, submissionId: string, createdAt: string) {
    const id = randomUUID();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO task_review_email_notifications (
        id, task_id, submission_id, status, created_at
      ) VALUES (?, ?, ?, 'pending', ?)
    `).run(id, taskId, submissionId, createdAt);
    if (Number(result.changes) > 0) {
      this.audit({
        actorId: "system",
        action: "task.review_email_queued",
        entityType: "task",
        entityId: taskId,
        after: { notificationId: id, submissionId },
      });
    }
  }

  private queueBossTaskActionEmail(
    taskId: string,
    kind: "block_escalated" | "cancel_requested",
    sourceId: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ) {
    const id = randomUUID();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO boss_task_action_email_notifications (
        id, task_id, kind, source_id, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, taskId, kind, sourceId, JSON.stringify(payload), createdAt);
    if (Number(result.changes) > 0) {
      this.audit({
        actorId: "system",
        action: "task.boss_action_email_queued",
        entityType: "task",
        entityId: taskId,
        after: { notificationId: id, kind, sourceId },
      });
    }
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
    return { id, sequence: Number(row.sequence) };
  }

  private queueMeetingCloseoutDispatches(
    meetingId: string,
    outcome: MeetingCloseoutOutcome,
    blocksRoom: boolean,
  ) {
    const meeting = this.getMeetingRow(meetingId);
    const memberIds = this.meetingAgentMemberIds(meetingId);
    const toSequence = this.maxMeetingSequence(meetingId);
    const createdAt = nowIso();
    memberIds.forEach((memberId, position) => {
      const member = this.getMember(memberId, { active: false });
      const runtimeAgentId = required(member.agent_id, `member ${memberId} agentId`);
      if (runtimeAgentId !== memberId) {
        throw new Error(`company member ID must equal its OpenClaw Agent ID: ${memberId} != ${runtimeAgentId}`);
      }
      if (!this.allowedAgentIds.has(runtimeAgentId)) throw new Error(`OpenClaw agent does not exist: ${runtimeAgentId}`);
      const watermark = this.db.prepare(`
        SELECT sequence FROM meeting_context_watermarks WHERE meeting_id = ? AND member_id = ?
      `).get(meetingId, memberId) as Row | undefined;
      const fromSequence = Number(watermark?.sequence ?? 0);
      const prompt = this.buildMeetingCloseoutPrompt(meeting, member, outcome, fromSequence, toSequence);
      const dispatchId = randomUUID();
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO meeting_closeout_dispatches (
          id, meeting_id, member_id, runtime_agent_id, outcome, blocks_room, position,
          context_from_sequence, context_to_sequence, prompt, status, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        dispatchId,
        meetingId,
        memberId,
        runtimeAgentId,
        outcome,
        blocksRoom ? 1 : 0,
        position,
        fromSequence,
        toSequence,
        prompt,
        createdAt,
        createdAt,
      );
      if (Number(result.changes) > 0) {
        this.audit({
          actorId: "system",
          action: "meeting.closeout_dispatch_queued",
          entityType: "meeting",
          entityId: meetingId,
          after: { dispatchId, memberId, outcome, blocksRoom, fromSequence, toSequence, position },
        });
      }
    });
    return memberIds.length;
  }

  private meetingAgentMemberIds(meetingId: string) {
    const meeting = this.getMeetingRow(meetingId);
    const participantRows = this.db.prepare(`
      SELECT p.member_id FROM meeting_participants p
      JOIN members member ON member.id = p.member_id
      WHERE p.meeting_id = ?
      ORDER BY CASE p.role WHEN 'worker' THEN 0 ELSE 1 END, member.created_at, p.rowid
    `).all(meetingId) as Row[];
    return [...new Set([
      ...participantRows.map((row) => row.member_id as string),
      meeting.host_id as string,
    ])];
  }

  private markMeetingNoticeRead(meetingId: string, noticeId: string) {
    const memberIds = this.meetingAgentMemberIds(meetingId);
    const readAt = nowIso();
    const newlyMarkedMemberIds: string[] = [];
    for (const memberId of memberIds) {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO notice_reads (notice_id, member_id, read_at) VALUES (?, ?, ?)
      `).run(noticeId, memberId, readAt);
      if (Number(result.changes) > 0) newlyMarkedMemberIds.push(memberId);
    }
    this.audit({
      actorId: "system",
      action: "notice.meeting_participants_marked_read",
      entityType: "notice",
      entityId: noticeId,
      after: { meetingId, memberIds, newlyMarkedMemberIds },
    });
  }

  private buildMeetingCloseoutPrompt(
    meeting: Row,
    member: Row,
    outcome: MeetingCloseoutOutcome,
    fromSequence: number,
    toSequence: number,
  ) {
    const rows = this.db.prepare(`
      WITH turn_base AS (
        SELECT turn.*, MIN(msg.sequence) AS turn_first_sequence
        FROM meeting_turns turn
        LEFT JOIN meeting_messages msg ON msg.turn_id = turn.id
        WHERE turn.meeting_id = ?
        GROUP BY turn.id
      ), turn_order AS (
        SELECT turn_base.*, ROW_NUMBER() OVER (
          ORDER BY COALESCE(turn_first_sequence, 9223372036854775807), started_at, id
        ) AS round_number
        FROM turn_base
      )
      SELECT msg.*, author.name AS author_name, target.name AS target_name,
        turn_order.round_number, turn_order.turn_first_sequence,
        turn_order.speaker_id AS turn_speaker_id,
        turn_order.requested_by AS turn_requested_by,
        turn_order.kind AS turn_kind
      FROM meeting_messages msg
      LEFT JOIN members author ON author.id = msg.author_id
      LEFT JOIN members target ON target.id = msg.target_id
      LEFT JOIN turn_order ON turn_order.id = msg.turn_id
      WHERE msg.meeting_id = ? AND msg.sequence > ? AND msg.sequence <= ?
      ORDER BY msg.sequence
    `).all(meeting.id, meeting.id, fromSequence, toSequence) as Row[];
    const outcomeLabel = outcome === "completed" ? "正常完成" : outcome === "canceled" ? "已取消" : "已超时";
    const timeline = rows.length
      ? [
          `【自你上次同步后的最终会议时间线｜消息 #${padMeetingSequence(Number(rows[0]!.sequence))} → #${padMeetingSequence(toSequence)}】`,
          ...rows.map((row) => formatMeetingContextMessage(row, member.id, fromSequence)),
        ]
      : [
          "【自你上次同步后的最终会议时间线】",
          outcome === "completed"
            ? `没有遗漏的编号消息。最终总结：\n${meeting.summary ?? "（无）"}`
            : `没有遗漏的编号消息。结束原因：${meeting.canceled_reason ?? outcomeLabel}`,
        ];
    return [
      "【Company OS 会议结束同步】",
      `会议「${meeting.title}」已结束。`,
      `结果：${outcomeLabel}`,
      `你的身份：${member.name}（${member.id}）`,
      "",
      ...timeline,
      "",
      "请阅读并同步以上最终会议记录。后续执行以 Company OS 中的正式任务为准。",
      "阅读完成后只需确认已同步；本场会议已经关闭，不要再调用会议工具。",
    ].join("\n");
  }

  private queueMeetingSessionContextAppend(input: {
    meetingId: string;
    memberId: string;
    sessionIdentity: MeetingToolSessionIdentity;
    toolName: "company_meeting_speak" | "company_meeting_delegate";
    message: { id: string; sequence: number };
    turnId: string | null;
    roundNumber: number | null;
    recordKind: "speech" | "delegate" | "host_speech";
    targetId: string | null;
    body: string;
  }) {
    const member = this.getMember(input.memberId, { active: false });
    const target = input.targetId ? this.getMember(input.targetId, { active: false }) : null;
    const id = randomUUID();
    const formattedText = formatSelfMeetingContextMessage({
      sequence: input.message.sequence,
      roundNumber: input.roundNumber,
      recordKind: input.recordKind,
      memberName: member.name,
      targetName: target?.name ?? null,
      body: input.body,
    });
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO meeting_session_context_appends (
        id, meeting_id, member_id, runtime_agent_id, session_key, session_id,
        tool_name, tool_call_id, message_id, message_sequence, turn_id, round_number,
        record_kind, target_id, target_name, member_name, body, formatted_text,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id,
      input.meetingId,
      input.memberId,
      input.sessionIdentity.agentId,
      input.sessionIdentity.sessionKey,
      input.sessionIdentity.sessionId,
      input.toolName,
      input.sessionIdentity.toolCallId,
      input.message.id,
      input.message.sequence,
      input.turnId,
      input.roundNumber,
      input.recordKind,
      input.targetId,
      target?.name ?? null,
      member.name,
      input.body,
      formattedText,
      nowIso(),
    );
    const appendId = Number(result.changes) > 0
      ? id
      : (this.db.prepare(`
          SELECT id FROM meeting_session_context_appends WHERE session_id = ? AND tool_call_id = ?
        `).get(input.sessionIdentity.sessionId, input.sessionIdentity.toolCallId) as Row).id as string;
    if (Number(result.changes) > 0) {
      this.audit({
        actorId: input.memberId,
        action: "meeting.session_context_append_queued",
        entityType: "meeting",
        entityId: input.meetingId,
        after: {
          appendId,
          toolName: input.toolName,
          messageId: input.message.id,
          messageSequence: input.message.sequence,
          roundNumber: input.roundNumber,
        },
      });
    }
    return appendId;
  }

  private validateMeetingToolSession(actorId: string, identity: MeetingToolSessionIdentity) {
    const runtimeAgentId = this.runtimeAgentId(actorId);
    if (required(identity.agentId, "tool session agentId") !== runtimeAgentId) {
      throw new Error("meeting tool session Agent does not match the authenticated member");
    }
    const expectedSessionKey = `agent:${runtimeAgentId}:main`;
    if (required(identity.sessionKey, "tool sessionKey") !== expectedSessionKey) {
      throw new Error(`meeting tools must run in the Agent main session: ${expectedSessionKey}`);
    }
    return {
      agentId: runtimeAgentId,
      sessionKey: expectedSessionKey,
      sessionId: required(identity.sessionId, "tool sessionId"),
      toolCallId: required(identity.toolCallId, "tool call ID"),
    };
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

  private meetingRoundNumber(turnId: string) {
    const row = this.db.prepare(`
      WITH turn_base AS (
        SELECT t.id, t.started_at, MIN(msg.sequence) AS first_sequence
        FROM meeting_turns t
        LEFT JOIN meeting_messages msg ON msg.turn_id = t.id
        WHERE t.meeting_id = (SELECT meeting_id FROM meeting_turns WHERE id = ?)
        GROUP BY t.id
      ), ordered AS (
        SELECT id, ROW_NUMBER() OVER (
          ORDER BY COALESCE(first_sequence, 9223372036854775807), started_at, id
        ) AS round_number
        FROM turn_base
      )
      SELECT round_number FROM ordered WHERE id = ?
    `).get(turnId, turnId) as Row | undefined;
    if (!row) throw new Error(`meeting turn not found: ${turnId}`);
    return Number(row.round_number);
  }

  nextPendingInterventionTurn(meetingId: string): MeetingTurnDispatch | null {
    return this.transaction(() => {
      const meeting = this.getMeetingRow(meetingId);
      if (meeting.status !== "active" || meeting.current_turn_id || this.isAwaitingBossStart(meeting) || meeting.end_requested_at) return null;
      while (true) {
        const intervention = this.db.prepare(`
          SELECT * FROM meeting_interventions WHERE meeting_id = ? AND status = 'pending' ORDER BY created_at, rowid LIMIT 1
        `).get(meetingId) as Row | undefined;
        if (!intervention) {
          this.db.prepare("UPDATE meetings SET waiting_on_host_since = ? WHERE id = ?").run(nowIso(), meetingId);
          return null;
        }
        if (!intervention.target_id || intervention.target_id === meeting.host_id) {
          this.db.prepare("UPDATE meeting_interventions SET status = 'delivered', delivered_at = ? WHERE id = ?")
            .run(nowIso(), intervention.id);
          continue;
        }
        const instruction = `Boss @你：${intervention.body}`;
        const turn = this.createMeetingTurn(meetingId, intervention.target_id, "boss", "boss", instruction, intervention.id);
        this.db.prepare("UPDATE meeting_interventions SET status = 'delivering' WHERE id = ?").run(intervention.id);
        this.db.prepare("UPDATE meetings SET current_turn_id = ?, waiting_on_host_since = NULL WHERE id = ?").run(turn.id, meetingId);
        const context = this.buildMeetingContext(meetingId, intervention.target_id, {
          turnId: turn.id,
          instruction,
          role: "speaker",
        });
        this.db.prepare("UPDATE meeting_turns SET context_from_sequence = ?, context_to_sequence = ? WHERE id = ?")
          .run(context.fromSequence, context.toSequence, turn.id);
        this.audit({
          actorId: "boss",
          action: "meeting.boss_turn_started",
          entityType: "meeting",
          entityId: meetingId,
          after: { interventionId: intervention.id, turnId: turn.id, speakerId: intervention.target_id },
        });
        return {
          ...context,
          turnId: turn.id,
          speakerId: intervention.target_id,
          agentId: this.runtimeAgentId(intervention.target_id),
        };
      }
    });
  }

  buildMeetingContext(
    meetingId: string,
    memberId: string,
    options: { role: "host" | "speaker"; instruction: string; turnId?: string },
  ): MeetingContextEnvelope {
    const meeting = this.getMeetingRow(meetingId);
    const member = this.getMember(memberId, { active: false });
    const related = memberId === meeting.host_id || Boolean(this.db.prepare(
      "SELECT 1 AS ok FROM meeting_participants WHERE meeting_id = ? AND member_id = ?",
    ).get(meetingId, memberId));
    if (!related) throw new Error("meeting context can only be delivered to its host or participants");
    const watermark = this.db.prepare(
      "SELECT sequence FROM meeting_context_watermarks WHERE meeting_id = ? AND member_id = ?",
    ).get(meetingId, memberId) as Row | undefined;
    const fromSequence = Number(watermark?.sequence ?? 0);
    const toSequence = this.maxMeetingSequence(meetingId);
    const rows = this.db.prepare(`
      WITH turn_base AS (
        SELECT
          turn.*,
          MIN(msg.sequence) AS turn_first_sequence
        FROM meeting_turns turn
        LEFT JOIN meeting_messages msg ON msg.turn_id = turn.id
        WHERE turn.meeting_id = ?
        GROUP BY turn.id
      ), turn_order AS (
        SELECT
          turn_base.*,
          ROW_NUMBER() OVER (
            ORDER BY COALESCE(turn_first_sequence, 9223372036854775807), started_at, id
          ) AS round_number
        FROM turn_base
      )
      SELECT
        msg.*,
        author.name AS author_name,
        target.name AS target_name,
        turn_order.round_number,
        turn_order.turn_first_sequence,
        turn_order.speaker_id AS turn_speaker_id,
        turn_order.requested_by AS turn_requested_by,
        turn_order.kind AS turn_kind
      FROM meeting_messages msg
      LEFT JOIN members author ON author.id = msg.author_id
      LEFT JOIN members target ON target.id = msg.target_id
      LEFT JOIN turn_order ON turn_order.id = msg.turn_id
      WHERE msg.meeting_id = ? AND msg.sequence > ? AND msg.sequence <= ?
      ORDER BY msg.sequence
    `).all(meetingId, meetingId, fromSequence, toSequence) as Row[];
    const host = this.getMember(meeting.host_id, { active: false });
    const lines = [
      "【Company OS 公司会议】",
      `会议 ID：${meetingId}`,
      `主题：${meeting.title}`,
      `类型：${meeting.type === "task" ? "任务会议" : "普通讨论会"}`,
      `议程：${meeting.agenda}`,
      `主持人：${host.name}（${meeting.host_id}）`,
      `你的身份：${member.name}（${memberId}）`,
      "",
      rows.length
        ? `【新增会议时间线｜消息 #${padMeetingSequence(Number(rows[0]?.sequence))} → #${padMeetingSequence(toSequence)}｜必须严格按消息号顺序阅读】`
        : "自你上次成功参与后没有新增会议消息。",
      ...rows.map((row) => formatMeetingContextMessage(row, memberId, fromSequence)),
      "",
      `当前要求：${required(options.instruction, "instruction")}`,
      "",
      "【本轮表达要求】",
      "- 结论先行，只回答当前要求和议程直接相关的内容；不要复述完整背景、会议记录或他人已经说过的话。",
      "- 默认使用“结论 + 最多 3 条关键依据 + 明确下一步/风险（如有）”；每条只表达一个重点。",
      "- 删除客套、铺垫、重复总结和未经要求的发散方案。需要报告核验结果时只给决策相关证据，不粘贴大段日志或代码。",
      "- 默认控制在 300 字以内；确有复杂证据时可以略超，但仍须保持结构化和聚焦。",
      "",
    ];
    if (options.role === "speaker") {
      lines.push(
        "你现在拥有发言权。请按上述格式形成一次简练、完整的实质性回应，然后调用 company_meeting_speak 提交正文。",
      );
    } else {
      lines.push(
        "你是本场主持人。主持发言只保留“当前共识、尚存分歧、下一动作”；不要逐段复述参会者发言。点名时一次只提出一个需要决策或核验的明确问题。",
        "请简练回应新增内容，再使用 company_meeting_speak、company_meeting_delegate 或 company_meeting_set_task_drafts 推进会议；结论和责任人已经明确时及时申请结束，不继续空泛讨论。",
        meeting.boss_participates
          ? "需要结束时调用 company_meeting_end 提交总结并申请 Boss 批准；你不能直接关闭会议。"
          : `需要结束时调用 company_meeting_end 提交总结；申请后倒计时 ${Math.ceil(this.automaticEndDelayMs / 1000)} 秒自动关闭会议。`,
      );
    }
    return { meetingId, memberId, fromSequence, toSequence, prompt: lines.join("\n") };
  }

  advanceMeetingWatermark(meetingId: string, memberId: string, sequence: number) {
    const bounded = Math.min(Math.max(Math.floor(sequence), 0), this.maxMeetingSequence(meetingId));
    this.db.prepare(`
      INSERT INTO meeting_context_watermarks (meeting_id, member_id, sequence, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(meeting_id, member_id) DO UPDATE SET
        sequence = MAX(meeting_context_watermarks.sequence, excluded.sequence),
        updated_at = excluded.updated_at
    `).run(meetingId, memberId, bounded, nowIso());
    return bounded;
  }

  acknowledgeHostContext(meetingId: string, actorId: string) {
    const meeting = this.getMeetingRow(meetingId);
    if (meeting.host_id !== actorId || meeting.status !== "active") return;
    this.advanceMeetingWatermark(meetingId, actorId, this.maxMeetingSequence(meetingId));
  }

  recoverMeetingCloseoutDispatches() {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM meeting_closeout_dispatches WHERE status = 'running'").all() as Row[];
      const recoveredAt = nowIso();
      for (const row of rows) {
        this.db.prepare(`
          UPDATE meeting_closeout_dispatches
          SET status = 'pending', next_attempt_at = ?, lease_expires_at = NULL,
            last_error = 'Gateway restarted during meeting closeout dispatch'
          WHERE id = ?
        `).run(recoveredAt, row.id);
        this.audit({
          actorId: "system",
          action: "meeting.closeout_dispatch_recovered",
          entityType: "meeting",
          entityId: row.meeting_id,
          after: { dispatchId: row.id, memberId: row.member_id },
        });
      }
      return rows.length;
    });
  }

  claimNextMeetingCloseoutDispatch(leaseMs = 15 * 60 * 1000): MeetingCloseoutDispatch | null {
    return this.transaction(() => {
      const claimedAt = nowIso();
      const row = this.db.prepare(`
        SELECT d.*, member.name AS member_name
        FROM meeting_closeout_dispatches d
        JOIN members member ON member.id = d.member_id
        JOIN meetings meeting ON meeting.id = d.meeting_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= ?
        ORDER BY d.blocks_room DESC, meeting.ended_at, d.position, d.created_at, d.rowid
        LIMIT 1
      `).get(claimedAt) as Row | undefined;
      if (!row) return null;
      this.db.prepare(`
        UPDATE meeting_closeout_dispatches
        SET status = 'running', attempts = attempts + 1, started_at = ?,
          lease_expires_at = ?, last_error = NULL
        WHERE id = ? AND status = 'pending'
      `).run(claimedAt, new Date(Date.now() + leaseMs).toISOString(), row.id);
      return mapMeetingCloseoutDispatch({
        ...row,
        status: "running",
        attempts: Number(row.attempts) + 1,
        started_at: claimedAt,
      });
    });
  }

  completeMeetingCloseoutDispatch(dispatchId: string): MeetingAdvance {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM meeting_closeout_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status === "succeeded") return {};
      if (row.status !== "running") throw new Error("meeting closeout dispatch is not running");
      const completedAt = nowIso();
      this.db.prepare(`
        UPDATE meeting_closeout_dispatches
        SET status = 'succeeded', completed_at = ?, lease_expires_at = NULL, last_error = NULL
        WHERE id = ?
      `).run(completedAt, dispatchId);
      this.advanceMeetingWatermark(row.meeting_id, row.member_id, Number(row.context_to_sequence));
      this.audit({
        actorId: "system",
        action: "meeting.closeout_delivered",
        entityType: "meeting",
        entityId: row.meeting_id,
        after: { dispatchId, memberId: row.member_id, attempts: Number(row.attempts) },
      });
      const remaining = this.db.prepare(`
        SELECT COUNT(*) AS count FROM meeting_closeout_dispatches
        WHERE meeting_id = ? AND status != 'succeeded'
      `).get(row.meeting_id) as Row;
      if (Number(remaining.count) > 0) return {};
      this.audit({
        actorId: "system",
        action: "meeting.closeout_all_delivered",
        entityType: "meeting",
        entityId: row.meeting_id,
      });
      return Boolean(row.blocks_room) ? this.activateNextMeeting() : {};
    });
  }

  retryMeetingCloseoutDispatch(dispatchId: string, error: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM meeting_closeout_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running") return null;
      const reason = required(error, "meeting closeout error").slice(0, 1000);
      const nextAttemptAt = new Date(Date.now() + closeoutRetryDelayMs(Number(row.attempts))).toISOString();
      this.db.prepare(`
        UPDATE meeting_closeout_dispatches
        SET status = 'pending', last_error = ?, next_attempt_at = ?, lease_expires_at = NULL
        WHERE id = ?
      `).run(reason, nextAttemptAt, dispatchId);
      this.audit({
        actorId: "system",
        action: "meeting.closeout_dispatch_retry",
        entityType: "meeting",
        entityId: row.meeting_id,
        reason,
        after: { dispatchId, memberId: row.member_id, attempts: Number(row.attempts), nextAttemptAt },
      });
      return nextAttemptAt;
    });
  }

  hasReadyMeetingCloseoutDispatches(now = nowIso()) {
    return Boolean(this.db.prepare(`
      SELECT 1 AS ok FROM meeting_closeout_dispatches
      WHERE status = 'pending' AND next_attempt_at <= ? LIMIT 1
    `).get(now));
  }

  nextMeetingCloseoutDispatchAt() {
    const row = this.db.prepare(`
      SELECT MIN(next_attempt_at) AS next_attempt_at
      FROM meeting_closeout_dispatches WHERE status = 'pending'
    `).get() as Row;
    return (row.next_attempt_at ?? null) as string | null;
  }

  meetingTurnDelivery(turnId: string): MeetingTurnDelivery {
    const turn = this.db.prepare("SELECT * FROM meeting_turns WHERE id = ?").get(turnId) as Row | undefined;
    if (!turn) throw new Error(`meeting turn not found: ${turnId}`);
    const speech = this.db.prepare(`
      SELECT body FROM meeting_messages
      WHERE meeting_id = ? AND turn_id = ? AND author_kind = 'member' AND author_id = ?
      ORDER BY sequence DESC LIMIT 1
    `).get(turn.meeting_id, turn.id, turn.speaker_id) as Row | undefined;
    return {
      turnId: turn.id,
      speakerId: turn.speaker_id,
      status: turn.status === "completed" ? "completed" : "failed",
      body: speech?.body ?? null,
      completionSource: turn.completion_source ?? null,
      error: turn.error ?? null,
      contextFromSequence: Number(turn.context_from_sequence ?? 0),
      contextToSequence: Number(turn.context_to_sequence ?? 0),
    };
  }

  isMeetingTurnWaiting(turnId: string) {
    const row = this.db.prepare("SELECT status FROM meeting_turns WHERE id = ?").get(turnId) as Row | undefined;
    if (!row) throw new Error(`meeting turn not found: ${turnId}`);
    return row.status === "waiting";
  }

  completeMeetingTurnFallback(turnId: string, speakerId: string, invokedAgentId: string, reply: string, rawReturn?: unknown): MeetingTurnDelivery {
    return this.transaction(() => {
      const turn = this.db.prepare("SELECT * FROM meeting_turns WHERE id = ?").get(turnId) as Row | undefined;
      if (!turn) throw new Error(`meeting turn not found: ${turnId}`);
      if (turn.status !== "waiting") return this.meetingTurnDelivery(turnId);
      if (turn.speaker_id !== speakerId) throw new Error("fallback speaker does not match the invoked Agent");
      if (this.getMember(speakerId, { active: false }).agent_id !== invokedAgentId) {
        throw new Error("fallback Agent ID does not match the speaker's configured Agent");
      }
      const meeting = this.getMeetingRow(turn.meeting_id);
      if (meeting.status !== "active" || meeting.current_turn_id !== turn.id) throw new Error("fallback turn is no longer active");
      const body = required(reply, "fallback reply").slice(0, 100_000);
      const completedAt = nowIso();
      this.db.prepare("UPDATE meeting_turns SET status = 'completed', completion_source = 'fallback', completed_at = ? WHERE id = ?")
        .run(completedAt, turn.id);
      this.addMeetingMessage(turn.meeting_id, "member", speakerId, null, body, turn.id);
      if (turn.intervention_id) {
        this.db.prepare("UPDATE meeting_interventions SET status = 'delivered', delivered_at = ? WHERE id = ?")
          .run(completedAt, turn.intervention_id);
      }
      this.db.prepare("UPDATE meetings SET current_turn_id = NULL, waiting_on_host_since = ? WHERE id = ?")
        .run(completedAt, turn.meeting_id);
      this.advanceMeetingWatermark(turn.meeting_id, speakerId, this.maxMeetingSequence(turn.meeting_id));
      this.audit({
        actorId: "system",
        action: "meeting.spoke_fallback",
        entityType: "meeting",
        entityId: turn.meeting_id,
        reason: "invoked Agent returned text without calling company_meeting_speak",
        after: { turnId, speakerId, invokedAgentId, body, rawReturn: rawReturn ?? reply },
      });
      return this.meetingTurnDelivery(turnId);
    });
  }

  failMeetingTurn(turnId: string, error: string): MeetingTurnDelivery {
    return this.transaction(() => {
      const turn = this.db.prepare("SELECT * FROM meeting_turns WHERE id = ?").get(turnId) as Row | undefined;
      if (!turn) throw new Error(`meeting turn not found: ${turnId}`);
      if (turn.status !== "waiting") return this.meetingTurnDelivery(turnId);
      const failedAt = nowIso();
      const reason = required(error, "error").slice(0, 1000);
      this.db.prepare("UPDATE meeting_turns SET status = 'failed', completed_at = ?, error = ? WHERE id = ?")
        .run(failedAt, reason, turnId);
      if (turn.intervention_id) {
        this.db.prepare("UPDATE meeting_interventions SET status = 'delivered', delivered_at = ? WHERE id = ?")
          .run(failedAt, turn.intervention_id);
      }
      this.db.prepare("UPDATE meetings SET current_turn_id = NULL, waiting_on_host_since = ? WHERE id = ? AND current_turn_id = ?")
        .run(failedAt, turn.meeting_id, turnId);
      this.addMeetingMessage(turn.meeting_id, "system", null, null, `${turn.speaker_id} 本轮发言失败：${reason}`, turnId);
      this.audit({
        actorId: "system",
        action: "meeting.turn_failed",
        entityType: "meeting",
        entityId: turn.meeting_id,
        reason,
        after: { turnId, speakerId: turn.speaker_id },
      });
      return this.meetingTurnDelivery(turnId);
    });
  }

  recoverSessionContextAppends() {
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE meeting_session_context_appends
        SET status = 'pending', last_error = 'Gateway restarted during session context append'
        WHERE status = 'appending'
      `).run();
      return Number(result.changes);
    });
  }

  claimNextSessionContextAppend(identity?: { agentId: string; sessionKey: string; sessionId: string }) {
    return this.transaction(() => {
      const filters = identity
        ? "AND runtime_agent_id = ? AND session_key = ? AND session_id = ?"
        : "";
      const params = identity ? [identity.agentId, identity.sessionKey, identity.sessionId] : [];
      const row = this.db.prepare(`
        SELECT * FROM meeting_session_context_appends
        WHERE status = 'pending' AND attempts < 3 ${filters}
        ORDER BY created_at, rowid LIMIT 1
      `).get(...params) as Row | undefined;
      if (!row) return null;
      this.db.prepare(`
        UPDATE meeting_session_context_appends
        SET status = 'appending', attempts = attempts + 1, last_error = NULL
        WHERE id = ? AND status = 'pending'
      `).run(row.id);
      return mapMeetingSessionContextAppend({ ...row, status: "appending", attempts: Number(row.attempts) + 1 });
    });
  }

  completeSessionContextAppend(appendId: string, appendedMessageId: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM meeting_session_context_appends WHERE id = ?").get(appendId) as Row | undefined;
      if (!row || row.status === "appended") return false;
      if (row.status !== "appending") throw new Error("session context append is not currently claimed");
      const appendedAt = nowIso();
      this.db.prepare(`
        UPDATE meeting_session_context_appends
        SET status = 'appended', appended_message_id = ?, appended_at = ?, last_error = NULL
        WHERE id = ?
      `).run(required(appendedMessageId, "appended message ID"), appendedAt, appendId);
      this.advanceMeetingWatermark(row.meeting_id, row.member_id, Number(row.message_sequence));
      this.audit({
        actorId: "system",
        action: "meeting.session_context_appended",
        entityType: "meeting",
        entityId: row.meeting_id,
        after: {
          appendId,
          memberId: row.member_id,
          messageId: row.message_id,
          messageSequence: Number(row.message_sequence),
          sessionId: row.session_id,
        },
      });
      return true;
    });
  }

  failSessionContextAppend(appendId: string, error: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM meeting_session_context_appends WHERE id = ?").get(appendId) as Row | undefined;
      if (!row || row.status !== "appending") return false;
      const reason = required(error, "session context append error").slice(0, 1000);
      const retry = Number(row.attempts) < 3;
      this.db.prepare(`
        UPDATE meeting_session_context_appends
        SET status = ?, last_error = ? WHERE id = ?
      `).run(retry ? "pending" : "failed", reason, appendId);
      this.audit({
        actorId: "system",
        action: retry ? "meeting.session_context_append_retry" : "meeting.session_context_append_failed",
        entityType: "meeting",
        entityId: row.meeting_id,
        reason,
        after: { appendId, memberId: row.member_id, attempts: Number(row.attempts) },
      });
      return retry;
    });
  }

  hasPendingSessionContextAppends(identity?: { agentId: string; sessionKey: string; sessionId: string }) {
    const filters = identity
      ? "AND runtime_agent_id = ? AND session_key = ? AND session_id = ?"
      : "";
    const params = identity ? [identity.agentId, identity.sessionKey, identity.sessionId] : [];
    return Boolean(this.db.prepare(`
      SELECT 1 AS ok FROM meeting_session_context_appends
      WHERE status = 'pending' AND attempts < 3 ${filters} LIMIT 1
    `).get(...params));
  }

  queueHostResumeAfterContextAppend(meetingId: string, contextAppendId: string, reason: string, dedupeKey: string) {
    const append = this.db.prepare("SELECT * FROM meeting_session_context_appends WHERE id = ?").get(contextAppendId) as Row | undefined;
    if (!append || append.meeting_id !== meetingId) throw new Error("host resume context append does not belong to the meeting");
    const meeting = this.getMeetingRow(meetingId);
    if (append.member_id !== meeting.host_id) throw new Error("host resume must wait for the host's own context append");
    return this.enqueueHostDispatch(meetingId, "host_resume", reason, dedupeKey, contextAppendId);
  }

  queueHostResume(meetingId: string, reason: string, dedupeKey: string) {
    return this.enqueueHostDispatch(meetingId, "host_resume", reason, dedupeKey);
  }

  recoverAgentDispatches() {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM meeting_agent_dispatches WHERE status = 'running'").all() as Row[];
      for (const row of rows) {
        this.db.prepare(`
          UPDATE meeting_agent_dispatches SET status = 'pending', lease_expires_at = NULL,
            last_error = 'Gateway restarted during host dispatch' WHERE id = ?
        `).run(row.id);
        this.audit({ actorId: "system", action: "meeting.host_dispatch_recovered", entityType: "meeting", entityId: row.meeting_id, after: { dispatchId: row.id } });
      }
      return rows.length;
    });
  }

  claimNextHostDispatch(leaseMs = 35 * 60 * 1000) {
    return this.transaction(() => {
      while (true) {
        const row = this.db.prepare(`
          SELECT d.* FROM meeting_agent_dispatches d
          WHERE d.status = 'pending' AND d.attempts < 3
            AND (
              d.wait_for_context_append_id IS NULL OR EXISTS (
                SELECT 1 FROM meeting_session_context_appends a
                WHERE a.id = d.wait_for_context_append_id AND a.status = 'appended'
              )
            )
          ORDER BY d.created_at, d.rowid LIMIT 1
        `).get() as Row | undefined;
        if (!row) return null;
        const meeting = this.getMeetingRow(row.meeting_id);
        if (meeting.status !== "active" || this.isAwaitingBossStart(meeting) || meeting.end_requested_at) {
          this.db.prepare("UPDATE meeting_agent_dispatches SET status = 'canceled', completed_at = ?, lease_expires_at = NULL WHERE id = ?")
            .run(nowIso(), row.id);
          continue;
        }
        const startedAt = nowIso();
        this.db.prepare(`
          UPDATE meeting_agent_dispatches SET status = 'running', attempts = attempts + 1,
            started_at = ?, lease_expires_at = ?, last_error = NULL WHERE id = ?
        `).run(startedAt, new Date(Date.now() + leaseMs).toISOString(), row.id);
        const runtimeAgentId = this.runtimeAgentId(row.target_agent_id);
        return mapHostDispatch({
          ...row,
          target_runtime_agent_id: runtimeAgentId,
          status: "running",
          attempts: Number(row.attempts) + 1,
          started_at: startedAt,
        });
      }
    });
  }

  hasPendingHostDispatches() {
    return Boolean(this.db.prepare(`
      SELECT 1 AS ok FROM meeting_agent_dispatches d
      WHERE d.status = 'pending' AND d.attempts < 3
        AND (
          d.wait_for_context_append_id IS NULL OR EXISTS (
            SELECT 1 FROM meeting_session_context_appends a
            WHERE a.id = d.wait_for_context_append_id AND a.status = 'appended'
          )
        )
      LIMIT 1
    `).get());
  }

  setHostDispatchContext(dispatchId: string, context: MeetingContextEnvelope) {
    this.db.prepare(`
      UPDATE meeting_agent_dispatches SET context_from_sequence = ?, context_to_sequence = ? WHERE id = ? AND status = 'running'
    `).run(context.fromSequence, context.toSequence, dispatchId);
  }

  hostDispatchHasProgress(dispatchId: string) {
    const row = this.db.prepare(`
      SELECT meeting_id, target_agent_id, context_to_sequence, started_at
      FROM meeting_agent_dispatches WHERE id = ?
    `).get(dispatchId) as Row | undefined;
    if (!row || row.context_to_sequence === null || row.context_to_sequence === undefined || !row.started_at) return false;
    const authoredMessage = this.db.prepare(`
      SELECT 1 AS ok FROM meeting_messages
      WHERE meeting_id = ? AND sequence > ? AND author_kind = 'member' AND author_id = ? LIMIT 1
    `).get(row.meeting_id, Number(row.context_to_sequence), row.target_agent_id);
    if (authoredMessage) return true;
    return Boolean(this.db.prepare(`
      SELECT 1 AS ok FROM audit_events
      WHERE entity_type = 'meeting' AND entity_id = ? AND actor_id = ? AND created_at >= ?
        AND action IN ('meeting.host_spoke', 'meeting.delegated', 'meeting.task_drafts_set', 'meeting.end_requested', 'meeting.completed')
      LIMIT 1
    `).get(row.meeting_id, row.target_agent_id, row.started_at));
  }

  completeHostDispatch(dispatchId: string, deliveredThroughSequence: number) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM meeting_agent_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row) return;
      const completedByDispatchedHost = row.status === "canceled" && Boolean(this.db.prepare(`
        SELECT 1 AS ok FROM audit_events
        WHERE entity_type = 'meeting' AND entity_id = ? AND actor_id = ?
          AND action = 'meeting.completed' AND created_at >= ? LIMIT 1
      `).get(row.meeting_id, row.target_agent_id, row.started_at));
      if (row.status !== "running" && !completedByDispatchedHost) return;
      const completedAt = nowIso();
      this.db.prepare(`
        UPDATE meeting_agent_dispatches SET status = 'succeeded', completed_at = ?, lease_expires_at = NULL,
          last_error = NULL WHERE id = ?
      `).run(completedAt, dispatchId);
      this.advanceMeetingWatermark(row.meeting_id, row.target_agent_id, deliveredThroughSequence);
      this.audit({ actorId: "system", action: "meeting.host_dispatch_succeeded", entityType: "meeting", entityId: row.meeting_id, after: { dispatchId, attempts: row.attempts } });
    });
  }

  failHostDispatch(dispatchId: string, error: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM meeting_agent_dispatches WHERE id = ?").get(dispatchId) as Row | undefined;
      if (!row || row.status !== "running") return null;
      const reason = required(error, "error").slice(0, 1000);
      const retry = Number(row.attempts) < 3 && this.getMeetingRow(row.meeting_id).status === "active";
      this.db.prepare(`
        UPDATE meeting_agent_dispatches SET status = ?, last_error = ?, lease_expires_at = NULL,
          completed_at = ? WHERE id = ?
      `).run(retry ? "pending" : "failed", reason, retry ? null : nowIso(), dispatchId);
      this.audit({
        actorId: "system",
        action: retry ? "meeting.host_dispatch_retry" : "meeting.host_dispatch_failed",
        entityType: "meeting",
        entityId: row.meeting_id,
        reason,
        after: { dispatchId, attempts: row.attempts },
      });
      return retry;
    });
  }

  private enqueueHostDispatch(
    meetingId: string,
    kind: "host_start" | "host_resume" | "host_recovery",
    reason: string,
    dedupeKey: string,
    waitForContextAppendId?: string,
  ) {
    const meeting = this.getMeetingRow(meetingId);
    const id = randomUUID();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO meeting_agent_dispatches (
        id, meeting_id, kind, target_agent_id, reason, dedupe_key,
        wait_for_context_append_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id,
      meetingId,
      kind,
      meeting.host_id,
      required(reason, "dispatch reason"),
      dedupeKey,
      waitForContextAppendId ?? null,
      nowIso(),
    );
    const dispatchId = Number(result.changes) > 0
      ? id
      : (this.db.prepare("SELECT id FROM meeting_agent_dispatches WHERE dedupe_key = ?").get(dedupeKey) as Row).id as string;
    if (Number(result.changes) > 0) {
      this.audit({ actorId: "system", action: "meeting.host_dispatch_queued", entityType: "meeting", entityId: meetingId, after: { dispatchId, kind, reason } });
    }
    return dispatchId;
  }

  private cancelOpenHostDispatches(meetingId: string) {
    this.db.prepare(`
      UPDATE meeting_agent_dispatches SET status = 'canceled', completed_at = ?, lease_expires_at = NULL
      WHERE meeting_id = ? AND status IN ('pending', 'running')
    `).run(nowIso(), meetingId);
  }

  private maxMeetingSequence(meetingId: string) {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM meeting_messages WHERE meeting_id = ?")
      .get(meetingId) as Row;
    return Number(row.sequence);
  }

  private runtimeAgentId(memberId: string) {
    const member = this.getMember(memberId);
    const agentId = required(member.agent_id, `member ${memberId} agentId`);
    if (agentId !== memberId) throw new Error(`company member ID must equal its OpenClaw Agent ID: ${memberId} != ${agentId}`);
    if (!this.allowedAgentIds.has(agentId)) throw new Error(`OpenClaw agent does not exist: ${agentId}`);
    return agentId;
  }

  private resetRequiredTaskMeeting(meeting: Row) {
    if (!meeting.parent_task_id) return;
    const result = this.db.prepare(`
      UPDATE task_meeting_requirements SET status = 'required', meeting_id = NULL
      WHERE task_id = ? AND meeting_id = ? AND status != 'fulfilled'
    `).run(meeting.parent_task_id, meeting.id);
    if (Number(result.changes) > 0) {
      this.audit({
        actorId: "system",
        action: "task.required_meeting_reset",
        entityType: "task",
        entityId: meeting.parent_task_id,
        after: { meetingId: meeting.id, meetingStatus: meeting.status },
      });
    }
  }

  private activateNextMeeting(): MeetingAdvance {
    if (this.roomIsOccupied()) return {};
    const next = this.db.prepare("SELECT * FROM meetings WHERE status = 'queued' ORDER BY queue_position, created_at LIMIT 1").get() as Row | undefined;
    if (!next) return {};
    const startedAt = nowIso();
    const bossParticipates = Boolean(next.boss_participates);
    this.db.prepare(`
      UPDATE meetings SET status = 'active', queue_position = 0, started_at = ?, waiting_on_host_since = ? WHERE id = ?
    `).run(startedAt, bossParticipates ? null : startedAt, next.id);
    if (next.parent_task_id) {
      this.db.prepare(`
        UPDATE task_meeting_requirements SET status = 'active'
        WHERE task_id = ? AND meeting_id = ? AND status = 'scheduled'
      `).run(next.parent_task_id, next.id);
    }
    this.addMeetingMessage(
      next.id,
      "system",
      null,
      null,
      bossParticipates
        ? "前一场会议已结束，本场已进入会议室，正在等待 Boss 点击“开始会议”。"
        : "前一场会议已结束，会议室现已开放。",
    );
    if (bossParticipates) this.queueMeetingEmail(next.id, "room_entered");
    this.normalizeMeetingQueue();
    this.audit({ actorId: "system", action: "meeting.activated", entityType: "meeting", entityId: next.id });
    if (bossParticipates) return { activatedMeetingId: next.id };
    return {
      activatedMeetingId: next.id,
      hostDispatchId: this.enqueueHostDispatch(
        next.id,
        "host_start",
        "排队会议现已进入会议室，请组织第一轮发言。",
        `host-activate:${next.id}`,
      ),
    };
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
    this.resetRequiredTaskMeeting(meeting);
    this.cancelOpenHostDispatches(meeting.id);
    this.addMeetingMessage(meeting.id, "system", null, null, `${reason}，会议已超时结束；未创建任务且未发布会议汇报。`);
    this.queueMeetingCloseoutDispatches(meeting.id, "timed_out", true);
    this.audit({ actorId: "system", action: "meeting.timed_out", entityType: "meeting", entityId: meeting.id, reason });
    return {};
  }

  private roomIsOccupied() {
    if (this.db.prepare("SELECT 1 AS ok FROM meetings WHERE status = 'active' LIMIT 1").get()) return true;
    return Boolean(this.db.prepare(`
      SELECT 1 AS ok FROM meeting_closeout_dispatches
      WHERE blocks_room = 1 AND status != 'succeeded' LIMIT 1
    `).get());
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
    const closing = meetings.find((meeting) => meeting.closeoutStatus?.blocksRoom && meeting.closeoutStatus.state === "syncing") ?? null;
    return {
      organization: this.listMembers(true),
      tasks: this.listTasks("boss"),
      notices: this.listNotices("boss"),
      meetings: {
        active: meetings.find((meeting) => meeting.status === "active") ?? null,
        closing,
        queue: meetings.filter((meeting) => meeting.status === "queued"),
        history: meetings.filter((meeting) => !OPEN_MEETING_STATUSES.has(meeting.status) && meeting.id !== closing?.id),
      },
      taskPromptPool: this.taskPromptPoolSummary(),
      noticeUnreadReminder: this.noticeReminderSummary(),
      dailySelfGovernance: this.dailySelfGovernanceSummary(),
      generatedAt: nowIso(),
    };
  }
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
    blockedAt: row.blocked_at ?? null,
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
    reviewReport: parseJson<TaskReviewReport | null>(row.review_report_json, null),
    gitLocation: row.git_remote_url && row.git_branch && row.git_commit && row.git_verified_at ? {
      remoteUrl: row.git_remote_url as string,
      branch: row.git_branch as string,
      commit: row.git_commit as string,
      verifiedAt: row.git_verified_at as string,
    } : null,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

function requireSubmissionGitLocation(row: Row): VerifiedGitLocation {
  if (!row.git_remote_url || !row.git_branch || !row.git_commit || !row.git_verified_at) {
    throw new Error(`pending submission is missing verified Git location: ${row.submission_id ?? row.id ?? "unknown"}`);
  }
  return normalizeVerifiedGitLocation({
    remoteUrl: row.git_remote_url,
    branch: row.git_branch,
    commit: row.git_commit,
    verifiedAt: row.git_verified_at,
  });
}

function mapTaskCancelRequest(row: Row): TaskCancelRequest {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    requesterId: row.requester_id as string,
    reason: row.reason as string,
    status: row.status as TaskCancelRequest["status"],
    reviewerId: (row.reviewer_id ?? null) as string | null,
    feedback: (row.feedback ?? null) as string | null,
    createdAt: row.created_at as string,
    reviewedAt: (row.reviewed_at ?? null) as string | null,
  };
}

function mapTaskCancellationEvent(row: Row): TaskCancellationEvent {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    actorId: row.actor_id as string,
    requestId: (row.request_id ?? null) as string | null,
    statusBefore: row.status_before as TaskStatus,
    reason: row.reason as string,
    canceledAt: row.canceled_at as string,
    restoredBy: (row.restored_by ?? null) as string | null,
    restoredAt: (row.restored_at ?? null) as string | null,
  };
}

function mapTaskAgentDispatch(row: Row) {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    targetMemberId: row.target_agent_id as string,
    targetAgentId: (row.target_runtime_agent_id ?? row.target_agent_id) as string,
    kind: row.kind as TaskAgentDispatchKind,
    sourceEventId: (row.source_event_id ?? null) as string | null,
    prompt: row.prompt as string,
    status: row.status as "pending" | "running" | "succeeded" | "failed" | "canceled",
    attempts: Number(row.attempts),
    lastError: (row.last_error ?? null) as string | null,
    createdAt: row.created_at as string,
    startedAt: (row.started_at ?? null) as string | null,
    completedAt: (row.completed_at ?? null) as string | null,
  };
}

function mapTaskPromptTick(row: Row) {
  return {
    id: row.id as string,
    slotKey: row.slot_key as string,
    scheduledAt: row.scheduled_at as string,
    localDate: row.local_date as string,
    localHour: Number(row.local_hour),
    localMinute: Number(row.local_minute),
    createdAt: row.created_at as string,
  };
}

function mapTaskPromptPoolItem(row: Row): TaskPromptPoolItem {
  return {
    id: row.id,
    memberId: row.member_id,
    targetAgentId: row.target_runtime_agent_id ?? row.member_id,
    taskId: row.task_id,
    parentTaskId: row.parent_task_id ?? null,
    kind: row.kind,
    position: Number(row.queue_seq),
    enqueuedAt: row.enqueued_at,
    updatedAt: row.updated_at,
    lastPromptedAt: row.last_prompted_at ?? null,
    promptCount: Number(row.prompt_count),
  };
}

function mapTaskPromptDispatch(row: Row): TaskPromptDispatch {
  return {
    id: row.id,
    cycleId: `legacy:${row.tick_id}`,
    poolItemId: row.pool_item_id ?? null,
    targetMemberId: row.target_member_id,
    targetAgentId: row.target_runtime_agent_id ?? row.target_member_id,
    taskId: row.task_id ?? null,
    kind: row.kind ?? null,
    scheduledAt: row.scheduled_at,
    prompt: row.prompt ?? null,
    status: row.status,
    started: Boolean(row.started),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

function mapTaskPromptCycleDispatch(row: Row): TaskPromptDispatch {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    poolItemId: row.pool_item_id ?? null,
    targetMemberId: row.target_member_id,
    targetAgentId: row.target_runtime_agent_id ?? row.target_member_id,
    taskId: row.task_id ?? null,
    kind: row.kind ?? null,
    scheduledAt: row.scheduled_at,
    prompt: row.prompt ?? null,
    status: row.status,
    started: Boolean(row.started),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

function mapTaskCheckinDispatch(row: Row): TaskCheckinDispatch {
  return {
    id: row.id,
    runId: row.run_id,
    batchId: row.batch_id,
    targetMemberId: row.target_member_id,
    targetAgentId: row.target_runtime_agent_id ?? null,
    channel: row.channel,
    slotIndex: Number(row.slot_index),
    scheduledAt: row.scheduled_at,
    taskId: row.task_id ?? null,
    actionKind: row.action_kind ?? null,
    prompt: row.prompt ?? null,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

function taskDispatchAuditAction(kind: TaskAgentDispatchKind, phase: "queued" | "recovered" | "canceled" | "delivered" | "retry" | "failed") {
  if (kind === "boss_reminder") return `task.reminder_${phase}`;
  if (kind === "review_accepted" || kind === "review_rejected") return `task.review_notification_${phase}`;
  if (kind === "block_escalated" || kind === "block_guidance") return `task.block_notification_${phase}`;
  if (kind === "cancel_request_accepted" || kind === "cancel_request_rejected") return `task.cancel_notification_${phase}`;
  if (kind === "submission_git_required") return `task.submission_git_notification_${phase}`;
  return `task.correction_notification_${phase}`;
}

function submissionGitPromptLines(submission?: Row) {
  if (!submission?.git_remote_url || !submission.git_branch || !submission.git_commit || !submission.git_verified_at) {
    return ["Git 远端定位：缺失（不得批准；要求负责人按新格式重新提交）"];
  }
  return [
    "Git 远端定位（本次冻结验收对象）：",
    `- 远端：${submission.git_remote_url}`,
    `- 分支：${submission.git_branch}`,
    `- Commit：${submission.git_commit}`,
    `- 远端验证时间：${submission.git_verified_at}`,
  ];
}

function executionReviewBoundaryPromptLines() {
  return [
    "提交与验收边界（必须遵守）：",
    "- 负责人先完成并自测本人能够执行的交付，然后提交验收；派发者或 Boss 只在任务进入 review 后介入验收。",
    "- 验收标准中的“Boss 亲测、扫码、真机体验、人工确认”等验收人专属动作，不是 company_task_submit 的前置条件，也不构成任务阻塞。请准备好可运行环境、操作步骤和证据，在提交摘要中标明“待验收阶段检查”，然后提交。",
    "- 不要因为等待验收人操作而只记录 progress、停留在 in_progress 或调用 block；只有本人负责的交付确实无法继续推进时才报告阻塞。",
  ];
}

function reviewerInterventionPromptLine() {
  return "任务已经进入 review；验收标准中需要派发者或 Boss 亲测、扫码、真机体验、人工确认的项目，应由你在当前验收阶段执行，不能要求负责人在提交前等待你介入。";
}

function buildNoticeReminderPrompt(candidates: NoticeReminderCandidate[], scheduledAt: string, dispatchId: string) {
  const kindLabels = { manual: "管理公告", meeting_report: "会议汇报", correction: "更正公告" } as const;
  return [
    "【Company OS 公告半点提醒】",
    `提醒调度 ID：${dispatchId}（同一调度 ID 只处理一次）`,
    `检查时间：${scheduledAt}`,
    `你有 ${candidates.length} 条当前有效且未读的公司公告：`,
    ...candidates.map((candidate) => `- [${kindLabels[candidate.kind]}] ${candidate.title}（公告 ID：${candidate.noticeId}，发布于 ${candidate.createdAt}）`),
    "请调用 company_notice_list，并设置 effectiveOnly=true，阅读以上公告的完整正文和更正关系。",
    "确认理解后，逐条调用 company_notice_read 写入对应公告的 read mark。",
    "请实际完成公告工具操作，不要只回复已收到。",
  ].join("\n");
}

function buildTaskReminderPrompt(task: Row, dispatchId: string, submission?: Row) {
  if (task.status === "review") {
    return [
      "【Company OS 任务催办 · 催促审核人】",
      `通知 ID：${dispatchId}（同一通知 ID 只处理一次）`,
      `Boss 正在催促你验收子任务「${task.title}」（任务 ID：${task.id}）。`,
      `负责人：${task.assignee_id}`,
      ...submissionGitPromptLines(submission),
      reviewerInterventionPromptLine(),
      "请调用 company_task_read 读取当前 submission、验收标准、提交摘要和全部证据，逐项形成结构化 reviewReport。",
      "证据全部满足标准时调用 company_task_review 批准；任一检查不通过时，写明失败项和具体整改方案后驳回。",
      "请实际完成本项验收，不要未经检查直接通过，也不要只回复已收到。",
    ].join("\n");
  }
  if (task.status === "blocked") {
    return [
      "【Company OS 任务催办 · 催促阻塞审核人】",
      `通知 ID：${dispatchId}（同一通知 ID 只处理一次）`,
      `Boss 正在催促你审查被阻塞的子任务「${task.title}」（任务 ID：${task.id}）。`,
      `负责人：${task.assignee_id}`,
      `阻塞原因：${task.blocked_reason || "未填写"}`,
      "请先调用 company_task_read 核对最新任务、进度和阻塞原因，然后作出一个实际决定：",
      `- 需要上级协助：调用 company_task_block 阻塞父任务 ${task.parent_id}，如父任务已阻塞则更新其阻塞进展；`,
      `- 不需要上级协助：调用 company_task_unblock 解除子任务 ${task.id}，填写可执行的解决建议；`,
      "- 确实应终止：调用 company_task_cancel 创建 Boss 取消审批申请。",
      "请完成对应工具操作，不要直接取消任务，也不要只回复处理建议。",
    ].join("\n");
  }
  return [
    "【Company OS 任务催办】",
    `通知 ID：${dispatchId}（同一通知 ID 只处理一次）`,
    `Boss 正在跟进任务「${task.title}」（任务 ID：${task.id}）。`,
    "请先调用 company_task_read 读取任务的最新版本、验收标准、子任务状态和已有进度，再根据实际情况执行下一步：",
    "- 若仍在执行，调用 company_task_progress 记录最新进展和下一步计划；",
    "- 若出现阻塞，调用 company_task_block 如实报告；若任务已处于 blocked，使用 company_task_progress 更新阻塞进展，解除后调用 company_task_unblock；",
    ...executionReviewBoundaryPromptLines(),
    "- 若本人可执行交付已完成且直接子任务均已终结，先推送当前成果并读取远端分支 tip，再调用 company_task_submit 提交完整摘要、proof/artifact 和 gitLocation（remoteUrl、branch、40 位 tip commit）。",
    "请完成相应的任务工具操作，不要只回复进度说明。",
  ].join("\n");
}

function taskReminderTargetMemberId(task: Row) {
  if (task.status === "assigned" || task.status === "in_progress") return task.assignee_id as string;
  if ((task.status === "review" || task.status === "blocked") && task.issuer_id !== "boss") return task.issuer_id as string;
  return null;
}

function buildTaskCheckinPrompt(task: Row, actionKind: "review" | "execute", dispatchId: string, submission?: Row) {
  if (actionKind === "review") {
    return [
      "【Company OS 任务整点巡检 · 待验收】",
      `巡检调度 ID：${dispatchId}（同一调度 ID 只处理一次）`,
      "本次只处理下面这一项任务验收，不要扩展到其他任务。",
      `任务：${task.title}`,
      `任务 ID：${task.id}`,
      `负责人：${task.assignee_id}`,
      `提交时间：${task.submitted_at ?? task.last_activity_at}`,
      ...submissionGitPromptLines(submission),
      reviewerInterventionPromptLine(),
      "请调用 company_task_read 读取最新任务版本、验收标准、直接子任务、提交摘要和证据。",
      "核验后必须调用 company_task_review：满足标准则 accept；不满足则 reject，并写出具体拒绝原因和整改方向。",
      "请实际完成验收工具操作，不要只回复验收意见。",
    ].join("\n");
  }
  return [
    "【Company OS 任务整点巡检 · 执行提醒】",
    `巡检调度 ID：${dispatchId}（同一调度 ID 只处理一次）`,
    "本次只推进下面这一项任务，不要扩展到其他任务。",
    `任务：${task.title}`,
    `任务 ID：${task.id}`,
    `当前状态：${task.status}`,
    `最后活动：${task.last_activity_at}`,
    "请先调用 company_task_read 读取最新版本、验收标准、子任务状态和已有进度，再实际推进任务：",
    "- assigned：调用 company_task_start 开始任务并继续执行；",
    "- in_progress：完成当前可执行工作，并调用 company_task_progress 记录成果和下一步；",
    "- blocked：调用 company_task_progress 更新阻塞处理进展，解除后调用 company_task_unblock；",
    ...executionReviewBoundaryPromptLines(),
    "- 本人可执行交付已完成且直接子任务均已终结：先推送当前成果并读取远端分支 tip，再调用 company_task_submit 提交摘要、proof/artifact 和 gitLocation（remoteUrl、branch、40 位 tip commit）。",
    "若发现新的真实阻塞，请调用 company_task_block。请完成相应工具操作，不要只回复进度说明。",
  ].join("\n");
}

function buildTaskReviewNotificationPrompt(
  task: Row,
  reviewer: Row,
  kind: "review_accepted" | "review_rejected",
  feedback: string | null,
  dispatchId: string,
) {
  const reviewerLabel = reviewer.kind === "boss" ? "Boss" : `${reviewer.name}（${reviewer.title}）`;
  const header = [
    "【Company OS 任务验收通知】",
    `通知 ID：${dispatchId}（同一通知 ID 只处理一次）`,
    `任务「${task.title}」（任务 ID：${task.id}）已由 ${reviewerLabel} ${kind === "review_accepted" ? "验收通过" : "驳回验收"}。`,
  ];
  if (feedback) header.push(`验收意见：${feedback}`);
  if (kind === "review_accepted") {
    return [...header, "任务现已关闭。这是一条状态通知，无需再次提交或修改该任务。"].join("\n");
  }
  return [
    ...header,
    "任务已退回进行中。请立即按以下步骤继续处理：",
    "- 调用 company_task_read 读取最新任务、验收标准和本次反馈；",
    "- 根据驳回原因完成整改，并调用 company_task_progress 记录整改进展；",
    "- 完成本次反馈中属于负责人的整改后，先推送成果并读取远端分支 tip，再调用 company_task_submit 携带 gitLocation 重新提交验收；验收人专属复验留在新的 review 阶段执行，不要等待其提前介入。",
    "请完成相应的任务工具操作，不要只回复已收到。",
  ].join("\n");
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

function normalizeVerifiedGitLocation(input: VerifiedGitLocation) {
  const normalized = normalizeGitLocation(input);
  const verifiedAt = required(input?.verifiedAt, "gitLocation.verifiedAt");
  if (!Number.isFinite(Date.parse(verifiedAt))) throw new Error("gitLocation.verifiedAt must be an ISO timestamp");
  return { ...normalized, verifiedAt: new Date(verifiedAt).toISOString() };
}

function normalizeTaskReviewReport(
  report: TaskReviewReport | undefined,
  decision: "accept" | "reject",
  evidenceCount: number,
): TaskReviewReport {
  if (!report || !Array.isArray(report.checks) || report.checks.length === 0) {
    throw new Error("reviewReport with at least one check is required");
  }
  const checks = report.checks.map((check, index) => {
    const criterion = required(check?.criterion, `reviewReport.checks[${index}].criterion`);
    const finding = required(check?.finding, `reviewReport.checks[${index}].finding`);
    if (check.outcome !== "pass" && check.outcome !== "fail") {
      throw new Error(`reviewReport.checks[${index}].outcome is invalid`);
    }
    if (!Array.isArray(check.evidenceIndexes)) {
      throw new Error(`reviewReport.checks[${index}].evidenceIndexes is required`);
    }
    const evidenceIndexes = [...new Set(check.evidenceIndexes.map((value) => Number(value)))];
    if (evidenceIndexes.some((value) => !Number.isInteger(value) || value < 0 || value >= evidenceCount)) {
      throw new Error(`reviewReport.checks[${index}] contains an invalid evidence index`);
    }
    if (check.outcome === "pass" && evidenceIndexes.length === 0) {
      throw new Error(`reviewReport.checks[${index}] must cite evidence when passing`);
    }
    const remediation = check.remediation?.trim() || undefined;
    if (check.outcome === "fail" && !remediation) {
      throw new Error(`reviewReport.checks[${index}].remediation is required when failing`);
    }
    return { criterion, outcome: check.outcome, evidenceIndexes, finding, ...(remediation ? { remediation } : {}) };
  });
  if (decision === "accept" && checks.some((check) => check.outcome !== "pass")) {
    throw new Error("accepted reviews cannot contain failed checks");
  }
  if (decision === "reject" && !checks.some((check) => check.outcome === "fail")) {
    throw new Error("rejected reviews must contain at least one failed check");
  }
  return { checks, conclusion: required(report.conclusion, "reviewReport.conclusion") };
}

function taskReviewReportText(report: TaskReviewReport) {
  return [
    report.conclusion,
    ...report.checks.map((check, index) => [
      `${index + 1}. [${check.outcome === "pass" ? "通过" : "未通过"}] ${check.criterion}`,
      `核验：${check.finding}`,
      `证据索引：${check.evidenceIndexes.length ? check.evidenceIndexes.join(", ") : "无"}`,
      ...(check.remediation ? [`整改：${check.remediation}`] : []),
    ].join("；")),
  ].join("\n");
}

function isTaskStale(row: Row, now: number, thresholdMs: number) {
  if (row.status !== "assigned" && row.status !== "in_progress") return false;
  return now - Date.parse(row.last_activity_at) >= thresholdMs;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiSlot(value: number) {
  const shifted = new Date(value + SHANGHAI_OFFSET_MS);
  return {
    localDate: `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

function shanghaiLocalDateDaysAgo(now: number, days: number) {
  const local = new Date(now + SHANGHAI_OFFSET_MS);
  const shifted = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function addShanghaiWorkMinutes(now: number, minutes: number, startHour: number, endHour: number) {
  let local = now + SHANGHAI_OFFSET_MS;
  let remaining = Math.max(0, minutes) * 60_000;
  while (true) {
    const date = new Date(local);
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), startHour);
    const dayEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), endHour + 1);
    if (local < dayStart) local = dayStart;
    if (local >= dayEnd) {
      local = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, startHour);
      continue;
    }
    const available = dayEnd - local;
    if (remaining <= available) return new Date(local + remaining - SHANGHAI_OFFSET_MS).toISOString();
    remaining -= available;
    local = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, startHour);
  }
}

function remainingShanghaiWorkMinutes(now: number, due: number, startHour: number, endHour: number) {
  if (due <= now) return 0;
  let cursor = now;
  let total = 0;
  while (cursor < due) {
    const local = new Date(cursor + SHANGHAI_OFFSET_MS);
    const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), startHour) - SHANGHAI_OFFSET_MS;
    const end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), endHour + 1) - SHANGHAI_OFFSET_MS;
    const from = Math.max(cursor, start);
    const to = Math.min(due, end);
    if (to > from) total += to - from;
    cursor = Math.max(cursor + 1, end);
    if (cursor < due) {
      cursor = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, startHour) - SHANGHAI_OFFSET_MS;
    }
  }
  return Math.ceil(total / 60_000);
}

export function nextDailyAgentRunAt(now: number, hour: number, minute: number) {
  const local = new Date(now + SHANGHAI_OFFSET_MS);
  const baseYear = local.getUTCFullYear();
  const baseMonth = local.getUTCMonth();
  const baseDate = local.getUTCDate();
  for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
    const localCandidate = Date.UTC(baseYear, baseMonth, baseDate + dayOffset, hour, minute);
    const candidate = localCandidate - SHANGHAI_OFFSET_MS;
    if (candidate > now) return new Date(candidate).toISOString();
  }
  throw new Error("unable to calculate next daily agent run");
}

export function nextTaskCheckinRunAt(now: number, startHour: number, endHour: number) {
  const local = new Date(now + SHANGHAI_OFFSET_MS);
  const baseYear = local.getUTCFullYear();
  const baseMonth = local.getUTCMonth();
  const baseDate = local.getUTCDate();
  for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
    for (let hour = startHour; hour <= endHour; hour += 1) {
      const localCandidate = Date.UTC(baseYear, baseMonth, baseDate + dayOffset, hour);
      const candidate = localCandidate - SHANGHAI_OFFSET_MS;
      if (candidate > now) return new Date(candidate).toISOString();
    }
  }
  throw new Error("unable to calculate next task check-in run");
}

export function nextTaskPromptTickAt(now: number, startHour: number, endHour: number) {
  const local = new Date(now + SHANGHAI_OFFSET_MS);
  const baseYear = local.getUTCFullYear();
  const baseMonth = local.getUTCMonth();
  const baseDate = local.getUTCDate();
  for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
    for (let hour = startHour; hour <= endHour; hour += 1) {
      for (const minute of [0, 20, 40]) {
        const localCandidate = Date.UTC(baseYear, baseMonth, baseDate + dayOffset, hour, minute);
        const candidate = localCandidate - SHANGHAI_OFFSET_MS;
        if (candidate > now) return new Date(candidate).toISOString();
      }
    }
  }
  throw new Error("unable to calculate next task prompt tick");
}

export function nextNoticeReminderRunAt(now: number, startHour: number, endHour: number) {
  const local = new Date(now + SHANGHAI_OFFSET_MS);
  const baseYear = local.getUTCFullYear();
  const baseMonth = local.getUTCMonth();
  const baseDate = local.getUTCDate();
  for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
    for (let hour = startHour; hour <= endHour; hour += 1) {
      const localCandidate = Date.UTC(baseYear, baseMonth, baseDate + dayOffset, hour, 30);
      const candidate = localCandidate - SHANGHAI_OFFSET_MS;
      if (candidate > now) return new Date(candidate).toISOString();
    }
  }
  throw new Error("unable to calculate next notice reminder run");
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

function mapNoticeReminderCandidate(row: Row): NoticeReminderCandidate {
  return {
    noticeId: row.id,
    kind: row.kind,
    title: row.title,
    createdAt: row.created_at,
  };
}

function mapNoticeReminderDispatch(row: Row): NoticeReminderDispatch {
  return {
    id: row.id,
    runId: row.run_id,
    targetMemberId: row.target_member_id,
    targetAgentId: row.target_runtime_agent_id ?? row.target_member_id,
    scheduledAt: row.scheduled_at,
    candidates: parseJson(row.candidate_json, []),
    candidateCount: Number(row.candidate_count),
    prompt: row.prompt ?? null,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

function mapDailyAgentDispatch(row: Row): DailyAgentDispatch {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    targetMemberId: row.target_member_id,
    targetAgentId: row.target_runtime_agent_id ?? row.target_member_id,
    position: Number(row.position),
    scheduledAt: row.scheduled_at,
    sessionKey: row.session_key,
    prompt: row.prompt,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

function dailyAgentAuditPrefix(kind: DailyAgentKind) {
  return kind === "daily_self_improvement" ? "daily.self_improvement" : "daily.persona_audit";
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
    completionSource: row.completion_source ?? null,
    contextFromSequence: Number(row.context_from_sequence ?? 0),
    contextToSequence: Number(row.context_to_sequence ?? 0),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

function mapHostDispatch(row: Row) {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    kind: row.kind,
    targetMemberId: row.target_agent_id,
    targetAgentId: row.target_runtime_agent_id ?? row.target_agent_id,
    reason: row.reason,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error ?? null,
    waitForContextAppendId: row.wait_for_context_append_id ?? null,
    contextFromSequence: row.context_from_sequence === null || row.context_from_sequence === undefined
      ? null
      : Number(row.context_from_sequence),
    contextToSequence: row.context_to_sequence === null || row.context_to_sequence === undefined
      ? null
      : Number(row.context_to_sequence),
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

function mapMeetingSessionContextAppend(row: Row): MeetingSessionContextAppend {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    memberId: row.member_id,
    runtimeAgentId: row.runtime_agent_id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    messageId: row.message_id,
    messageSequence: Number(row.message_sequence),
    turnId: row.turn_id ?? null,
    roundNumber: row.round_number === null || row.round_number === undefined ? null : Number(row.round_number),
    recordKind: row.record_kind,
    targetId: row.target_id ?? null,
    targetName: row.target_name ?? null,
    memberName: row.member_name,
    body: row.body,
    formattedText: row.formatted_text,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    appendedAt: row.appended_at ?? null,
  };
}

function mapMeetingCloseoutDispatch(row: Row): MeetingCloseoutDispatch {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    memberId: row.member_id,
    memberName: row.member_name ?? row.member_id,
    runtimeAgentId: row.runtime_agent_id,
    outcome: row.outcome,
    blocksRoom: Boolean(row.blocks_room),
    position: Number(row.position),
    contextFromSequence: Number(row.context_from_sequence),
    contextToSequence: Number(row.context_to_sequence),
    prompt: row.prompt,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error ?? null,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

function closeoutRetryDelayMs(attempts: number) {
  return Math.min(5 * 60_000, 30_000 * (2 ** Math.max(0, Math.min(attempts - 1, 4))));
}

function formatSelfMeetingContextMessage(input: {
  sequence: number;
  roundNumber: number | null;
  recordKind: "speech" | "delegate" | "host_speech";
  memberName: string;
  targetName: string | null;
  body: string;
}) {
  const sequence = padMeetingSequence(input.sequence);
  if (input.recordKind === "host_speech") {
    return `【消息 #${sequence}｜主持人发言事件】\n你（${input.memberName}）：\n${input.body}`;
  }
  const round = required(String(input.roundNumber ?? ""), "meeting round number");
  const kind = input.recordKind === "delegate" ? "点名" : "发言";
  const target = input.recordKind === "delegate" && input.targetName ? ` @${input.targetName}` : "";
  return `【消息 #${sequence}｜第 ${round} 轮｜${kind}】\n你（${input.memberName}）${target}：\n${input.body}`;
}

function padMeetingSequence(sequence: number) {
  return Math.max(0, Math.floor(sequence)).toString().padStart(6, "0");
}

function formatMeetingContextMessage(row: Row, recipientId: string, fromSequence: number) {
  const author = row.author_kind === "system"
    ? "系统"
    : row.author_kind === "boss"
      ? "Boss"
      : row.author_id === recipientId
        ? `你（${row.author_name ?? row.author_id ?? "未知成员"}）`
        : `${row.author_name ?? row.author_id ?? "未知成员"}（${row.author_id ?? "unknown"}）`;
  const target = row.target_id ? ` @${row.target_name ?? row.target_id}` : "";
  let classification: string;
  if (row.turn_id && row.round_number) {
    const continued = Number(row.turn_first_sequence ?? row.sequence) <= fromSequence ? "（续）" : "";
    const kind = row.author_kind === "system"
      ? "轮次事件"
      : row.author_id === row.turn_requested_by && row.target_id === row.turn_speaker_id
        ? "点名"
        : row.author_id === row.turn_speaker_id
          ? "发言"
          : "轮次事件";
    classification = `第 ${Number(row.round_number)} 轮${continued}｜${kind}`;
  } else if (row.author_kind === "system") {
    classification = "系统穿插事件";
  } else if (row.author_kind === "boss") {
    classification = "Boss 穿插事件";
  } else {
    classification = "主持人发言事件";
  }
  return `【消息 #${padMeetingSequence(Number(row.sequence))}｜${classification}】\n${author}${target}：\n${row.body}`;
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
