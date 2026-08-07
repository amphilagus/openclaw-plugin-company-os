import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addShanghaiWorkMinutes, CompanyOsStore } from "../src/store.js";
import { resolveConfig } from "../src/types.js";
import { VERIFIED_GIT } from "./test-git.js";

const PROOF = [{ type: "proof" as const, label: "tests", command: "npm test" }];
const PASS_REPORT = {
  checks: [{ criterion: "验收标准", outcome: "pass" as const, evidenceIndexes: [0], finding: "证据有效" }],
  conclusion: "满足验收标准",
};
const FAIL_REPORT = {
  checks: [{ criterion: "验收标准", outcome: "fail" as const, evidenceIndexes: [], finding: "复核发现不满足标准", remediation: "修复后重新提交" }],
  conclusion: "二次审查不通过",
};

let directory: string;
let store: CompanyOsStore;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "company-os-v15-flow-"));
  store = new CompanyOsStore({
    databasePath: path.join(directory, "company-os.sqlite"),
    allowedAgentIds: ["main", "cto", "eng-a", "eng-b", "dev-a"],
    config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
  });
  store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
  store.addMember("main", { agentId: "eng-a", name: "工程师 A", title: "工程师", managerId: "cto" });
  store.addMember("main", { agentId: "eng-b", name: "工程师 B", title: "工程师", managerId: "cto" });
  store.addMember("main", { agentId: "dev-a", name: "开发 A", title: "开发工程师", managerId: "eng-a" });
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function task(title: string, assigneeId: string) {
  return { title, description: `${title}说明`, acceptanceCriteria: `${title}标准`, assigneeId };
}

function accept(actorId: string, taskId: string) {
  store.readTask(actorId, taskId);
  return store.reviewTask(actorId, taskId, "accept", "证据已复核", PASS_REPORT);
}

