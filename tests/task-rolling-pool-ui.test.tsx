import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { TaskRollingPoolPanel } from "../web/src/App.js";
import type { TaskPromptPoolSummary } from "../web/src/types.js";

describe("rolling task prompt pool Boss panel", () => {
  it("shows queue heads, next tick, item kinds, and busy skips", () => {
    const summary: TaskPromptPoolSummary = {
      enabled: true,
      timeZone: "Asia/Shanghai",
      startHour: 8,
      endHour: 17,
      intervalMinutes: 20,
      nextTickAt: "2026-08-06T02:40:00.000Z",
      totals: { employees: 2, items: 3, execution: 1, review: 1, blockedReview: 1 },
      queues: [{
        memberId: "cto",
        memberName: "CTO",
        count: 2,
        head: {
          taskId: "child-b",
          title: "子任务 b",
          parentTitle: "任务 A",
          kind: "review",
          enqueuedAt: "2026-08-06T02:00:00.000Z",
          lastPromptedAt: null,
          promptCount: 0,
        },
        lastDispatch: {
          status: "skipped_busy",
          taskId: null,
          kind: null,
          scheduledAt: "2026-08-06T02:20:00.000Z",
          completedAt: "2026-08-06T02:20:00.000Z",
          lastError: "main session is active",
        },
      }],
    };

    const html = renderToStaticMarkup(<TaskRollingPoolPanel summary={summary} />);
    expect(html).toContain("任务回转提示池");
    expect(html).toContain("08:00–17:40 · 每 20 分钟");
    expect(html).toContain("池内事项");
    expect(html).toContain(">3<");
    expect(html).toContain("CTO：2 项 · 池首 验收「子任务 b」");
    expect(html).toContain("会话忙碌跳过");
  });
});
