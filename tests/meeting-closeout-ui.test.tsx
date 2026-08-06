import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MeetingCloseoutMemberList, MeetingCloseoutState } from "../web/src/App";
import type { MeetingDetail } from "../web/src/types";

const meeting = {
  closeoutStatus: {
    state: "syncing",
    blocksRoom: true,
    total: 3,
    delivered: 1,
    pending: 2,
    currentMemberId: "engineer",
    currentMemberName: "高级工程师",
    attempts: 2,
    lastError: "Agent 暂时繁忙",
    nextAttemptAt: "2026-08-06T03:00:00.000Z",
  },
  closeoutDispatches: [
    { id: "a", memberName: "架构师", status: "succeeded", attempts: 1, lastError: null },
    { id: "b", memberName: "高级工程师", status: "pending", attempts: 2, lastError: "Agent 暂时繁忙" },
    { id: "c", memberName: "CTO", status: "running", attempts: 1, lastError: null },
  ],
} as MeetingDetail;

describe("meeting closeout UI", () => {
  it("renders the strict room barrier and current delivery error", () => {
    const html = renderToStaticMarkup(<MeetingCloseoutState meeting={meeting} />);
    expect(html).toContain("正在向全体参会者同步最终记录");
    expect(html).toContain("已送达 1/3");
    expect(html).toContain("全部成员确认同步后，会议室才会启动下一场");
    expect(html).toContain("高级工程师 · 第 2 次尝试");
    expect(html).toContain("Agent 暂时繁忙");
  });

  it("renders member-level delivery progress", () => {
    const html = renderToStaticMarkup(<MeetingCloseoutMemberList meeting={meeting} />);
    expect(html).toContain("架构师");
    expect(html).toContain("已送达");
    expect(html).toContain("等待同步");
    expect(html).toContain("正在同步");
  });
});