describe("schema v15 staged task flows", () => {
  it("runs tasks in parallel inside a stage and activates the next stage only after every required task closes", () => {
    const root = store.createRootTask({ ...task("根任务", "cto") });
    const flow = store.createTaskFlow("cto", {
      parentId: root.id,
      stages: [
        { name: "阶段一", objective: "并行完成基础能力", tasks: [task("A", "eng-a"), task("B", "eng-b")] },
        { name: "阶段二", objective: "集成验证", tasks: [task("C", "eng-a")] },
      ],
    });
    const [aId, bId] = flow.stages[0]!.taskIds;
    const cId = flow.stages[1]!.taskIds[0]!;

    expect(store.readTask("boss", cId, false)).toMatchObject({ availability: "waiting_stage" });
    expect(store.listTasks("eng-a").map((item) => item.id)).toContain(aId);
    expect(store.listTasks("eng-a").map((item) => item.id)).not.toContain(cId);
    expect(() => store.startTask("eng-a", cId)).toThrow(/waiting_stage/);

    store.startTask("eng-a", aId!);
    store.submitTask("eng-a", aId!, "A 完成", PROOF, VERIFIED_GIT);
    accept("cto", aId!);
    expect(store.readTask("boss", cId, false).availability).toBe("waiting_stage");

    store.startTask("eng-b", bId!);
    store.submitTask("eng-b", bId!, "B 完成", PROOF, VERIFIED_GIT);
    accept("cto", bId!);
    expect(store.readTask("boss", cId, false)).toMatchObject({ availability: "active", flowStage: { status: "active" } });
    expect(store.listTasks("eng-a").map((item) => item.id)).toContain(cId);

    store.startTask("eng-a", cId);
    store.submitTask("eng-a", cId, "C 完成", PROOF, VERIFIED_GIT);
    accept("cto", cId);
    expect(store.readTask("boss", root.id, false).childFlow?.stages.map((stage) => stage.status)).toEqual(["completed", "completed"]);
    expect(store.taskPromptPoolSummary().queues.find((queue) => queue.memberId === "cto")?.head)
      .toMatchObject({ taskId: root.id, kind: "execution" });
  });

  it("does not count a newly canceled stage task as complete and preserves downstream state and FIFO position across a second-review rollback", () => {
    const root = store.createRootTask({ ...task("纠错任务", "cto") });
    const flow = store.createTaskFlow("cto", {
      parentId: root.id,
      stages: [
        { name: "上游", objective: "完成上游", tasks: [task("A", "eng-a"), task("B", "eng-b")] },
        { name: "下游", objective: "完成下游", tasks: [task("C", "eng-a")] },
      ],
    });
    const [aId, bId] = flow.stages[0]!.taskIds;
    const cId = flow.stages[1]!.taskIds[0]!;
    store.cancelTask("cto", bId!, "暂时砍掉");
    expect(store.readTask("boss", cId, false).availability).toBe("waiting_stage");
    store.startTask("cto", root.id);
    expect(() => store.submitTask("cto", root.id, "不能越过取消项", PROOF, VERIFIED_GIT)).toThrow(/child tasks.*stages/);
    store.correctTaskTerminalDecision("boss", bId!, "restore_cancellation", "恢复必需任务");

    for (const [id, assignee] of [[aId!, "eng-a"], [bId!, "eng-b"]] as const) {
      store.startTask(assignee, id);
      store.submitTask(assignee, id, `${id} 完成`, PROOF, VERIFIED_GIT);
      accept("cto", id);
    }
    store.startTask("eng-a", cId);
    store.addTaskProgress("eng-a", cId, "下游成果已保留");
    const before = store.db.prepare("SELECT queue_seq FROM task_prompt_pool_items WHERE task_id = ?").get(cId) as { queue_seq: number };

    store.correctTaskTerminalDecision("cto", aId!, "revoke_acceptance", "上游需要重做", FAIL_REPORT);
    const suspended = store.readTask("boss", cId, false);
    expect(suspended).toMatchObject({ status: "in_progress", availability: "suspended_stage" });
    expect(suspended.progress.at(-1)?.body).toBe("下游成果已保留");
    expect(store.db.prepare("SELECT queue_seq, paused_at FROM task_prompt_pool_items WHERE task_id = ?").get(cId))
      .toMatchObject({ queue_seq: before.queue_seq, paused_at: expect.any(String) });

    store.submitTask("eng-a", aId!, "A 整改完成", PROOF, VERIFIED_GIT);
    accept("cto", aId!);
    expect(store.readTask("boss", cId, false).availability).toBe("active");
    expect(store.db.prepare("SELECT queue_seq, paused_at FROM task_prompt_pool_items WHERE task_id = ?").get(cId))
      .toMatchObject({ queue_seq: before.queue_seq, paused_at: null });
  });

  it("keeps a required task meeting in FIFO and fulfills it only when the Boss-participating meeting atomically creates a staged flow", () => {
    const root = store.createRootTask({ ...task("需要任务会", "cto"), requireTaskMeeting: true });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM task_agent_dispatches WHERE task_id = ?").get(root.id)).toMatchObject({ count: 0 });
    const originalSequence = (store.db.prepare("SELECT queue_seq FROM task_prompt_pool_items WHERE task_id = ?").get(root.id) as { queue_seq: number }).queue_seq;
    expect(() => store.createTaskFlow("cto", { parentId: root.id, stages: [{ name: "绕过", objective: "不允许", tasks: [task("A", "eng-a")] }] }))
      .toThrow(/required Boss-participating task meeting/);

    const tick = store.queueTaskPromptTick("2030-01-01T02:00:00.000Z");
    const prompt = store.createTaskPromptDispatch(tick.id, "cto", false);
    expect(prompt.prompt).toContain("company_meeting_request");
    store.finishTaskPromptDispatch(prompt.id, { status: "canceled", error: "prompt inspection" });
    expect((store.db.prepare("SELECT queue_seq FROM task_prompt_pool_items WHERE task_id = ?").get(root.id) as { queue_seq: number }).queue_seq).toBe(originalSequence);

    expect(() => store.requestMeeting("cto", {
      type: "task", title: "不完整会议", agenda: "拆解", parentTaskId: root.id,
      participants: [{ agentId: "eng-a", role: "worker" }], bossParticipates: true,
    })).toThrow(/every active direct report/);
    const meeting = store.requestMeeting("cto", {
      type: "task", title: "正式任务拆解会", agenda: "形成阶段流", parentTaskId: root.id,
      participants: [{ agentId: "eng-a", role: "worker" }, { agentId: "eng-b", role: "worker" }], bossParticipates: true,
    }).meeting;
    expect(store.readTask("boss", root.id, false).taskMeetingRequirement).toMatchObject({ status: "active", meetingId: meeting.id });
    expect(() => store.requestMeeting("cto", {
      type: "task", title: "重复会议", agenda: "重复", parentTaskId: root.id,
      participants: [{ agentId: "eng-a", role: "worker" }, { agentId: "eng-b", role: "worker" }], bossParticipates: true,
    })).toThrow(/already open/);

    store.startMeetingByBoss(meeting.id);
    store.setMeetingTaskDrafts("cto", meeting.id, [
      { name: "阶段一", objective: "并行实现", tasks: [task("A", "eng-a"), task("B", "eng-b")] },
      { name: "阶段二", objective: "验证", tasks: [task("C", "eng-a")] },
    ]);
    store.endMeeting("cto", meeting.id, "形成两阶段任务流");
    store.approveMeetingEndByBoss(meeting.id);
    const detail = store.readTask("boss", root.id, false);
    expect(detail.taskMeetingRequirement).toMatchObject({ status: "fulfilled", meetingId: meeting.id });
    expect(detail.childFlow?.stages.map((stage) => ({ name: stage.name, status: stage.status }))).toEqual([
      { name: "阶段一", status: "active" },
      { name: "阶段二", status: "waiting" },
    ]);
  });

  it("restores an unfulfilled meeting requirement after Boss rejects the meeting", () => {
    const root = store.createRootTask({ ...task("重开任务会", "cto"), requireTaskMeeting: true });
    const meeting = store.requestMeeting("cto", {
      type: "task", title: "准备不足的任务会", agenda: "拆解", parentTaskId: root.id,
      participants: [{ agentId: "eng-a", role: "worker" }, { agentId: "eng-b", role: "worker" }], bossParticipates: true,
    }).meeting;
    store.rejectMeetingByBoss(meeting.id, "材料不足，重新准备");
    expect(store.readTask("boss", root.id, false).taskMeetingRequirement).toMatchObject({ status: "required", meetingId: null });
    const tick = store.queueTaskPromptTick("2030-01-01T02:20:00.000Z");
    const prompt = store.createTaskPromptDispatch(tick.id, "cto", false);
    expect(prompt.prompt).toContain("实际调用 company_meeting_request");
    expect(prompt.prompt).not.toContain("不要重复创建会议");
  });

  it("appends or replaces only waiting stages, keeps retired history, and supports a nested child flow", () => {
    const root = store.createRootTask({ ...task("可扩展任务流", "cto") });
    const original = store.createTaskFlow("cto", {
      parentId: root.id,
      stages: [
        { name: "活动阶段", objective: "先完成 A", tasks: [task("A", "eng-a")] },
        { name: "旧等待阶段", objective: "稍后完成 B", tasks: [task("B", "eng-b")] },
      ],
    });
    const aId = original.stages[0]!.taskIds[0]!;
    const bId = original.stages[1]!.taskIds[0]!;
    store.startTask("cto", root.id);
    const appended = store.updateTaskFlow("cto", {
      parentId: root.id,
      expectedRevision: 1,
      operation: "append",
      stages: [{ name: "追加阶段", objective: "最后完成 C", tasks: [task("C", "eng-a")] }],
      reason: "补充集成阶段",
    });
    expect(appended.revision).toBe(2);
    expect(() => store.updateTaskFlow("cto", {
      parentId: root.id, expectedRevision: 1, operation: "append",
      stages: [{ name: "冲突阶段", objective: "不会写入", tasks: [task("冲突", "eng-a")] }], reason: "旧修订",
    })).toThrow(/revision conflict/);
    const appendedTaskId = appended.stages.at(-1)!.taskIds[0]!;
    const replaced = store.updateTaskFlow("cto", {
      parentId: root.id,
      expectedRevision: 2,
      operation: "replace_waiting",
      stages: [{ name: "新等待阶段", objective: "替换未来范围", tasks: [task("D", "eng-b")] }],
      reason: "未来范围调整",
    });
    expect(replaced.revision).toBe(3);
    expect(replaced.stages.filter((stage) => stage.status === "retired")).toHaveLength(2);
    const dId = replaced.stages.find((stage) => stage.name === "新等待阶段")!.taskIds[0]!;
    expect(store.readTask("boss", bId, false).availability).toBe("retired");
    expect(store.readTask("boss", appendedTaskId, false).availability).toBe("retired");
    expect(store.listTasks("eng-b").map((item) => item.id)).not.toContain(bId);

    const nested = store.createTaskFlow("eng-a", {
      parentId: aId,
      stages: [{ name: "A 的内部阶段", objective: "开发最小单元", tasks: [task("A1", "dev-a")] }],
    });
    const a1Id = nested.stages[0]!.taskIds[0]!;
    expect(store.taskPromptPoolSummary().queues.find((queue) => queue.memberId === "eng-a")?.items.map((item) => item.taskId)).not.toContain(aId);
    store.startTask("dev-a", a1Id);
    store.submitTask("dev-a", a1Id, "A1 完成", PROOF, VERIFIED_GIT);
    accept("eng-a", a1Id);
    expect(store.taskPromptPoolSummary().queues.find((queue) => queue.memberId === "eng-a")?.items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ taskId: aId, kind: "execution" })]));
    store.startTask("eng-a", aId);
    store.submitTask("eng-a", aId, "A 集成完成", PROOF, VERIFIED_GIT);
    accept("cto", aId);
    expect(store.readTask("boss", dId, false).availability).toBe("active");
    store.startTask("eng-b", dId);
    store.submitTask("eng-b", dId, "D 完成", PROOF, VERIFIED_GIT);
    accept("cto", dId);
    expect(store.readTask("boss", root.id, false).childCounts).toMatchObject({ total: 2, closed: 2, active: 0 });
    expect(store.taskPromptPoolSummary().queues.find((queue) => queue.memberId === "cto")?.items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ taskId: root.id, kind: "execution" })]));
  });
});

