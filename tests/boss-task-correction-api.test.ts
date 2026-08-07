import { describe, expect, it, vi } from "vitest";

import { executeBossApi } from "../src/boss-api.js";

describe("Boss task correction API", () => {
  it("routes terminal correction and cancellation request decisions through the service", async () => {
    const service = {
      store: {},
      correctTaskTerminalDecision: vi.fn(() => ({ id: "task-1", status: "in_progress" })),
      reviewTaskCancellationRequest: vi.fn(() => ({ task: { id: "task-1", status: "canceled" } })),
    } as any;

    const corrected = await executeBossApi(service, {
      method: "POST",
      path: "/tasks/task-1/correct",
      body: { action: "revoke_acceptance", reason: "二次审查发现问题" },
    });
    expect(corrected.status).toBe(200);
    expect(service.correctTaskTerminalDecision).toHaveBeenCalledWith(
      "boss", "task-1", "revoke_acceptance", "二次审查发现问题", undefined,
    );

    const canceled = await executeBossApi(service, {
      method: "POST",
      path: "/tasks/task-1/cancel-requests/request-1/review",
      body: { decision: "accept", feedback: "批准" },
    });
    expect(canceled.status).toBe(200);
    expect(service.reviewTaskCancellationRequest).toHaveBeenCalledWith("task-1", "request-1", "accept", "批准");
  });

  it("routes per-agent countdown overrides and restoration through the service", async () => {
    const setTaskPromptInterval = vi.fn((_memberId: string, intervalMinutes: number | null) => ({ intervalMinutes }));
    const service = { store: {}, setTaskPromptInterval } as any;

    const overridden = await executeBossApi(service, {
      method: "PUT",
      path: "/task-prompt-settings/cto",
      body: { intervalMinutes: 15 },
    });
    const restored = await executeBossApi(service, {
      method: "PUT",
      path: "/task-prompt-settings/cto",
      body: { intervalMinutes: null },
    });

    expect(overridden).toEqual({ status: 200, data: { intervalMinutes: 15 } });
    expect(restored).toEqual({ status: 200, data: { intervalMinutes: null } });
    expect(setTaskPromptInterval).toHaveBeenNthCalledWith(1, "cto", 15);
    expect(setTaskPromptInterval).toHaveBeenNthCalledWith(2, "cto", null);
  });

  it("routes global task-prompt work hours and config restoration through the service", async () => {
    const setTaskPromptWorkHours = vi.fn((startHour: number | null, endHour: number | null) => ({ startHour, endHour }));
    const service = { store: {}, setTaskPromptWorkHours } as any;

    const updated = await executeBossApi(service, {
      method: "PUT",
      path: "/task-prompt-settings",
      body: { startHour: 9, endHour: 17 },
    });
    const restored = await executeBossApi(service, {
      method: "PUT",
      path: "/task-prompt-settings",
      body: { startHour: null, endHour: null },
    });

    expect(updated).toEqual({ status: 200, data: { startHour: 9, endHour: 17 } });
    expect(restored).toEqual({ status: 200, data: { startHour: null, endHour: null } });
    expect(setTaskPromptWorkHours).toHaveBeenNthCalledWith(1, 9, 17);
    expect(setTaskPromptWorkHours).toHaveBeenNthCalledWith(2, null, null);
  });

  it("routes irreversible task-tree aborts through the Boss task panel", async () => {
    const service = {
      store: {},
      abortTaskByBoss: vi.fn(async () => ({
        task: { id: "task-1", status: "aborted" },
        affectedTaskIds: ["task-1", "task-2"],
      })),
    } as any;

    const aborted = await executeBossApi(service, {
      method: "POST",
      path: "/tasks/task-1/abort",
      body: { reason: "错误拆解，整棵任务树废止" },
    });

    expect(aborted.status).toBe(200);
    expect(service.abortTaskByBoss).toHaveBeenCalledWith("task-1", "错误拆解，整棵任务树废止");
    await expect(executeBossApi(service, {
      method: "POST",
      path: "/tasks/task-1/reassign",
      body: { assigneeId: "eng-b", reason: "旧入口已废除" },
    })).rejects.toThrow(/route not found/);
  });
});
