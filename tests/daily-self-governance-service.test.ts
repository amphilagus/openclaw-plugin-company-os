import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CompanyOsService } from "../src/service.js";
import { resolveConfig } from "../src/types.js";

describe("daily self-governance service", () => {
  it("schedules the next future 05:00 Shanghai run without backfilling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T20:59:00.000Z")); // 04:59 in Shanghai
    const fixture = createService({ dailyPersonaAudit: { enabled: false } });
    try {
      await fixture.service.start();
      expect(fixture.service.store.db.prepare("SELECT COUNT(*) AS count FROM daily_agent_runs").get()).toMatchObject({ count: 0 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fixture.service.store.db.prepare("SELECT kind, scheduled_at FROM daily_agent_runs").get()).toMatchObject({
        kind: "daily_self_improvement",
        scheduled_at: "2026-08-05T21:00:00.000Z",
      });
      expect(fixture.invoke).toHaveBeenCalledWith(expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:self-audit",
        maxInFlightRetries: 0,
      }));
      expect(fixture.logger.info).toHaveBeenCalledWith(expect.stringContaining("scheduled daily self-improvement run"));
    } finally {
      await fixture.close();
      vi.useRealTimers();
    }
  });

  it("starts different agents at their minute offsets even while the prior agent is still running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T21:00:00.000Z"));
    const pending = new Map<string, (value: any) => void>();
    const invoke = vi.fn((input: { agentId: string }) => new Promise((resolve) => pending.set(input.agentId, resolve)));
    const fixture = createService({}, ["main", "alpha"], invoke);
    try {
      fixture.service.store.addMember("main", { agentId: "alpha", name: "Alpha", title: "L1", managerId: "boss" });
      fixture.service.dispatchDailySelfImprovementRun("2030-01-01T21:00:00.000Z");
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke.mock.calls.map(([input]) => input.agentId)).toEqual(["alpha"]);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(invoke.mock.calls.map(([input]) => input.agentId)).toEqual(["alpha", "main"]);
      pending.get("alpha")?.({ ok: true, text: "done", attempts: 1, raw: null });
      pending.get("main")?.({ ok: true, text: "done", attempts: 1, raw: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.service.store.db.prepare("SELECT status, COUNT(*) AS count FROM daily_agent_dispatches GROUP BY status").all())
        .toEqual([{ status: "succeeded", count: 2 }]);
    } finally {
      await fixture.close();
      vi.useRealTimers();
    }
  });

  it("serializes both mechanisms for one agent and reuses the self-audit session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T21:00:00.000Z"));
    const resolvers: Array<(value: any) => void> = [];
    const invoke = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
    const fixture = createService({
      dailySelfImprovement: { hour: 5, minute: 0 },
      dailyPersonaAudit: { hour: 5, minute: 0 },
    }, ["main"], invoke);
    try {
      fixture.service.dispatchDailySelfImprovementRun("2030-01-01T21:00:00.000Z");
      fixture.service.dispatchDailyPersonaAuditRun("2030-01-01T21:00:00.000Z");
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]?.[0]).toMatchObject({ sessionKey: "agent:main:self-audit" });

      resolvers[0]?.({ ok: true, text: "self done", attempts: 1, raw: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke.mock.calls[1]?.[0]).toMatchObject({ sessionKey: "agent:main:self-audit" });
      expect(invoke.mock.calls[0]?.[0].prompt).toContain("self-improving-agent");
      expect(invoke.mock.calls[1]?.[0].prompt).toContain("persona-audit");

      resolvers[1]?.({ ok: true, text: "persona done", attempts: 1, raw: null });
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      await fixture.close();
      vi.useRealTimers();
    }
  });
});

function createService(
  config: Parameters<typeof resolveConfig>[0] = {},
  allowedAgentIds = ["main"],
  invoke = vi.fn(async () => ({ ok: true as const, text: "done", attempts: 1, raw: null })),
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-daily-service-"));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const service = new CompanyOsService({
    databasePath: path.join(directory, "company-os.sqlite"),
    allowedAgentIds,
    config: resolveConfig({ bossEmailNotifications: { enabled: false }, ...config }),
    runtimeConfig: {},
    logger,
    agentInvoker: { invoke: invoke as any },
  });
  return {
    service,
    invoke,
    logger,
    async close() {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
