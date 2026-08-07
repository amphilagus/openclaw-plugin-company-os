import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CompanyOsStore, nextDailyAgentRunAt } from "../src/store.js";
import { resolveConfig } from "../src/types.js";

describe("daily self-governance store", () => {
  it("resolves enabled Beijing defaults and bounded custom times", () => {
    expect(resolveConfig(undefined).dailySelfImprovement).toEqual({
      enabled: true,
      hour: 5,
      minute: 0,
      timeZone: "Asia/Shanghai",
    });
    expect(resolveConfig(undefined).dailyPersonaAudit).toEqual({
      enabled: true,
      hour: 6,
      minute: 0,
      timeZone: "Asia/Shanghai",
    });
    expect(resolveConfig({
      dailySelfImprovement: { enabled: false, hour: 22, minute: 45 },
      dailyPersonaAudit: { hour: 99, minute: -10 },
    })).toMatchObject({
      dailySelfImprovement: { enabled: false, hour: 22, minute: 45 },
      dailyPersonaAudit: { enabled: true, hour: 23, minute: 0 },
    });
  });

  it("calculates only the next future Beijing daily slot", () => {
    expect(nextDailyAgentRunAt(Date.parse("2030-01-01T20:59:00.000Z"), 5, 0))
      .toBe("2030-01-01T21:00:00.000Z");
    expect(nextDailyAgentRunAt(Date.parse("2030-01-01T21:00:00.000Z"), 5, 0))
      .toBe("2030-01-02T21:00:00.000Z");
  });

  it("snapshots active agents by level and agentId with one-minute offsets into the shared session", () => {
    const fixture = createStore(["main", "alpha", "zed", "beta"]);
    try {
      fixture.store.addMember("main", { agentId: "zed", name: "Zed", title: "L1", managerId: "boss" });
      fixture.store.addMember("main", { agentId: "alpha", name: "Alpha", title: "L1", managerId: "boss" });
      fixture.store.addMember("main", { agentId: "beta", name: "Beta", title: "L2", managerId: "alpha" });
      const scheduledAt = "2030-01-01T21:00:00.000Z";
      const run = fixture.store.queueDailyAgentRun("daily_self_improvement", scheduledAt);
      const duplicate = fixture.store.queueDailyAgentRun("daily_self_improvement", scheduledAt);
      const rows = fixture.store.db.prepare(`
        SELECT target_member_id, position, scheduled_at, session_key
        FROM daily_agent_dispatches WHERE run_id = ? ORDER BY position
      `).all(run.id) as Array<Record<string, unknown>>;

      expect(duplicate.id).toBe(run.id);
      expect(rows.map((row) => row.target_member_id)).toEqual(["alpha", "main", "zed", "beta"]);
      expect(rows.map((row) => row.scheduled_at)).toEqual([
        "2030-01-01T21:00:00.000Z",
        "2030-01-01T21:01:00.000Z",
        "2030-01-01T21:02:00.000Z",
        "2030-01-01T21:03:00.000Z",
      ]);
      expect(rows.map((row) => row.session_key)).toEqual([
        "agent:alpha:self-audit",
        "agent:main:self-audit",
        "agent:zed:self-audit",
        "agent:beta:self-audit",
      ]);
      const persona = fixture.store.queueDailyAgentRun("daily_persona_audit", "2030-01-01T22:00:00.000Z");
      expect(persona.id).not.toBe(run.id);
      expect(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM daily_agent_runs").get()).toMatchObject({ count: 2 });
    } finally {
      fixture.close();
    }
  });

  it("cancels inactive targets and seals attempted dispatches without replaying untouched work", () => {
    const fixture = createStore(["main", "alpha", "beta"]);
    try {
      fixture.store.addMember("main", { agentId: "alpha", name: "Alpha", title: "L1", managerId: "boss" });
      fixture.store.addMember("main", { agentId: "beta", name: "Beta", title: "L1", managerId: "boss" });
      const run = fixture.store.queueDailyAgentRun("daily_self_improvement", "2030-01-01T21:00:00.000Z");
      fixture.store.deactivateMember("main", "alpha", "离职");
      const claimed = fixture.store.claimNextDailyAgentDispatch(
        Date.parse("2030-01-02T00:00:00.000Z"),
        new Set(["main", "beta"]),
      );
      expect(claimed).toBeNull();
      expect(fixture.store.db.prepare("SELECT status FROM daily_agent_dispatches WHERE run_id = ? AND target_member_id = 'alpha'").get(run.id))
        .toMatchObject({ status: "canceled" });

      const running = fixture.store.claimNextDailyAgentDispatch(Date.parse("2030-01-02T00:00:00.000Z"));
      expect(running?.targetMemberId).toBe("beta");
      expect(fixture.store.recoverDailyAgentDispatches()).toBe(1);
      expect(fixture.store.db.prepare("SELECT status, attempts FROM daily_agent_dispatches WHERE id = ?").get(running!.id))
        .toMatchObject({ status: "failed", attempts: 1 });
      expect(fixture.store.db.prepare("SELECT status, attempts FROM daily_agent_dispatches WHERE run_id = ? AND target_member_id = 'main'").get(run.id))
        .toMatchObject({ status: "pending", attempts: 0 });
    } finally {
      fixture.close();
    }
  });

  it("returns today plus the latest seven Shanghai natural days without exposing prompts", () => {
    const fixture = createStore(["main"]);
    try {
      fixture.store.queueDailyAgentRun("daily_self_improvement", "2029-12-31T21:00:00.000Z"); // Jan 1 Shanghai
      fixture.store.queueDailyAgentRun("daily_self_improvement", "2030-01-01T21:00:00.000Z"); // Jan 2 Shanghai
      fixture.store.queueDailyAgentRun("daily_self_improvement", "2030-01-07T21:00:00.000Z"); // Jan 8 Shanghai
      const summary = fixture.store.dailySelfGovernanceSummary(Date.parse("2030-01-08T04:00:00.000Z"));

      expect(summary.history.map((run) => run.localDate)).toEqual(["2030-01-08", "2030-01-02"]);
      expect(summary.mechanisms.selfImprovement.today?.localDate).toBe("2030-01-08");
      expect(summary.history[0]?.dispatches[0]).not.toHaveProperty("prompt");
      expect(summary.sessionName).toBe("self-audit");
    } finally {
      fixture.close();
    }
  });
});

function createStore(allowedAgentIds: string[]) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-daily-governance-"));
  const store = new CompanyOsStore({
    databasePath: path.join(directory, "company-os.sqlite"),
    allowedAgentIds,
    config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
  });
  return {
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
