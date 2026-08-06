import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CompanyOsService } from "../src/service.js";
import { resolveConfig } from "../src/types.js";

describe("unread notice reminder service", () => {
  it("schedules only the next future Beijing half-hour and delivers one aggregate per unread Agent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z")); // 08:00 in Shanghai
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-notice-timer-"));
    const invoke = vi.fn(async () => ({ ok: true as const, text: "handled" }));
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main", "cto", "eng-a"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      runtimeConfig: {},
      logger: logger(),
      agentInvoker: { invoke },
    });
    try {
      service.store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
      service.store.addMember("main", { agentId: "eng-a", name: "工程师", title: "工程师", managerId: "cto" });
      const first = service.store.publishNotice("main", { title: "半点汇总一", body: "第一条正文" });
      const second = service.store.publishNotice("main", { title: "半点汇总二", body: "第二条正文" });

      await service.start();
      expect(service.store.db.prepare("SELECT COUNT(*) AS count FROM notice_reminder_runs").get()).toMatchObject({ count: 0 });
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(service.store.db.prepare("SELECT scheduled_at FROM notice_reminder_runs").get())
        .toMatchObject({ scheduled_at: "2026-08-06T00:30:00.000Z" });
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke.mock.calls.map(([input]) => input.agentId).sort()).toEqual(["cto", "eng-a"]);
      for (const [input] of invoke.mock.calls) {
        expect(input.prompt).toContain(first.id);
        expect(input.prompt).toContain(second.id);
        expect(input.prompt).toContain("company_notice_list");
        expect(input.prompt).toContain("company_notice_read");
      }
      expect(service.store.db.prepare("SELECT status, COUNT(*) AS count FROM notice_reminder_dispatches GROUP BY status").all())
        .toEqual([{ status: "succeeded", count: 2 }]);
    } finally {
      await service.stop();
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts a notice read made during an Agent invocation even when the CLI throws", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-notice-progress-"));
    let service!: CompanyOsService;
    let noticeId = "";
    const invoke = vi.fn(async () => {
      service.store.readNotice("cto", noticeId);
      throw new Error("CLI connection closed after the tool call");
    });
    service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main", "cto"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      runtimeConfig: {},
      logger: logger(),
      agentInvoker: { invoke },
    });
    try {
      service.store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
      noticeId = service.store.publishNotice("main", { title: "异常后的阅读", body: "正文" }).id;
      const run = service.dispatchNoticeReminderRun(pastShanghaiHalfPast());

      await waitFor(() => expect(service.store.db.prepare("SELECT status, attempts FROM notice_reminder_dispatches WHERE run_id = ?").get(run.id))
        .toMatchObject({ status: "succeeded", attempts: 1 }));
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(service.store.listAudit("notice_reminder", run.id).map((event) => event.action))
        .toContain("notice.reminder_dispatch_delivered");
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("attempts each notice patrol dispatch only once even when Agent delivery fails", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-notice-single-injection-"));
    const invoke = vi.fn(async () => ({
      ok: false as const,
      code: "in_flight" as const,
      error: "agent session is already in flight",
      attempts: 1,
    }));
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main", "cto"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      runtimeConfig: {},
      logger: logger(),
      agentInvoker: { invoke },
    });
    try {
      service.store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
      service.store.publishNotice("main", { title: "重试提醒", body: "正文" });
      const run = service.dispatchNoticeReminderRun(pastShanghaiHalfPast());

      await waitFor(() => expect(service.store.db.prepare("SELECT status, attempts FROM notice_reminder_dispatches WHERE run_id = ?").get(run.id))
        .toMatchObject({ status: "failed", attempts: 1 }));
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ maxInFlightRetries: 0 }));
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function pastShanghaiHalfPast() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - 1,
    8,
    30,
  ) - 8 * 60 * 60 * 1000).toISOString();
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

async function waitFor(assertion: () => void, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
