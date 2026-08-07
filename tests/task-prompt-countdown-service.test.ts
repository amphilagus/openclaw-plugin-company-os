import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CompanyOsService } from "../src/service.js";
import { resolveConfig } from "../src/types.js";

describe("personal task prompt countdown service", () => {
  afterEach(() => vi.useRealTimers());

  it("immediately dispatches the first item when an empty pool becomes nonempty and rotates it before the reply completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T02:00:00.000Z"));
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-personal-countdown-"));
    let active = false;
    let finish!: (value: { ok: true; text: string; raw: {}; attempts: number }) => void;
    const invoke = vi.fn(() => {
      active = true;
      return new Promise<{ ok: true; text: string; raw: {}; attempts: number }>((resolve) => { finish = resolve; });
    });
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      runtimeConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      agentInvoker: { invoke },
      isSessionActive: () => active,
    });
    let task!: ReturnType<typeof service.store.createRootTask>;
    try {
      await service.start();
      task = service.store.createRootTask({
        title: "空池首项立即投递", description: "不等待完整个人间隔", acceptanceCriteria: "池项已移动", assigneeId: "main",
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(service.store.db.prepare("SELECT started, status FROM task_prompt_cycle_dispatches WHERE task_id = ?").get(task.id))
        .toMatchObject({ started: 1, status: "running" });
      expect(service.store.db.prepare("SELECT prompt_count FROM task_prompt_pool_items WHERE task_id = ?").get(task.id))
        .toMatchObject({ prompt_count: 1 });
      expect(service.store.db.prepare("SELECT next_due_at FROM task_prompt_schedules WHERE member_id = 'main'").get())
        .toMatchObject({ next_due_at: "2026-08-07T02:10:00.000Z" });

      active = false;
      finish({ ok: true, text: "已处理", raw: {}, attempts: 1 });
      await vi.advanceTimersByTimeAsync(1);
      expect(service.store.db.prepare("SELECT status FROM task_prompt_cycle_dispatches WHERE task_id = ?").get(task.id))
        .toMatchObject({ status: "succeeded" });
    } finally {
      active = false;
      finish?.({ ok: true, text: "结束", raw: {}, attempts: 1 });
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the first item at the head and starts a full interval when its immediate delivery is skipped as busy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T02:00:00.000Z"));
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-personal-countdown-busy-"));
    const invoke = vi.fn(async () => ({ ok: true as const, text: "不应投递", raw: {}, attempts: 1 }));
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      runtimeConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      agentInvoker: { invoke },
      isSessionActive: () => true,
    });
    try {
      await service.start();
      const task = service.store.createRootTask({
        title: "忙碌时保留池首", description: "空池首项立即到期", acceptanceCriteria: "忙碌跳过后完整计时", assigneeId: "main",
      });
      await vi.advanceTimersByTimeAsync(1);

      expect(invoke).not.toHaveBeenCalled();
      expect(service.store.db.prepare("SELECT status FROM task_prompt_cycle_dispatches WHERE target_member_id = 'main'").get())
        .toMatchObject({ status: "skipped_busy" });
      expect(service.store.db.prepare("SELECT task_id, prompt_count FROM task_prompt_pool_items WHERE member_id = 'main'").get())
        .toMatchObject({ task_id: task.id, prompt_count: 0 });
      expect(service.store.db.prepare("SELECT next_due_at FROM task_prompt_schedules WHERE member_id = 'main'").get())
        .toMatchObject({ next_due_at: "2026-08-07T02:10:00.000Z" });
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
