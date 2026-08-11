import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

import { BossMeetingGate } from "../web/src/BossMeetingGate.js";
import type { MeetingDetail } from "../web/src/types.js";

const meeting: MeetingDetail = {
  id: "meeting-1",
  type: "discussion",
  status: "active",
  title: "Boss 参会",
  agenda: "测试",
  hostId: "cto",
  requestedBy: "cto",
  parentTaskId: null,
  summary: null,
  bossParticipates: true,
  bossStartedAt: null,
  awaitingBossStart: true,
  endRequestedAt: null,
  endRequestedSummary: null,
  endRequestedPublishNotice: false,
  autoEndAt: null,
  queuePosition: 0,
  participantCount: 0,
  currentTurnId: null,
  createdAt: "2026-08-05T08:00:00.000Z",
  startedAt: "2026-08-05T08:00:00.000Z",
  endedAt: null,
  canceledReason: null,
  participants: [],
  messages: [],
  taskDraftStages: [],
  currentTurn: null,
};

describe("Boss direct meeting controls", () => {
  it("shows an explicit start gate while every Agent is parked", () => {
    const html = renderToStaticMarkup(<BossMeetingGate
      meeting={meeting}
      busy={false}
      start={vi.fn()}
      rejectMeeting={vi.fn()}
      approveEnd={vi.fn()}
      rejectEnd={vi.fn()}
    />);

    expect(html).toContain("所有人正在等待你");
    expect(html).toContain("我已进入，开始会议");
    expect(html).toContain("拒绝此次会议");
    expect(html).not.toContain("批准并结束");
  });

  it("shows the host summary and makes the final decision a Boss action", () => {
    const html = renderToStaticMarkup(<BossMeetingGate
      meeting={{
        ...meeting,
        bossStartedAt: "2026-08-05T08:05:00.000Z",
        awaitingBossStart: false,
        endRequestedAt: "2026-08-05T09:00:00.000Z",
        endRequestedSummary: "主持人的最终总结",
      }}
      busy={false}
      start={vi.fn()}
      rejectMeeting={vi.fn()}
      approveEnd={vi.fn()}
      rejectEnd={vi.fn()}
    />);

    expect(html).toContain("主持人的最终总结");
    expect(html).toContain("批准并结束");
    expect(html).toContain("暂不结束");
  });

  it("shows a countdown instead of Boss approval for a meeting Boss did not join", () => {
    const html = renderToStaticMarkup(<BossMeetingGate
      meeting={{
        ...meeting,
        bossParticipates: false,
        awaitingBossStart: false,
        endRequestedAt: new Date().toISOString(),
        endRequestedSummary: "普通会议总结",
        autoEndAt: new Date(Date.now() + 60_000).toISOString(),
      }}
      busy={false}
      start={vi.fn()}
      rejectMeeting={vi.fn()}
      approveEnd={vi.fn()}
      rejectEnd={vi.fn()}
    />);

    expect(html).toContain("秒后自动结束");
    expect(html).toContain("普通会议总结");
    expect(html).not.toContain("批准并结束");
    expect(html).not.toContain("暂不结束");
  });

  it("shows the three fixed Boss decisions without exposing legacy end approval", () => {
    const html = renderToStaticMarkup(<BossMeetingGate
      meeting={{
        ...meeting,
        sessionMode: "dedicated",
        entryState: "ready",
        entryStatus: { state: "ready", total: 2, notified: 2, ready: 2, waitingMembers: [], nextRetryAt: null },
        controlState: "waiting_boss",
        waitingOnBossSince: "2026-08-05T09:00:00.000Z",
        latestHostSummary: "主持人总结第一版",
        latestHostSummaryAt: "2026-08-05T09:00:00.000Z",
        bossEndBlockedReason: null,
        bossStartedAt: "2026-08-05T08:05:00.000Z",
        awaitingBossStart: false,
        memberSessions: [],
      }}
      busy={false}
      start={vi.fn()}
      rejectMeeting={vi.fn()}
      speak={vi.fn()}
      requestSummary={vi.fn()}
      endMeeting={vi.fn()}
    />);

    expect(html).toContain("1</b> 我要发言");
    expect(html).toContain("2</b> 请主持人总结");
    expect(html).toContain("3</b> 结束会议");
    expect(html).toContain("主持人总结第一版");
    expect(html).not.toContain("批准并结束");
  });
});
