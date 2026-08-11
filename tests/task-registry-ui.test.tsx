import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

import { RootTaskForm } from "../web/src/App.js";

const members = [{
  id: "cto",
  name: "CTO",
  title: "首席技术官",
  managerId: "boss",
  active: true,
  kind: "agent",
}] as any;

describe("Boss root task registry meeting policy", () => {
  it("defaults to requiring a task meeting without Boss participation", () => {
    const html = renderToStaticMarkup(<RootTaskForm members={members} submit={vi.fn()} compact />);
    const bossInput = html.match(/<input[^>]*name="taskMeetingBossParticipates"[^>]*>/)?.[0];

    expect(html).toMatch(/name="requireTaskMeeting"[^>]*checked=""/);
    expect(bossInput).toBeTruthy();
    expect(bossInput).not.toContain("checked");
    expect(html).toContain("要求负责人通过任务会完成拆解");
    expect(html).toContain("要求 Boss 参加任务会");
    expect(html).toContain("默认不参加");
    expect(html).toContain('name="attachments"');
    expect(html).toContain('accept="image/png,image/jpeg,image/webp,image/gif"');
    expect(html).toContain("最多 4 张");
  });

  it("restores both meeting selections from an aborted root-task draft", () => {
    const html = renderToStaticMarkup(<RootTaskForm
      members={members}
      submit={vi.fn()}
      draft={{
        sourceTaskId: "root-1",
        title: "重建任务",
        description: "重新拆解",
        acceptanceCriteria: "完成",
        assigneeId: "cto",
        requireTaskMeeting: true,
        taskMeetingBossParticipates: true,
      }}
    />);

    expect(html).toMatch(/name="requireTaskMeeting"[^>]*checked=""/);
    expect(html).toMatch(/name="taskMeetingBossParticipates"[^>]*checked=""/);
  });
});
