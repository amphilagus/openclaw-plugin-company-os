import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { CompanyOsStore } from "../src/store.js";
import { resolveConfig } from "../src/types.js";

describe("database migrations", () => {
  it("upgrades a version 1 database through schema v5 with meeting dispatch and session context state", () => {
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
      const dispatchColumns = store.db.prepare("PRAGMA table_info(meeting_agent_dispatches)").all() as Array<{ name: string }>;

      expect(version.value).toBe("5");
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
      expect((store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("5");
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
