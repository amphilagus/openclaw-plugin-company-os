import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { CompanyOsStore } from "../src/store.js";
import { resolveConfig } from "../src/types.js";

describe("database migrations", () => {
  it("upgrades a version 1 database through schema v13 with rolling task prompts and terminal correction state", () => {
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
      const dispatchColumns = store.db.prepare("PRAGMA table_info(meeting_agent_dispatches)").all() as Array<{ name: string }>;

      expect(version.value).toBe("13");
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
      expect(dispatchColumns.map((column) => column.name)).toContain("wait_for_context_append_id");
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
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("13");
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
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("13");
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
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("13");
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
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("13");
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
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("13");
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
    store.submitTask("main", historical.id, "历史提交", [{ type: "proof", label: "tests", command: "npm test" }]);
    store.db.exec(`
      DROP TABLE task_review_email_notifications;
      UPDATE schema_meta SET value = '10' WHERE key = 'schema_version';
    `);
    store.close();

    store = new CompanyOsStore({ databasePath, allowedAgentIds: ["main"], config: resolveConfig(undefined) });
    try {
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("13");
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
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("13");
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
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("13");
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
