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
});
