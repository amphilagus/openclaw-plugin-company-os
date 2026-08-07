import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MeetingHistory, MeetingHistoryDetail } from "../web/src/MeetingHistory";
import type { MeetingDetail, MeetingSummary, MemberIdentity } from "../web/src/types";

const identities: Record<string, MemberIdentity> = {
  boss: { id: "boss", name: "Boss", title: "CEO", emoji: null, avatarUrl: "data:image/png;base64,Ym9zcw==" },
  main: { id: "main", name: "架构师", title: "首席架构师", emoji: "⚙️", avatarUrl: "data:image/png;base64,aW1hZ2U=" },
  engineer: { id: "engineer", name: "高级工程师", title: "工程师", emoji: "🔧", avatarUrl: "data:image/png;base64,aW1hZ2U=" },
};

const summary: MeetingSummary = {
  id: "meeting-history-1",
  type: "task",
  status: "completed",
  title: "季度战略会",
  agenda: "确定季度目标",
  hostId: "main",
  requestedBy: "main",
  parentTaskId: "task-root-1",
  summary: "确定三个执行方向。",
  bossParticipates: true,
  bossStartedAt: "2026-08-05T08:05:00.000Z",
  awaitingBossStart: false,
  endRequestedAt: null,
  endRequestedSummary: null,
  endRequestedPublishNotice: false,
  autoEndAt: null,
  queuePosition: 0,
  participantCount: 1,
  currentTurnId: null,
  createdAt: "2026-08-05T08:00:00.000Z",
  startedAt: "2026-08-05T08:05:00.000Z",
  endedAt: "2026-08-05T09:00:00.000Z",
  canceledReason: null,
};

describe("meeting history UI", () => {
  it("renders every history item as an accessible detail button", () => {
    const html = renderToStaticMarkup(<MeetingHistory history={[summary]} identities={identities} />);
    expect(html).toContain("查看会议：季度战略会");
    expect(html).toContain("查看档案 →");
    expect(html).toContain("架构师");
  });

  it("renders the archived summary, transcript, participants and task drafts", () => {
    const detail: MeetingDetail = {
      ...summary,
      participants: [{ agentId: "engineer", role: "worker", name: "高级工程师", title: "工程师" }],
      messages: [
        { id: "message-0", sequence: 1, authorKind: "boss", authorId: "boss", targetId: null, body: "现在开始会议。", createdAt: summary.startedAt! },
        { id: "message-1", sequence: 2, authorKind: "member", authorId: "engineer", targetId: null, body: "建议优先完成任务树。", createdAt: summary.startedAt! },
      ],
      taskDraftStages: [{
        id: "stage-1", position: 0, name: "第一阶段", objective: "先完成任务树",
        tasks: [{ id: "draft-1", position: 0, title: "实现任务树", description: "完成树形交互", acceptanceCriteria: "测试通过", assigneeId: "engineer" }],
      }],
      currentTurn: null,
    };
    const html = renderToStaticMarkup(<MeetingHistoryDetail meeting={detail} identities={identities} close={vi.fn()} />);
    expect(html).toContain("确定三个执行方向");
    expect(html).toContain("建议优先完成任务树");
    expect(html).toContain("高级工程师");
    expect(html).toContain("实现任务树");
    expect(html).toContain("Boss 直接参会");
    expect(html).toContain("data:image/png;base64,Ym9zcw==");
    expect(html).toContain("data:image/png;base64,aW1hZ2U=");
  });
});
