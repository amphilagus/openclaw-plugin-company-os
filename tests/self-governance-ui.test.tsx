import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { routeFromPath } from "../web/src/App.js";
import { SelfGovernancePage } from "../web/src/SelfGovernancePage.js";
import type { Snapshot } from "../web/src/types.js";

describe("self-governance UI", () => {
  it("recognizes the fourth top-level route and renders the empty daily state", () => {
    expect(routeFromPath("/plugins/company-os-ui/self-governance")).toBe("self-governance");
    expect(routeFromPath("/plugins/company-os-ui/unknown")).toBe("meeting-room");

    const html = renderToStaticMarkup(<SelfGovernancePage snapshot={snapshot()} />);
    expect(html).toContain("自省治理");
    expect(html).toContain("每日经验沉淀");
    expect(html).toContain("每日人设治理");
    expect(html).toContain("今日尚未建立自省任务");
    expect(html).toContain("最近 7 天");
    expect(html).toContain("没有符合条件的历史");
  });

  it("shows per-agent session, failure detail, history counts, and read-only filters", () => {
    const failedDispatch = {
      id: "dispatch-1",
      runId: "run-1",
      kind: "daily_persona_audit" as const,
      targetMemberId: "main",
      targetAgentId: "main",
      position: 0,
      scheduledAt: "2030-01-07T22:00:00.000Z",
      sessionKey: "agent:main:self-audit",
      status: "failed" as const,
      attempts: 1,
      lastError: "agent session is already in flight",
      createdAt: "2030-01-07T22:00:00.000Z",
      startedAt: "2030-01-07T22:00:01.000Z",
      completedAt: "2030-01-07T22:00:02.000Z",
    };
    const run = {
      id: "run-1",
      kind: "daily_persona_audit" as const,
      localDate: "2030-01-08",
      scheduledAt: "2030-01-07T22:00:00.000Z",
      planned: 1,
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 1,
      canceled: 0,
      dispatches: [failedDispatch],
    };
    const value = snapshot();
    value.dailySelfGovernance.mechanisms.personaAudit.today = run;
    value.dailySelfGovernance.history = [run];

    const html = renderToStaticMarkup(<SelfGovernancePage snapshot={value} />);
    expect(html).toContain("agent:main:self-audit");
    expect(html).toContain("agent session is already in flight");
    expect(html).toContain("失败 1");
    expect(html).toContain("任务类型");
    expect(html).toContain("Agent");
    expect(html).not.toContain("立即执行");
    expect(html).not.toContain("重试");
  });
});

function snapshot(): Snapshot {
  return {
    organization: [{
      id: "main",
      agentId: "main",
      kind: "agent",
      name: "架构师",
      title: "首席架构师",
      managerId: "boss",
      level: 1,
      active: true,
    }],
    tasks: [],
    notices: [],
    meetings: { active: null, closing: null, queue: [], history: [] },
    taskHourlyCheckin: {
      enabled: false,
      timeZone: "Asia/Shanghai",
      startHour: 8,
      endHour: 17,
      nextRunAt: null,
      nextDispatchAt: null,
      nextDispatch: null,
      backlog: 0,
      today: { localDate: "2030-01-08", latestRun: null },
      boss: { reviewCount: 0, anomalyCount: 0, emailStatus: null, lastError: null },
    },
    noticeUnreadReminder: {
      enabled: false,
      timeZone: "Asia/Shanghai",
      startHour: 8,
      endHour: 17,
      nextRunAt: null,
      backlog: 0,
      currentUnreadAgents: 0,
      currentUnreadEntries: 0,
      today: { localDate: "2030-01-08", latestRun: null },
    },
    dailySelfGovernance: {
      timeZone: "Asia/Shanghai",
      sessionName: "self-audit",
      backlog: 0,
      mechanisms: {
        selfImprovement: { enabled: true, hour: 5, minute: 0, nextRunAt: "2030-01-08T21:00:00.000Z", today: null },
        personaAudit: { enabled: true, hour: 6, minute: 0, nextRunAt: "2030-01-08T22:00:00.000Z", today: null },
      },
      history: [],
    },
    generatedAt: "2030-01-08T04:00:00.000Z",
  };
}
