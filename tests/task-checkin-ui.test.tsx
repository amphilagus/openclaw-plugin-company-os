import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { TaskCheckinPanel } from "../web/src/App.js";
import type { TaskHourlyCheckinSummary } from "../web/src/types.js";

describe("task check-in Boss panel", () => {
  it("shows the latest run, delivery counts, backlog, next slots, and Boss email state", () => {
    const summary: TaskHourlyCheckinSummary = {
      enabled: true,
      timeZone: "Asia/Shanghai",
      startHour: 8,
      endHour: 17,
      nextRunAt: "2026-08-06T03:00:00.000Z",
      nextDispatchAt: "2026-08-06T02:15:00.000Z",
      nextDispatch: {
        scheduledAt: "2026-08-06T02:15:00.000Z",
        targetMemberId: "cto",
        channel: "agent",
        taskId: "task-2",
        title: "验收二级任务",
        actionKind: "review",
      },
      backlog: 2,
      today: {
        localDate: "2026-08-06",
        latestRun: {
          id: "run-1",
          scheduledAt: "2026-08-06T02:00:00.000Z",
          candidateEmployees: 4,
          plannedReminders: 9,
          pending: 5,
          running: 1,
          delivered: 3,
          failed: 1,
          skipped: 2,
          canceled: 0,
        },
      },
      boss: {
        reviewCount: 2,
        anomalyCount: 3,
        emailStatus: "failed",
        lastError: "SMTP unavailable",
      },
    };

    const html = renderToStaticMarkup(<TaskCheckinPanel summary={summary} />);
    expect(html).toContain("今日任务整点巡检");
    expect(html).toContain("候选员工");
    expect(html).toContain(">4<");
    expect(html).toContain("计划提醒");
    expect(html).toContain(">9<");
    expect(html).toContain("当前积压");
    expect(html).toContain("cto · 验收二级任务（验收）");
    expect(html).toContain("待验收 2 · 异常 3 · 邮件 失败");
    expect(html).toContain("SMTP unavailable");
  });
});