describe("personal task prompt countdowns", () => {
  it("uses level defaults, supports Boss overrides, pauses across the work-window boundary, and resets without moving a busy head", () => {
    const root = store.createRootTask({ ...task("倒计时任务", "cto") });
    const start = Date.parse("2026-08-07T09:55:00.000Z"); // 17:55 Asia/Shanghai
    const overridden = store.setTaskPromptInterval("cto", 10, start);
    expect(overridden).toMatchObject({ level: 1, defaultIntervalMinutes: 10, intervalMinutes: 10 });
    expect(overridden.nextDueAt).toBe("2026-08-08T00:05:00.000Z");
    expect(addShanghaiWorkMinutes(start, 10, 8, 17)).toBe("2026-08-08T00:05:00.000Z");
    expect(store.taskPromptPoolSummary(start).queues.find((queue) => queue.memberId === "eng-a"))
      .toMatchObject({ level: 2, defaultIntervalMinutes: 20, intervalMinutes: 20, intervalOverrideMinutes: null });

    const sequence = (store.db.prepare("SELECT queue_seq FROM task_prompt_pool_items WHERE task_id = ?").get(root.id) as { queue_seq: number }).queue_seq;
    const busy = store.createTaskPromptCycleDispatch("cto", true, "main session is active", Date.parse(overridden.nextDueAt!));
    expect(busy).toMatchObject({ claimed: false, status: "skipped_busy" });
    expect((store.db.prepare("SELECT queue_seq FROM task_prompt_pool_items WHERE task_id = ?").get(root.id) as { queue_seq: number }).queue_seq).toBe(sequence);
    const summary = store.taskPromptPoolSummary(Date.parse(overridden.nextDueAt!));
    expect(summary.queues.find((queue) => queue.memberId === "cto")).toMatchObject({
      intervalMinutes: 10,
      nextDueAt: "2026-08-08T00:15:00.000Z",
      lastDispatch: { status: "skipped_busy" },
    });

    const restored = store.setTaskPromptInterval("cto", null, Date.parse("2026-08-08T00:06:00.000Z"));
    expect(restored).toMatchObject({ intervalOverrideMinutes: null, intervalMinutes: 10, nextDueAt: "2026-08-08T00:16:00.000Z" });
  });

  it("does not backfill an offline due point and records a skipped cycle before restarting a full interval", () => {
    store.createRootTask({ ...task("离线倒计时", "cto") });
    const startedAt = Date.parse("2026-08-07T02:00:00.000Z");
    const dueAt = store.setTaskPromptInterval("cto", 10, startedAt).nextDueAt!;
    const restartedAt = Date.parse("2026-08-07T02:12:00.000Z");
    expect(store.recoverOverdueTaskPromptSchedules(restartedAt)).toBe(1);
    expect(store.taskPromptPoolSummary(restartedAt).queues.find((queue) => queue.memberId === "cto")).toMatchObject({
      nextDueAt: "2026-08-07T02:22:00.000Z",
      lastDispatch: { status: "skipped_offline", scheduledAt: dueAt },
    });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM task_prompt_ticks").get()).toMatchObject({ count: 0 });
  });
});
