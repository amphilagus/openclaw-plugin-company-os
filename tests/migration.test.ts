import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { CompanyOsStore } from "../src/store.js";
import { resolveConfig } from "../src/types.js";
import { VERIFIED_GIT } from "./test-git.js";

describe("database migrations", () => {
  it("upgrades a version 1 database through schema v22 with root-task failure and dedicated meeting sessions", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1');
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        agent_id TEXT UNIQUE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        title TEXT NOT NULL,
        manager_id TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deactivated_at TEXT
      );
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE meetings (id TEXT PRIMARY KEY);
    `);
    database.close();

    const store = new CompanyOsStore({
      databasePath,
      allowedAgentIds: ["main"],
      config: resolveConfig(undefined),
    });
    try {
      const version = store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string };
      const meetingColumns = store.db.prepare("PRAGMA table_info(meetings)").all() as Array<{ name: string }>;
      const outbox = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meeting_email_notifications'").get();

      const contextWatermarks = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meeting_context_watermarks'").get();
      const dispatches = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meeting_agent_dispatches'").get();
      const contextAppends = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meeting_session_context_appends'").get();
      const taskDispatches = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_agent_dispatches'").get();
      const closeoutDispatches = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meeting_closeout_dispatches'").get();
      const checkinRuns = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_checkin_runs'").get();
      const checkinBatches = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_checkin_batches'").get();
      const checkinDispatches = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_checkin_dispatches'").get();
      const noticeReminderRuns = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notice_reminder_runs'").get();
      const noticeReminderDispatches = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notice_reminder_dispatches'").get();
      const taskReviewEmails = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_review_email_notifications'").get();
      const dailyRuns = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_agent_runs'").get();
      const dailyDispatches = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_agent_dispatches'").get();
      const taskFlows = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_flows'").get();
      const taskImageAttachments = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_image_attachments'").get();
      const submissionAttachmentColumns = store.db.prepare("PRAGMA table_info(task_submission_attachments)").all() as Array<{ name: string }>;
      const taskPromptSchedules = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_prompt_schedules'").get();
      const dispatchColumns = store.db.prepare("PRAGMA table_info(meeting_agent_dispatches)").all() as Array<{ name: string }>;
      const taskColumns = store.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const taskDispatchSql = store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_agent_dispatches'").get() as { sql: string };

      expect(version.value).toBe("22");
      expect(meetingColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "boss_participates",
        "boss_started_at",
        "end_requested_at",
        "end_requested_summary",
      ]));
      expect(outbox).toBeTruthy();
      expect(contextWatermarks).toBeTruthy();
      expect(dispatches).toBeTruthy();
      expect(contextAppends).toBeTruthy();
      expect(taskDispatches).toBeTruthy();
      expect(closeoutDispatches).toBeTruthy();
      expect(checkinRuns).toBeTruthy();
      expect(checkinBatches).toBeTruthy();
      expect(checkinDispatches).toBeTruthy();
      expect(noticeReminderRuns).toBeTruthy();
      expect(noticeReminderDispatches).toBeTruthy();
      expect(taskReviewEmails).toBeTruthy();
      expect(dailyRuns).toBeTruthy();
      expect(dailyDispatches).toBeTruthy();
      expect(taskFlows).toBeTruthy();
      expect(taskImageAttachments).toBeTruthy();
      expect(submissionAttachmentColumns.map((column) => column.name)).toContain("evidence_index");
      expect(taskPromptSchedules).toBeTruthy();
      expect(dispatchColumns.map((column) => column.name)).toContain("wait_for_context_append_id");
      expect(taskColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["failed_at", "failed_reason"]));
      expect(taskDispatchSql.sql).toContain("'review_failed'");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves v16 meeting dispatch values when v17 reorders the wait-context column", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v16-dispatch-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({
      databasePath,
      allowedAgentIds: ["main"],
      config: resolveConfig(undefined),
      defaultMeetingSessionMode: "legacy_main",
    });
    const meeting = store.requestMeeting("main", {
      type: "discussion",
      title: "v16 dispatch migration",
      agenda: "verify positional column changes do not corrupt data",
    }).meeting;
    store.db.exec(`
      DROP INDEX IF EXISTS idx_meeting_dispatch_pending;
      ALTER TABLE meeting_agent_dispatches RENAME TO meeting_agent_dispatches_v17_fixture;
      CREATE TABLE meeting_agent_dispatches (
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
        completed_at TEXT,
        wait_for_context_append_id TEXT REFERENCES meeting_session_context_appends(id)
      );
      DROP TABLE meeting_agent_dispatches_v17_fixture;
      CREATE INDEX idx_meeting_dispatch_pending ON meeting_agent_dispatches(status, created_at);
      UPDATE schema_meta SET value = '16' WHERE key = 'schema_version';
    `);
    store.db.prepare(`
      INSERT INTO meeting_agent_dispatches (
        id, meeting_id, kind, target_agent_id, reason, dedupe_key,
        context_from_sequence, context_to_sequence, status, attempts, last_error,
        lease_expires_at, created_at, started_at, completed_at, wait_for_context_append_id
      ) VALUES (?, ?, 'host_resume', 'main', 'resume after participant', 'v16-dispatch-dedupe',
        11, 23, 'succeeded', 2, NULL, NULL, '2026-08-07T14:00:00.000Z',
        '2026-08-07T14:00:01.000Z', '2026-08-07T14:00:02.000Z', NULL)
    `).run("dispatch-v16", meeting.id);
    store.close();

    store = new CompanyOsStore({
      databasePath,
      allowedAgentIds: ["main"],
      config: resolveConfig(undefined),
      defaultMeetingSessionMode: "legacy_main",
    });
    try {
      const columns = store.db.prepare("PRAGMA table_info(meeting_agent_dispatches)").all() as Array<{ name: string }>;
      const dispatch = store.db.prepare(`
        SELECT id, meeting_id, kind, target_agent_id, reason, dedupe_key,
          context_from_sequence, context_to_sequence, status, attempts, last_error,
          lease_expires_at, wait_for_context_append_id, created_at, started_at, completed_at
        FROM meeting_agent_dispatches WHERE id = 'dispatch-v16'
      `).get();

      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      expect(columns.map((column) => column.name)).toEqual([
        "id", "meeting_id", "kind", "target_agent_id", "reason", "dedupe_key",
        "context_from_sequence", "context_to_sequence", "status", "attempts", "last_error",
        "lease_expires_at", "wait_for_context_append_id", "created_at", "started_at", "completed_at",
      ]);
      expect(dispatch).toMatchObject({
        id: "dispatch-v16",
        meeting_id: meeting.id,
        kind: "host_resume",
        target_agent_id: "main",
        reason: "resume after participant",
        dedupe_key: "v16-dispatch-dedupe",
        context_from_sequence: 11,
        context_to_sequence: 23,
        status: "succeeded",
        attempts: 2,
        last_error: null,
        lease_expires_at: null,
        wait_for_context_append_id: null,
        created_at: "2026-08-07T14:00:00.000Z",
        started_at: "2026-08-07T14:00:01.000Z",
        completed_at: "2026-08-07T14:00:02.000Z",
      });
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM meeting_agent_dispatches").get()).toMatchObject({ count: 1 });
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("adds v3 turn delivery columns to a version 2 database", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v2-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '2');
      CREATE TABLE members (
        id TEXT PRIMARY KEY, agent_id TEXT UNIQUE, kind TEXT NOT NULL, name TEXT NOT NULL,
        title TEXT NOT NULL, manager_id TEXT, active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deactivated_at TEXT
      );
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE meetings (id TEXT PRIMARY KEY);
      CREATE TABLE meeting_turns (
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker_id TEXT NOT NULL,
        requested_by TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL,
        intervention_id TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL,
        completed_at TEXT, error TEXT
      );
    `);
    database.close();

    const store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    try {
      const columns = store.db.prepare("PRAGMA table_info(meeting_turns)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "completion_source",
        "context_from_sequence",
        "context_to_sequence",
      ]));
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies v7 closeout state to v6 without backfilling historical terminal meetings", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v6-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    const meeting = store.requestMeeting("main", {
      type: "discussion",
      title: "v6 历史终态会议",
      agenda: "验证迁移不回溯通知",
    }).meeting;
    const ending = store.endMeeting("main", meeting.id, "历史总结", false);
    store.finalizeDueAutomaticMeetingEnd(Date.parse(ending.meeting.autoEndAt));
    store.db.exec(`
      DROP TABLE meeting_closeout_dispatches;
      UPDATE schema_meta SET value = '6' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      expect(store.meetingView(meeting.id).status).toBe("completed");
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM meeting_closeout_dispatches").get()).toMatchObject({ count: 0 });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves v7 Boss reminders while expanding task dispatch kinds in v8", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v8-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '7');
      CREATE TABLE members (
        id TEXT PRIMARY KEY, agent_id TEXT UNIQUE, kind TEXT NOT NULL,
        name TEXT NOT NULL, title TEXT NOT NULL, manager_id TEXT,
        active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, deactivated_at TEXT
      );
      INSERT INTO members VALUES
        ('boss', NULL, 'boss', 'Boss', 'CEO', NULL, 1, '2026-08-01', '2026-08-01', NULL),
        ('main', 'main', 'agent', '架构师', '首席架构师', 'boss', 1, '2026-08-01', '2026-08-01', NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      INSERT INTO tasks (id) VALUES ('task-1');
      CREATE TABLE task_agent_dispatches (
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
      CREATE INDEX idx_task_dispatch_pending ON task_agent_dispatches(status, created_at);
      INSERT INTO task_agent_dispatches (
        id, task_id, target_agent_id, kind, prompt, status, attempts, created_at
      ) VALUES ('dispatch-old', 'task-1', 'main', 'boss_reminder', 'legacy reminder', 'succeeded', 1, '2026-08-01');
    `);
    database.close();

    const store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      expect(store.db.prepare("SELECT kind, prompt, status FROM task_agent_dispatches WHERE id = 'dispatch-old'").get())
        .toMatchObject({ kind: "boss_reminder", prompt: "legacy reminder", status: "succeeded" });
      expect(() => store.db.prepare(`
        INSERT INTO task_agent_dispatches (id, task_id, target_agent_id, kind, prompt, status, created_at)
        VALUES ('dispatch-new', 'task-1', 'main', 'review_accepted', 'review result', 'pending', '2026-08-02')
      `).run()).not.toThrow();
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades v8 through v12 without changing existing task dispatch history", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v9-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    const task = store.createRootTask({
      title: "v8 历史催办",
      description: "迁移时保留",
      acceptanceCriteria: "记录不丢失",
      assigneeId: "main",
    });
    const reminder = store.queueTaskReminderByBoss(task.id);
    store.db.exec(`
      DROP TABLE task_checkin_dispatches;
      DROP TABLE task_checkin_batches;
      DROP TABLE task_checkin_runs;
      UPDATE schema_meta SET value = '8' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      expect(store.db.prepare("SELECT id, kind, status FROM task_agent_dispatches WHERE id = ?").get(reminder.id))
        .toMatchObject({ id: reminder.id, kind: "boss_reminder", status: "pending" });
      expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_checkin_runs'").get()).toBeTruthy();
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades v9 through v12 without creating reminder runs or changing notice read history", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v10-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({
      databasePath,
      allowedAgentIds: ["main", "cto"],
      config: resolveConfig(undefined),
    });
    store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
    const readNotice = store.publishNotice("main", { title: "已读历史公告", body: "保留 read mark" });
    const unreadNotice = store.publishNotice("main", { title: "未读历史公告", body: "首个正常半点再扫描" });
    store.readNotice("cto", readNotice.id);
    store.db.exec(`
      DROP TABLE notice_reminder_dispatches;
      DROP TABLE notice_reminder_runs;
      UPDATE schema_meta SET value = '9' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({
      databasePath,
      allowedAgentIds: ["main", "cto"],
      config: resolveConfig(undefined),
    });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      expect(store.listNotices("cto").find((notice) => notice.id === readNotice.id)?.readAt).toBeTruthy();
      expect(store.listNotices("cto").find((notice) => notice.id === unreadNotice.id)?.readAt).toBeNull();
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM notice_reminder_runs").get()).toMatchObject({ count: 0 });
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM notice_reminder_dispatches").get()).toMatchObject({ count: 0 });
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades v10 through v12 by adding the root-task review email outbox without backfilling history", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v11-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({
      databasePath,
      allowedAgentIds: ["main"],
      config: resolveConfig(undefined),
    });
    const historical = store.createRootTask({
      title: "历史根任务",
      description: "v10 时已经存在",
      acceptanceCriteria: "迁移不补发邮件",
      assigneeId: "main",
    });
    store.startTask("main", historical.id);
    store.submitTask("main", historical.id, "历史提交", [{ type: "proof", label: "tests", command: "npm test" }], VERIFIED_GIT);
    store.db.exec(`
      DROP TABLE task_review_email_notifications;
      UPDATE schema_meta SET value = '10' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM task_review_email_notifications").get()).toMatchObject({ count: 0 });
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades v11 to v12 without creating historical daily governance runs", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v12-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    store.db.exec(`
      DROP TABLE daily_agent_dispatches;
      DROP TABLE daily_agent_runs;
      UPDATE schema_meta SET value = '11' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM daily_agent_runs").get()).toMatchObject({ count: 0 });
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM daily_agent_dispatches").get()).toMatchObject({ count: 0 });
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades v12 to v13, preserves legacy check-in history, and seeds FIFO order from real task activity", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v13-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    const newer = store.createRootTask({ title: "较新任务", description: "new", acceptanceCriteria: "done", assigneeId: "main" });
    const older = store.createRootTask({ title: "较早任务", description: "old", acceptanceCriteria: "done", assigneeId: "main" });
    store.db.prepare("UPDATE tasks SET last_activity_at = '2026-08-02T00:00:00.000Z' WHERE id = ?").run(newer.id);
    store.db.prepare("UPDATE tasks SET last_activity_at = '2026-08-01T00:00:00.000Z' WHERE id = ?").run(older.id);
    const historicalRun = store.queueTaskCheckinRun("2030-01-01T02:00:00.000Z");
    store.db.exec(`
      DROP TABLE task_prompt_dispatches;
      DROP TABLE task_prompt_ticks;
      DROP TABLE task_prompt_pool_items;
      DROP TABLE boss_task_action_email_notifications;
      DROP TABLE task_correction_impacts;
      DROP TABLE task_corrections;
      DROP TABLE task_cancellation_events;
      DROP TABLE task_cancel_requests;
      DROP TABLE task_review_inspections;
      UPDATE schema_meta SET value = '12' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      expect(store.db.prepare("SELECT id FROM task_checkin_runs WHERE id = ?").get(historicalRun.id)).toBeTruthy();
      expect((store.db.prepare(`
        SELECT task_id FROM task_prompt_pool_items WHERE member_id = 'main' ORDER BY queue_seq
      `).all() as Array<{ task_id: string }>).map((row) => row.task_id)).toEqual([older.id, newer.id]);
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades v13 to v14 by invalidating Git-less pending submissions and preserving terminal history", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v14-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    const pendingTask = store.createRootTask({ title: "旧待验收任务", description: "pending", acceptanceCriteria: "done", assigneeId: "main" });
    store.startTask("main", pendingTask.id);
    store.submitTask("main", pendingTask.id, "旧格式待验收", [{ type: "proof", label: "tests", command: "npm test" }], VERIFIED_GIT);
    const acceptedTask = store.createRootTask({ title: "旧已验收任务", description: "accepted", acceptanceCriteria: "done", assigneeId: "main" });
    store.startTask("main", acceptedTask.id);
    store.submitTask("main", acceptedTask.id, "旧格式已通过", [{ type: "proof", label: "tests", command: "npm test" }], VERIFIED_GIT);
    store.reviewTask("boss", acceptedTask.id, "accept");
    store.db.exec(`
      ALTER TABLE task_submissions DROP COLUMN git_remote_url;
      ALTER TABLE task_submissions DROP COLUMN git_branch;
      ALTER TABLE task_submissions DROP COLUMN git_commit;
      ALTER TABLE task_submissions DROP COLUMN git_verified_at;
      UPDATE schema_meta SET value = '13' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      const pending = store.readTask("boss", pendingTask.id, false);
      expect(pending.status).toBe("in_progress");
      expect(pending.submissions[0]).toMatchObject({ status: "invalidated", gitLocation: null });
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM task_review_email_notifications WHERE task_id = ?").get(pendingTask.id))
        .toMatchObject({ count: 0 });
      expect(store.db.prepare(`
        SELECT kind, status FROM task_agent_dispatches WHERE task_id = ? AND kind = 'submission_git_required'
      `).get(pendingTask.id)).toMatchObject({ kind: "submission_git_required", status: "pending" });
      expect(store.taskPromptPoolSummary().queues.find((queue) => queue.memberId === "main")?.items)
        .toEqual(expect.arrayContaining([expect.objectContaining({ taskId: pendingTask.id, kind: "execution" })]));

      const accepted = store.readTask("boss", acceptedTask.id, false);
      expect(accepted.status).toBe("closed");
      expect(accepted.submissions[0]).toMatchObject({ status: "accepted", gitLocation: null });
      expect(store.listAudit("task", pendingTask.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "task.submission_invalidated_git_required" }),
      ]));
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades v14 through v16 by creating an implicit historical stage, exempting legacy canceled children, and starting personal schedules", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v15-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main", "cto"], config: resolveConfig(undefined) });
    store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "main" });
    const root = store.createRootTask({ title: "历史根任务", description: "root", acceptanceCriteria: "done", assigneeId: "main" });
    const active = store.createChildTask("main", { parentId: root.id, title: "历史活动子任务", description: "active", acceptanceCriteria: "done", assigneeId: "cto" });
    const canceled = store.createChildTask("main", { parentId: root.id, title: "历史取消子任务", description: "canceled", acceptanceCriteria: "done", assigneeId: "cto" });
    store.cancelTask("main", canceled.id, "v14 已取消范围");
    store.db.exec(`
      DROP TABLE task_prompt_cycle_dispatches;
      DROP TABLE task_prompt_cycles;
      DROP TABLE task_prompt_schedules;
      DROP TABLE task_meeting_requirements;
      DROP TABLE task_flow_stage_tasks;
      DROP TABLE task_flow_stages;
      DROP TABLE task_flows;
      DROP TABLE meeting_task_drafts;
      DROP TABLE meeting_task_draft_stages;
      CREATE TABLE meeting_task_drafts (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        assignee_id TEXT NOT NULL
      );
      UPDATE schema_meta SET value = '14' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main", "cto"], config: resolveConfig(undefined) });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      const detail = store.readTask("boss", root.id, false);
      expect(detail.childFlow?.stages).toEqual([
        expect.objectContaining({ name: "历史阶段", status: "active", requiredTaskCount: 1, taskIds: [active.id, canceled.id] }),
      ]);
      expect(store.db.prepare(`
        SELECT completion_required FROM task_flow_stage_tasks WHERE task_id = ?
      `).get(canceled.id)).toMatchObject({ completion_required: 0 });
      expect(store.db.prepare("SELECT next_due_at FROM task_prompt_schedules WHERE member_id = 'cto'").get())
        .toMatchObject({ next_due_at: expect.any(String) });
      expect((store.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name))
        .toEqual(expect.arrayContaining(["aborted_at", "aborted_reason"]));
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates v17 task-meeting requirements as Boss-participating for backward compatibility", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v18-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({
      databasePath,
      allowedAgentIds: ["main", "cto", "eng-a"],
      config: resolveConfig(undefined),
    });
    store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
    store.addMember("main", { agentId: "eng-a", name: "工程师 A", title: "工程师", managerId: "cto" });
    const root = store.createRootTask({
      title: "v17 要求任务会",
      description: "迁移前隐式要求 Boss",
      acceptanceCriteria: "完成任务会",
      assigneeId: "cto",
      requireTaskMeeting: true,
      taskMeetingBossParticipates: true,
    });
    store.db.exec(`
      ALTER TABLE task_meeting_requirements DROP COLUMN boss_participates;
      UPDATE schema_meta SET value = '17' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({
      databasePath,
      allowedAgentIds: ["main", "cto", "eng-a"],
      config: resolveConfig(undefined),
    });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      expect(store.readTask("boss", root.id, false).taskMeetingRequirement).toMatchObject({
        status: "required",
        bossParticipates: true,
      });
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades v18 to v19 by adding root-task image attachment storage without fabricating records", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v19-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    store.db.exec(`
      DROP TABLE task_image_attachments;
      UPDATE schema_meta SET value = '18' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM task_image_attachments").get()).toMatchObject({ count: 0 });
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades v19 through v22 without fabricating review handoffs for historical submissions", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v20-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    const task = store.createRootTask({
      title: "历史根任务",
      description: "v19 submission",
      acceptanceCriteria: "保留原记录",
      assigneeId: "main",
    });
    store.startTask("main", task.id);
    store.submitTask("main", task.id, "历史提交", [{ type: "proof", label: "tests", command: "npm test" }], VERIFIED_GIT);
    store.db.exec(`
      DROP TABLE task_submission_material_deliveries;
      DROP TABLE task_submission_attachments;
      ALTER TABLE task_submissions DROP COLUMN verification_working_directory;
      ALTER TABLE task_submissions DROP COLUMN verification_command;
      ALTER TABLE task_submissions DROP COLUMN verification_one_line_command;
      UPDATE schema_meta SET value = '19' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      expect(store.readTask("boss", task.id, false).submissions[0]).toMatchObject({ summary: "历史提交", reviewHandoff: null });
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM task_submission_attachments").get()).toMatchObject({ count: 0 });
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM task_submission_material_deliveries").get()).toMatchObject({ count: 0 });
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades v20 through v22 by linking legacy attachments and returning unfrozen artifact submissions", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v21-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });

    const missingTask = store.createRootTask({
      title: "缺少附件的待验收任务",
      description: "旧版只记录 artifact.path",
      acceptanceCriteria: "必须收到真实附件",
      assigneeId: "main",
    });
    store.startTask("main", missingTask.id);
    store.submitTask("main", missingTask.id, "旧版提交", [{ type: "proof", label: "占位", note: "待迁移" }], VERIFIED_GIT);
    const missingSubmissionId = store.readTask("boss", missingTask.id, false).submissions[0]!.id;
    store.db.prepare("UPDATE task_submissions SET evidence_json = ? WHERE id = ?").run(
      JSON.stringify([{ type: "artifact", label: "报告", path: "projects/demo/report.md" }]),
      missingSubmissionId,
    );

    const preservedTask = store.createRootTask({
      title: "已有冻结附件的待验收任务",
      description: "旧版附件应保留",
      acceptanceCriteria: "迁移后仍可验收",
      assigneeId: "main",
    });
    store.startTask("main", preservedTask.id);
    store.submitTask("main", preservedTask.id, "已有附件", [{ type: "proof", label: "占位", note: "待迁移" }], VERIFIED_GIT);
    const preservedSubmissionId = store.readTask("boss", preservedTask.id, false).submissions[0]!.id;
    store.db.prepare("UPDATE task_submissions SET evidence_json = ? WHERE id = ?").run(
      JSON.stringify([{ type: "artifact", label: "报告", path: "projects/demo/report.md" }]),
      preservedSubmissionId,
    );
    store.db.prepare(`
      INSERT INTO task_submission_attachments (
        id, submission_id, position, evidence_index, file_name, source_path, byte_size, sha256, file_data, created_at
      ) VALUES ('legacy-attachment', ?, 0, NULL, 'report.md', 'projects/demo/report.md', 6, ?, ?, ?)
    `).run(preservedSubmissionId, "a".repeat(64), Buffer.from("report"), new Date().toISOString());

    store.db.exec(`
      ALTER TABLE task_submission_attachments DROP COLUMN evidence_index;
      UPDATE schema_meta SET value = '20' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("22");
      expect(store.readTask("boss", missingTask.id, false)).toMatchObject({
        status: "in_progress",
        submissions: [expect.objectContaining({ id: missingSubmissionId, status: "invalidated" })],
      });
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM task_review_email_notifications WHERE submission_id = ?")
        .get(missingSubmissionId)).toMatchObject({ count: 0 });
      expect(store.db.prepare("SELECT kind, source_event_id FROM task_agent_dispatches WHERE task_id = ?")
        .get(missingTask.id)).toMatchObject({ kind: "submission_materials_required", source_event_id: missingSubmissionId });
      expect(store.readTask("boss", preservedTask.id, false).status).toBe("review");
      expect(store.db.prepare("SELECT evidence_index FROM task_submission_attachments WHERE id = 'legacy-attachment'").get())
        .toMatchObject({ evidence_index: 0 });
      expect(store.listAudit("task", missingTask.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "task.submission_invalidated_materials_required" }),
      ]));
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("normalizes a legacy member alias to the real OpenClaw Agent ID across current records", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-migration-v4-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    let store = new CompanyOsStore({
      databasePath,
      allowedAgentIds: ["main", "jia-goushi"],
      organizationAdminAgentId: "main",
      config: resolveConfig(undefined),
    });
    const meeting = store.requestMeeting("main", { type: "discussion", title: "旧 ID 会议", agenda: "迁移" }).meeting;
    store.speakMeeting("main", meeting.id, "旧 ID 发言");
    store.publishNotice("main", { title: "旧 ID 公告", body: "迁移" });
    store.db.prepare("UPDATE members SET agent_id = 'jia-goushi' WHERE id = 'main'").run();
    store.db.prepare("UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'").run();
    store.close();

    store = new CompanyOsStore({
      databasePath,
      allowedAgentIds: ["jia-goushi"],
      organizationAdminAgentId: "jia-goushi",
      config: resolveConfig(undefined),
    });
    try {
      expect(store.listMembers().map((member) => member.id)).toEqual(["boss", "jia-goushi"]);
      expect(store.meetingView(meeting.id).hostId).toBe("jia-goushi");
      expect(store.meetingView(meeting.id).messages.at(-1)?.authorId).toBe("jia-goushi");
      expect(store.listNotices("boss")[0]?.authorId).toBe("jia-goushi");
      expect(store.listAudit("member", "jia-goushi")).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "org.member_id_normalized" }),
      ]));
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
