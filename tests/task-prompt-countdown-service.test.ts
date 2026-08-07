import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CompanyOsService } from "../src/service.js";
import { resolveConfig } from "../src/types.js";

describe("personal task prompt countdown service", () => {
  afterEach(() => vi.useRealTimers());

  it("rotates the FIFO item as soon as the official registry confirms the Agent run, before the reply completes", async () => {
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
    const task = service.store.createRootTask({
      title: "确认启动即轮转", description: "不等待回复", acceptanceCriteria: "池项已移动", assigneeId: "main",
    });
    try {
      await service.start();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 200);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(service.store.db.prepare("SELECT started, status FROM task_prompt_cycle_dispatches WHERE task_id = ?").get(task.id))
        .toMatchObject({ started: 1, status: "running" });
      expect(service.store.db.prepare("SELECT prompt_count FROM task_prompt_pool_items WHERE task_id = ?").get(task.id))
        .toMatchObject({ prompt_count: 1 });

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
});
