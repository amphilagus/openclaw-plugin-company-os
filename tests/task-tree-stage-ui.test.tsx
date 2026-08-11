import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

import { filterRootTasks, TaskNode } from "../web/src/App.js";
import type { Task } from "../web/src/types.js";

function task(input: Partial<Task> & Pick<Task, "id" | "title">): Task {
  return {
    id: input.id,
    parentId: input.parentId ?? null,
    issuerId: input.issuerId ?? "boss",
    assigneeId: input.assigneeId ?? "cto",
    title: input.title,
    description: input.description ?? `${input.title}说明`,
    acceptanceCriteria: input.acceptanceCriteria ?? `${input.title}验收`,
    status: input.status ?? "assigned",
    revision: 1,
    blockedReason: null,
    blockedAt: null,
    reviewFeedback: null,
    childIds: input.childIds ?? [],
    childCounts: input.childCounts ?? { total: 0, active: 0, closed: 0, canceled: 0 },
    risks: { blockedDescendants: 0, staleDescendants: 0, stale: false },
    createdAt: "2026-08-07T08:00:00.000Z",
    updatedAt: "2026-08-07T08:00:00.000Z",
    lastActivityAt: "2026-08-07T08:00:00.000Z",
    abortedAt: null,
    abortedReason: null,
    availability: input.availability ?? "active",
    flowStage: input.flowStage ?? null,
  };
}

function stage(position: number, name: string, objective: string, status: NonNullable<Task["flowStage"]>["status"]) {
  return {
    flowId: "flow-root",
    stageId: `stage-${position}`,
    position,
    name,
    objective,
    status,
  };
}

describe("staged task tree", () => {
  it("keeps task branches collapsed by default", () => {
    const root = task({ id: "root", title: "默认折叠根任务", childIds: ["child"], childCounts: { total: 1, active: 1, closed: 0, canceled: 0 } });
    const child = task({ id: "child", parentId: root.id, title: "默认不可见子任务" });
    const html = renderToStaticMarkup(<TaskNode task={root} all={[root, child]} visible={() => true} selectedId="" select={vi.fn()} depth={0} />);

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("默认折叠根任务");
    expect(html).not.toContain("默认不可见子任务");
  });

  it("filters roots independently by selected root and root review status", () => {
    const review = task({ id: "review-root", title: "待验收工作", status: "review" });
    const active = task({ id: "active-root", title: "进行中工作", status: "in_progress" });

    expect(filterRootTasks([review, active], "all", "review")).toEqual([review]);
    expect(filterRootTasks([review, active], active.id, "all")).toEqual([active]);
    expect(filterRootTasks([review, active], active.id, "review")).toEqual([]);
  });

  it("labels closed tasks as completed and gives running tasks their execution tone", () => {
    const completed = task({ id: "completed", title: "完成任务", status: "closed" });
    const running = task({ id: "running", title: "执行任务", status: "in_progress" });

    const completedHtml = renderToStaticMarkup(<TaskNode task={completed} all={[completed]} visible={() => true} selectedId="" select={vi.fn()} depth={0} />);
    const runningHtml = renderToStaticMarkup(<TaskNode task={running} all={[running]} visible={() => true} selectedId="" select={vi.fn()} depth={0} />);

    expect(completedHtml).toContain("已完成");
    expect(completedHtml).not.toContain("已关闭");
    expect(runningHtml).toContain('class="badge tone-in_progress"');
  });

  it("groups sibling tasks into prominent ordered stages with progress and recursively renders nested flows", () => {
    const root = task({ id: "root", title: "根任务", childIds: ["a", "b", "c"], childCounts: { total: 3, active: 2, closed: 1, canceled: 0 } });
    const a = task({ id: "a", parentId: root.id, title: "阶段一任务 A", status: "closed", flowStage: stage(0, "基础实现", "并行完成底层能力", "active") });
    const b = task({ id: "b", parentId: root.id, title: "阶段一任务 B", flowStage: stage(0, "基础实现", "并行完成底层能力", "active"), childIds: ["b1"] });
    const c = task({ id: "c", parentId: root.id, title: "阶段二任务 C", availability: "waiting_stage", flowStage: stage(1, "集成验证", "等待前序后执行端到端验证", "waiting") });
    const b1 = task({
      id: "b1",
      parentId: b.id,
      issuerId: "cto",
      assigneeId: "eng-a",
      title: "嵌套实现任务",
      flowStage: {
        flowId: "flow-b",
        stageId: "stage-b-0",
        position: 0,
        name: "内部阶段",
        objective: "完成嵌套任务流",
        status: "active",
      },
    });
    const html = renderToStaticMarkup(<TaskNode
      task={root}
      all={[root, a, b, c, b1]}
      visible={() => true}
      selectedId=""
      select={vi.fn()}
      depth={0}
      defaultExpanded
    />);

    expect(html).toContain("STAGE");
    expect(html).toContain("基础实现");
    expect(html).toContain("当前阶段");
    expect(html).toContain("1/2");
    expect(html).toContain("同阶段并行 2 项");
    expect(html).toContain("阶段屏障");
    expect(html).toContain("集成验证");
    expect(html).toContain("等待前序");
    expect(html).toContain("内部阶段");
    expect(html.indexOf("基础实现")).toBeLessThan(html.indexOf("集成验证"));
  });
});
