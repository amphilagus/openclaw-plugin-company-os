import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskRollingPoolPanel } from "../web/src/App.js";
import type { TaskPromptPoolSummary } from "../web/src/types.js";

describe("rolling task prompt pool Boss panel", () => {
  afterEach(() => vi.useRealTimers());

  it("shows queue heads, next tick, item kinds, and busy skips", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T02:25:00.000Z"));
    const summary: TaskPromptPoolSummary = {
      enabled: true,
      timeZone: "Asia/Shanghai",
      startHour: 8,
      endHour: 17,
      workHoursSource: "config_default",
      nextDueAt: "2026-08-06T02:40:00.000Z",
      totals: { employees: 2, items: 3, execution: 1, review: 1, blockedReview: 1 },
      queues: [{
        memberId: "cto",
        memberName: "CTO",
        level: 1,
        defaultIntervalMinutes: 5,
        intervalMinutes: 15,
        intervalOverrideMinutes: 15,
        intervalSource: "boss_override",
        nextDueAt: "2026-08-06T02:40:00.000Z",
        remainingWorkMinutes: 15,
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
        items: [{
          taskId: "child-b",
          parentTaskId: "task-a",
          title: "子任务 b",
          parentTitle: "任务 A",
          kind: "review",
          enqueuedAt: "2026-08-06T02:00:00.000Z",
          lastPromptedAt: null,
          promptCount: 0,
        }, {
          taskId: "child-c",
          parentTaskId: "task-a",
          title: "子任务 c",
          parentTitle: "任务 A",
          kind: "blocked_review",
          enqueuedAt: "2026-08-06T02:05:00.000Z",
          lastPromptedAt: null,
          promptCount: 0,
        }],
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

    const html = renderToStaticMarkup(<TaskRollingPoolPanel summary={summary} reload={vi.fn()} />);
    expect(html).toContain("任务回转提示池");
    expect(html).toContain("08:00–18:00 · 个人倒计时");
    expect(html).toContain("池内事项");
    expect(html).toContain(">3<");
    expect(html).toContain("CTO：2 项 · 15 分钟 · 剩余 15 分钟 · 池首 验收「子任务 b」");
    expect(html).toContain("Boss 覆盖 15 分钟");
    expect(html).toContain("个人倒计时");
    expect(html).toContain("00:15:00");
    expect(html).toContain("倒计时进行中");
    expect(html).toContain("下次到期");
    expect(html).toContain("有效周期 15 分钟 · Boss 覆盖");
    expect(html).toContain("上班时间");
    expect(html).toContain("应用时间");
    expect(html).toContain("层级系数（分钟）");
    expect(html).toContain("应用系数");
    expect(html).toContain("暂停任务回转");
    expect(html).toContain("配置默认");
    expect(html).toContain("最近调度：会话忙碌跳过");
    expect(html).toContain("子任务 c");
    expect(html).toContain("阻塞审查");
    expect(html).toContain("会话忙碌跳过");

    const titledHtml = renderToStaticMarkup(<TaskRollingPoolPanel
      summary={summary}
      organization={[{ id: "cto", agentId: "cto", kind: "agent", name: "CTO", title: "首席技术官", managerId: "boss", level: 1, active: true }]}
    />);
    expect(titledHtml).toContain("首席技术官");
    expect(titledHtml).toContain("FIFO 队列");
    expect(titledHtml).toContain('aria-label="CTO的头像"');
    expect(titledHtml).toContain("task-prompt-queue-avatar");

    const legacyQueue = {
      ...summary.queues[0],
      level: undefined,
      defaultIntervalMinutes: undefined,
      intervalMinutes: undefined,
      intervalOverrideMinutes: undefined,
      intervalSource: undefined,
    } as any;
    const legacyHtml = renderToStaticMarkup(<TaskRollingPoolPanel
      summary={{ ...summary, queues: [legacyQueue] }}
      organization={[{ id: "cto", agentId: "cto", kind: "agent", name: "CTO", title: "首席技术官", managerId: "boss", level: 1, active: true }]}
    />);
    expect(legacyHtml).toContain("1 级默认 5 分钟");
    expect(legacyHtml).toContain("有效周期 5 分钟 · 1 级默认");
    expect(legacyHtml).not.toContain("undefined 级默认");
  });

  it("shows the global pause state and preserves the displayed remaining countdown", () => {
    const summary: TaskPromptPoolSummary = {
      enabled: true,
      paused: true,
      pausedAt: "2026-08-06T02:03:00.000Z",
      timeZone: "Asia/Shanghai",
      startHour: 8,
      endHour: 17,
      workHoursSource: "boss_override",
      minutesPerLevel: 8,
      minutesPerLevelSource: "boss_override",
      nextDueAt: null,
      totals: { employees: 1, items: 1, execution: 1, review: 0, blockedReview: 0 },
      queues: [{
        memberId: "cto",
        memberName: "CTO",
        level: 1,
        defaultIntervalMinutes: 8,
        intervalMinutes: 8,
        intervalOverrideMinutes: null,
        intervalSource: "level_default",
        nextDueAt: null,
        remainingWorkMinutes: 5,
        count: 1,
        head: { taskId: "task-a", title: "任务 A", parentTitle: null, kind: "execution", enqueuedAt: "2026-08-06T02:00:00.000Z", lastPromptedAt: null, promptCount: 0 },
        items: [{ taskId: "task-a", parentTaskId: null, title: "任务 A", parentTitle: null, kind: "execution", enqueuedAt: "2026-08-06T02:00:00.000Z", lastPromptedAt: null, promptCount: 0 }],
        lastDispatch: null,
      }],
    };

    const html = renderToStaticMarkup(<TaskRollingPoolPanel summary={summary} reload={vi.fn()} />);
    expect(html).toContain("全公司回转已暂停");
    expect(html).toContain("Boss 已暂停全公司回转");
    expect(html).toContain("00:05:00");
    expect(html).toContain("恢复任务回转");
  });
});
