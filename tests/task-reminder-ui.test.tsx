import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

import { TaskAbortActionForm, TaskDetailView, TaskReviewActions } from "../web/src/App.js";
import type { TaskDetail } from "../web/src/types.js";

const task: TaskDetail = {
  id: "task-1",
  parentId: null,
  issuerId: "boss",
  assigneeId: "cto",
  title: "交付催办闭环",
  description: "实现催办功能",
  acceptanceCriteria: "负责人收到提醒",
  status: "in_progress",
  revision: 1,
  blockedReason: null,
  reviewFeedback: null,
  childIds: [],
  childCounts: { total: 0, active: 0, closed: 0, canceled: 0 },
  risks: { blockedDescendants: 0, staleDescendants: 0, stale: false },
  createdAt: "2026-08-05T08:00:00.000Z",
  updatedAt: "2026-08-05T08:00:00.000Z",
  lastActivityAt: "2026-08-05T08:00:00.000Z",
  versions: [{ revision: 1, changedBy: "boss", reason: "创建任务", createdAt: "2026-08-05T08:00:00.000Z" }],
  progress: [],
  submissions: [],
  reminderDispatch: null,
  reviewNotificationDispatch: null,
  audit: [],
};

describe("Boss task reminder control", () => {
  it("shows review material delivery, files, and the copyable verification command", () => {
    const html = renderToStaticMarkup(<TaskDetailView detail={{
      ...task,
      status: "review",
      submissions: [{
        id: "submission-1",
        summary: "请验收",
        evidence: [{ type: "proof", label: "tests", command: "npm test" }],
        status: "pending",
        gitLocation: { remoteUrl: "https://example.test/repo.git", branch: "agents/cto", commit: "a".repeat(40), verifiedAt: task.updatedAt },
        reviewHandoff: {
          files: [{ id: "file-1", evidenceIndex: 0, fileName: "report.pdf", sourcePath: "report.pdf", byteSize: 2048, sha256: "b".repeat(64) }],
          functionalVerification: { workingDirectory: "/workspace/cto", command: "npm run verify", oneLineCommand: "cd -- '/workspace/cto' && npm run verify" },
          delivery: { channel: "boss_email", status: "delivered", targetPath: null, attempts: 1, lastError: null, deliveredAt: task.updatedAt },
        },
        createdAt: task.updatedAt,
      }],
    }} members={[]} reload={vi.fn()} />);

    expect(html).toContain("验收材料");
    expect(html).toContain("Boss 邮件");
    expect(html).toContain("report.pdf");
    expect(html).toContain("复制验收命令");
    expect(html).toContain("npm run verify");
  });

  it("shows root-task image attachment metadata and a lazy-loading gallery", () => {
    const html = renderToStaticMarkup(<TaskDetailView detail={{
      ...task,
      attachments: [{
        id: "image-1",
        taskId: task.id,
        fileName: "交互参考图.png",
        mimeType: "image/png",
        byteSize: 2048,
        localPath: "/tmp/task-attachments/image-1.png",
        createdAt: task.createdAt,
      }],
    }} members={[]} reload={vi.fn()} />);

    expect(html).toContain("图片附件 · 1");
    expect(html).toContain("交互参考图.png");
    expect(html).toContain("正在加载图片");
    expect(html).toContain("/tmp/task-attachments/image-1.png");
  });

  it("shows the reminder action on an active task", () => {
    const html = renderToStaticMarkup(<TaskDetailView detail={task} members={[]} reload={vi.fn()} />);

    expect(html).toContain("催促负责人");
    expect(html).toContain("中止任务");
    expect(html).not.toContain("带审计取消");
    expect(html).not.toContain("全局重派");
  });

  it("disables duplicate reminders while a delivery is pending", () => {
    const html = renderToStaticMarkup(<TaskDetailView
      detail={{
        ...task,
        reminderDispatch: {
          id: "dispatch-1",
          targetMemberId: "cto",
          targetAgentId: "cto",
          kind: "boss_reminder",
          status: "pending",
          attempts: 0,
          lastError: null,
          createdAt: "2026-08-05T08:01:00.000Z",
          startedAt: null,
          completedAt: null,
        },
      }}
      members={[]}
      reload={vi.fn()}
    />);

    expect(html).toContain("正在通知负责人…");
    expect(html).toContain("最近催办负责人：等待发送");
    expect(html).toContain("disabled");
  });

  it("does not offer reminders for terminal tasks", () => {
    const html = renderToStaticMarkup(<TaskDetailView detail={{ ...task, status: "closed" }} members={[]} reload={vi.fn()} />);

    expect(html).not.toContain("催促负责人");
    expect(html).toContain("二次审查不通过");
  });

  it("offers exact-state restoration for canceled tasks", () => {
    const html = renderToStaticMarkup(<TaskDetailView detail={{ ...task, status: "canceled" }} members={[]} reload={vi.fn()} />);
    expect(html).toContain("恢复已取消任务");
  });

  it("shows review notification delivery and hides Boss review controls on child tasks", () => {
    const html = renderToStaticMarkup(<TaskDetailView
      detail={{
        ...task,
        parentId: "root-task",
        issuerId: "cto",
        status: "review",
        reviewNotificationDispatch: {
          id: "dispatch-review-1",
          targetMemberId: "eng-a",
          targetAgentId: "eng-a",
          kind: "review_rejected",
          status: "failed",
          attempts: 3,
          lastError: "agent session unavailable",
          createdAt: "2026-08-05T08:01:00.000Z",
          startedAt: "2026-08-05T08:02:00.000Z",
          completedAt: "2026-08-05T08:03:00.000Z",
        },
      }}
      members={[]}
      reload={vi.fn()}
    />);

    expect(html).toContain("最近验收通知：验收驳回 · 发送失败");
    expect(html).toContain("agent session unavailable");
    expect(html).not.toContain("验收并关闭");
    expect(html).toContain("催促审核人");
  });

  it("targets the issuer when reminding about a blocked child task", () => {
    const html = renderToStaticMarkup(<TaskDetailView
      detail={{ ...task, parentId: "root-task", issuerId: "cto", assigneeId: "eng-a", status: "blocked", blockedReason: "等待依赖" }}
      members={[]}
      reload={vi.fn()}
    />);

    expect(html).toContain("催促审核人");
    expect(html).not.toContain("催促负责人");
  });

  it("keeps Boss review controls on root tasks awaiting review", () => {
    const html = renderToStaticMarkup(<TaskDetailView detail={{ ...task, status: "review" }} members={[]} reload={vi.fn()} />);

    expect(html).toContain("验收并关闭");
    expect(html).toContain("驳回");
    expect(html).toContain("判定任务失败");
  });

  it("renders the frozen Git remote location for the latest submission", () => {
    const commit = "a".repeat(40);
    const html = renderToStaticMarkup(<TaskDetailView detail={{
      ...task,
      status: "review",
      submissions: [{
        id: "submission-1",
        summary: "已推送并提交",
        evidence: [{ type: "proof", label: "tests", command: "npm test" }],
        status: "pending",
        gitLocation: {
          remoteUrl: "https://git.example.test/company/company-os.git",
          branch: "agents/root-task",
          commit,
          verifiedAt: "2026-08-06T06:29:00.000Z",
        },
        createdAt: "2026-08-06T06:30:00.000Z",
      }],
    }} members={[]} reload={vi.fn()} />);

    expect(html).toContain("https://git.example.test/company/company-os.git");
    expect(html).toContain("agents/root-task");
    expect(html).toContain(commit);
    expect(html).toContain("冻结 commit");
  });

  it("renders an inline required rejection form without relying on browser prompts", () => {
    const html = renderToStaticMarkup(<TaskReviewActions
      mode="reject"
      feedback=""
      busy={false}
      choose={vi.fn()}
      changeFeedback={vi.fn()}
      submit={vi.fn()}
      cancel={vi.fn()}
    />);

    expect(html).toContain("驳回原因（必填）");
    expect(html).toContain("确认驳回");
    expect(html).toContain("disabled");
    expect(html).not.toContain("window.prompt");
  });

  it("allows optional inline feedback when accepting a root task", () => {
    const html = renderToStaticMarkup(<TaskReviewActions
      mode="accept"
      feedback="证据完整"
      busy={false}
      choose={vi.fn()}
      changeFeedback={vi.fn()}
      submit={vi.fn()}
      cancel={vi.fn()}
    />);

    expect(html).toContain("验收意见（可选）");
    expect(html).toContain("确认验收并关闭");
    expect(html).not.toContain("disabled");
  });

  it("requires an explicit reason before terminally failing a root task", () => {
    const html = renderToStaticMarkup(<TaskReviewActions
      mode="fail"
      feedback=""
      busy={false}
      choose={vi.fn()}
      changeFeedback={vi.fn()}
      submit={vi.fn()}
      cancel={vi.fn()}
    />);

    expect(html).toContain("BOSS FINAL FAILURE");
    expect(html).toContain("失败原因（必填）");
    expect(html).toContain("不再退回执行池，也不能重新提交");
    expect(html).toContain("确认判定失败并终结");
    expect(html).toContain("disabled");
  });

  it("renders a failed root as a terminal result without further management actions", () => {
    const html = renderToStaticMarkup(<TaskDetailView detail={{
      ...task,
      status: "failed",
      failedAt: "2026-08-09T04:00:00.000Z",
      failedReason: "多轮整改仍无法达到目标",
    }} members={[]} reload={vi.fn()} />);

    expect(html).toContain("任务失败");
    expect(html).toContain("该根任务已被 Boss 判定失败并终结");
    expect(html).toContain("多轮整改仍无法达到目标");
    expect(html).not.toContain("中止任务");
    expect(html).not.toContain("二次审查不通过");
  });

  it("renders the irreversible task-tree abort form without browser prompts", () => {
    const abort = renderToStaticMarkup(<TaskAbortActionForm
      reason="错误任务树作废"
      busy={false}
      error={null}
      changeReason={vi.fn()}
      submit={vi.fn()}
      cancel={vi.fn()}
    />);
    expect(abort).toContain("中止并废除任务树");
    expect(abort).toContain("只发布一条公司公告");
    expect(abort).toContain("确认中止并发布公告");
    expect(abort).not.toContain("window.prompt");

    const invalid = renderToStaticMarkup(<TaskAbortActionForm
      reason=""
      busy={false}
      error="task has already been aborted"
      changeReason={vi.fn()}
      submit={vi.fn()}
      cancel={vi.fn()}
    />);
    expect(invalid).toContain("中止原因（必填）");
    expect(invalid).toContain("task has already been aborted");
    expect(invalid).toContain("disabled");
  });
});
