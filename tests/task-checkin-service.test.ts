import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CompanyOsService } from "../src/service.js";
import { resolveConfig } from "../src/types.js";
import { VERIFIED_GIT } from "./test-git.js";

const PROOF = [{ type: "proof" as const, label: "tests", command: "npm test" }];

describe("legacy task check-in delivery and personal prompt scheduler", () => {
  it("starts the level-one employee's ten-minute countdown without creating legacy global ticks or hourly runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T02:30:00.000Z")); // 10:30 in Shanghai
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-checkin-timer-"));
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      runtimeConfig: {},
      logger: logger(),
      agentInvoker: { invoke: vi.fn(async () => ({ ok: true as const, text: "handled" })) },
    });
    try {
      service.store.createRootTask({
        title: "个人倒计时", description: "十分钟后提醒", acceptanceCriteria: "完成一次投递", assigneeId: "main",
      });
      await service.start();
      expect(service.store.db.prepare("SELECT COUNT(*) AS count FROM task_checkin_runs").get()).toMatchObject({ count: 0 });
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(service.store.db.prepare("SELECT scheduled_at, interval_minutes FROM task_prompt_cycles").get())
        .toMatchObject({ scheduled_at: "2026-08-06T02:40:00.000Z", interval_minutes: 10 });
      expect(service.store.db.prepare("SELECT COUNT(*) AS count FROM task_prompt_ticks").get()).toMatchObject({ count: 0 });
      expect(service.store.db.prepare("SELECT COUNT(*) AS count FROM task_checkin_runs").get()).toMatchObject({ count: 0 });
    } finally {
      await service.stop();
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("injects one task into the employee main session and persists delivery", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-checkin-service-"));
    const invoke = vi.fn(async () => ({ ok: true as const, text: "handled" }));
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      runtimeConfig: {},
      logger: logger(),
      agentInvoker: { invoke },
    });
    try {
      const task = service.store.createRootTask({
        title: "分时推进",
        description: "每次只推进一个任务",
        acceptanceCriteria: "写入任务状态",
        assigneeId: "main",
      });
      const scheduledAt = pastShanghaiTen();
      const run = service.dispatchTaskCheckinRun(scheduledAt);
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

      expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
        agentId: "main",
        prompt: expect.stringContaining(`任务 ID：${task.id}`),
      }));
      await waitFor(() => expect(service.store.db.prepare("SELECT status FROM task_checkin_dispatches WHERE run_id = ? AND channel = 'agent'").get(run.id))
        .toMatchObject({ status: "succeeded" }));
      expect(run.dispatches.filter((dispatch) => dispatch.channel === "agent")).toHaveLength(1);
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not reinject a check-in after any Agent result", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-checkin-ambiguous-"));
    const invoke = vi.fn(async () => ({
      ok: false as const,
      code: "aborted" as const,
      error: "agent invocation aborted after launch",
      attempts: 1,
    }));
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      runtimeConfig: {},
      logger: logger(),
      agentInvoker: { invoke },
    });
    try {
      service.store.createRootTask({
        title: "巡检模糊失败",
        description: "不重复注入",
        acceptanceCriteria: "Agent 只调用一次",
        assigneeId: "main",
      });
      const run = service.dispatchTaskCheckinRun(pastShanghaiTen());

      await waitFor(() => expect(service.store.db.prepare("SELECT status, attempts FROM task_checkin_dispatches WHERE run_id = ? AND channel = 'agent'").get(run.id))
        .toMatchObject({ status: "failed", attempts: 1 }));
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ maxInFlightRetries: 0 }));
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sends one unlimited Boss digest through the existing SMTP sender", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-checkin-boss-service-"));
    const send = vi.fn(async () => undefined);
    const invoke = vi.fn(async () => ({ ok: true as const, text: "handled" }));
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main"],
      config: resolveConfig(undefined),
      runtimeConfig: {},
      logger: logger(),
      meetingEmailSender: { send },
      agentInvoker: { invoke },
    });
    try {
      const roots = Array.from({ length: 4 }, (_, index) => service.store.createRootTask({
        title: `待验收根任务 ${index + 1}`,
        description: "Boss 汇总",
        acceptanceCriteria: "完成",
        assigneeId: "main",
      }));
      for (const task of roots) {
        service.store.startTask("main", task.id);
        service.store.submitTask("main", task.id, "完成", PROOF, VERIFIED_GIT);
      }

      const scheduledAt = pastShanghaiTen();
      service.dispatchTaskCheckinRun(scheduledAt);
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

      expect(invoke).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        kind: "task_checkin",
        scheduledAt,
        reviews: expect.arrayContaining(roots.map((task) => expect.objectContaining({ taskId: task.id }))),
      }));
      expect((send.mock.calls[0]![0] as any).reviews).toHaveLength(4);
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps retrying the separate Boss SMTP digest without reinjecting an Agent patrol", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-checkin-boss-retry-"));
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("temporary SMTP failure"))
      .mockResolvedValueOnce(undefined);
    const invoke = vi.fn(async () => ({ ok: true as const, text: "handled" }));
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main"],
      config: resolveConfig(undefined),
      runtimeConfig: {},
      logger: logger(),
      meetingEmailSender: { send },
      agentInvoker: { invoke },
    });
    try {
      const task = service.store.createRootTask({
        title: "Boss 邮件重试",
        description: "SMTP 可重试",
        acceptanceCriteria: "完成",
        assigneeId: "main",
      });
      service.store.startTask("main", task.id);
      service.store.submitTask("main", task.id, "完成", PROOF, VERIFIED_GIT);
      const run = service.dispatchTaskCheckinRun(pastShanghaiTen());

      await waitFor(() => expect(service.store.db.prepare("SELECT status, attempts FROM task_checkin_dispatches WHERE run_id = ? AND channel = 'boss_email'").get(run.id))
        .toMatchObject({ status: "succeeded", attempts: 2 }));
      expect(send).toHaveBeenCalledTimes(2);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function pastShanghaiTen() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - 1,
    10,
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
