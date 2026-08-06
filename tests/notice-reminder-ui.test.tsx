import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { NoticeReminderPanel } from "../web/src/App.js";
import type { NoticeUnreadReminderSummary } from "../web/src/types.js";

describe("notice reminder Boss panel", () => {
  it("shows the configured half-hour window, current unread totals, delivery state, and backlog", () => {
    const summary: NoticeUnreadReminderSummary = {
      enabled: true,
      timeZone: "Asia/Shanghai",
      startHour: 8,
      endHour: 17,
      nextRunAt: "2026-08-06T09:30:00.000Z",
      backlog: 2,
      currentUnreadAgents: 4,
      currentUnreadEntries: 9,
      today: {
        localDate: "2026-08-06",
        latestRun: {
          id: "notice-run-1",
          scheduledAt: "2026-08-06T08:30:00.000Z",
          candidateAgents: 5,
          candidateUnreadEntries: 12,
          pending: 1,
          running: 1,
          delivered: 2,
          failed: 1,
          skipped: 2,
          canceled: 1,
        },
      },
    };

    const html = renderToStaticMarkup(<NoticeReminderPanel summary={summary} />);
    expect(html).toContain("公告半点提醒");
    expect(html).toContain("半点 08:30–17:30");
    expect(html).toContain("当前未读 Agent");
    expect(html).toContain(">4<");
    expect(html).toContain("当前未读人次");
    expect(html).toContain(">9<");
    expect(html).toContain("失败 / 跳过");
    expect(html).toContain(">1 / 2<");
    expect(html).toContain("当前积压");
    expect(html).toContain("Agent 5 · 未读人次 12");
    expect(html).toContain("发送中：1 · 等待：1 · 取消：1");
  });

  it("shows a disabled, not-yet-run state", () => {
    const summary: NoticeUnreadReminderSummary = {
      enabled: false,
      timeZone: "Asia/Shanghai",
      startHour: 8,
      endHour: 17,
      nextRunAt: null,
      backlog: 0,
      currentUnreadAgents: 0,
      currentUnreadEntries: 0,
      today: { localDate: "2026-08-06", latestRun: null },
    };

    const html = renderToStaticMarkup(<NoticeReminderPanel summary={summary} />);
    expect(html).toContain("已关闭");
    expect(html).toContain("今日尚未运行");
  });
});
