import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CompanyOsStore } from "../src/store.js";
import { resolveConfig } from "../src/types.js";

const AGENTS = ["main", "cto", "eng-a", "eng-b", "dev-a", "dev-b", "advisor", "new-hire"];
const PROOF = [{ type: "proof" as const, label: "tests", command: "npm test" }];

let tempDir: string;
let databasePath: string;
let store: CompanyOsStore;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "company-os-test-"));
  databasePath = path.join(tempDir, "company-os.sqlite");
  store = openStore();
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function openStore() {
  return new CompanyOsStore({
    databasePath,
    allowedAgentIds: AGENTS,
    config: resolveConfig(undefined),
  });
}

function addOrg() {
  store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
  store.addMember("main", { agentId: "eng-a", name: "高工 A", title: "高级工程师", managerId: "cto" });
  store.addMember("main", { agentId: "eng-b", name: "高工 B", title: "高级工程师", managerId: "cto" });
  store.addMember("main", { agentId: "dev-a", name: "工程师 A", title: "工程师", managerId: "eng-a" });
  store.addMember("main", { agentId: "dev-b", name: "工程师 B", title: "工程师", managerId: "eng-b" });
  store.addMember("main", { agentId: "advisor", name: "顾问", title: "技术顾问", managerId: "main" });
}

function taskFields(title: string) {
  return { title, description: `${title} 说明`, acceptanceCriteria: `${title} 验收标准` };
}

describe("organization", () => {
  it("seeds Boss and main, rejects unknown agents, non-main writes, and cycles", () => {
    expect(store.listMembers().map((member) => member.id)).toEqual(["boss", "main"]);
    expect(() => store.addMember("cto", { agentId: "cto", name: "CTO", title: "CTO", managerId: "boss" }))
      .toThrow(/only agent main/);
    expect(() => store.addMember("main", { agentId: "ghost", name: "Ghost", title: "Ghost", managerId: "boss" }))
      .toThrow(/does not exist/);
    store.addMember("main", { agentId: "cto", name: "CTO", title: "CTO", managerId: "main" });
    expect(() => store.updateMember("main", "main", { managerId: "cto" }, "bad cycle")).toThrow(/cycle/);
  });

  it("does not change or deactivate members while open work exists", () => {
    addOrg();
    store.createRootTask({ ...taskFields("战略目标"), assigneeId: "cto" });
    expect(() => store.updateMember("main", "cto", { managerId: "main" }, "move")).toThrow(/open work/);
    expect(() => store.deactivateMember("main", "cto", "leave")).toThrow(/open work/);
  });
});

describe("hierarchical tasks", () => {
  it("rejects agent roots, cross-level delegation, empty proof, and cascade cancellation", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("战略目标"), assigneeId: "cto" });
    expect(() => store.createChildTask("eng-a", { ...taskFields("孤立"), parentId: root.id, assigneeId: "dev-a" })).toThrow(/parent task assignee/);
    expect(() => store.createChildTask("cto", { ...taskFields("跨级"), parentId: root.id, assigneeId: "dev-a" })).toThrow(/direct report/);
    const child = store.createChildTask("cto", { ...taskFields("子方向"), parentId: root.id, assigneeId: "eng-a" });
    store.startTask("eng-a", child.id);
    expect(() => store.submitTask("eng-a", child.id, "done", [])).toThrow(/proof or artifact/);
    expect(() => store.cancelTask("boss", root.id, "stop all")).toThrow(/cascade cancellation/);
  });

  it("closes a three-level tree strictly from leaves upward", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("根任务"), assigneeId: "cto" });
    const branch = store.createChildTask("cto", { ...taskFields("二级任务"), parentId: root.id, assigneeId: "eng-a" });
    const leaf = store.createChildTask("eng-a", { ...taskFields("三级任务"), parentId: branch.id, assigneeId: "dev-a" });
    store.startTask("cto", root.id);
    store.startTask("eng-a", branch.id);
    store.startTask("dev-a", leaf.id);
    expect(() => store.submitTask("eng-a", branch.id, "too soon", PROOF)).toThrow(/child tasks/);
    expect(() => store.submitTask("cto", root.id, "too soon", PROOF)).toThrow(/child tasks/);

    store.submitTask("dev-a", leaf.id, "leaf complete", PROOF);
    store.reviewTask("eng-a", leaf.id, "accept", "verified");
    store.submitTask("eng-a", branch.id, "branch complete", PROOF);
    store.reviewTask("cto", branch.id, "accept");
    store.submitTask("cto", root.id, "root complete", PROOF);
    store.reviewTask("boss", root.id, "accept", "company objective reached");

    expect(store.listTasks("boss").map((task) => task.status)).toEqual(["closed", "closed", "closed"]);
    expect(() => store.startTask("cto", root.id)).toThrow(/assigned tasks/);
  });

  it("keeps blocked and stale as risks and permits parent review after an audited child cancellation", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("根任务"), assigneeId: "cto" });
    const blocked = store.createChildTask("cto", { ...taskFields("阻塞分支"), parentId: root.id, assigneeId: "eng-a" });
    const canceled = store.createChildTask("cto", { ...taskFields("取消分支"), parentId: root.id, assigneeId: "eng-b" });
    store.startTask("cto", root.id);
    store.blockTask("eng-a", blocked.id, "waiting dependency");
    expect(store.readTask("boss", root.id, false).status).toBe("in_progress");
    expect(store.readTask("boss", root.id, false).risks.blockedDescendants).toBe(1);
    store.unblockTask("cto", blocked.id, "dependency ready");
    store.submitTask("eng-a", blocked.id, "done", PROOF);
    store.reviewTask("cto", blocked.id, "accept");
    store.cancelTask("cto", canceled.id, "scope removed");
    const rootView = store.readTask("boss", root.id, false);
    expect(rootView.childCounts.canceled).toBe(1);
    store.submitTask("cto", root.id, "done with canceled scope disclosed", PROOF);
    expect(store.readTask("boss", root.id, false).status).toBe("review");
  });

  it("versions revisions and derives stale without changing status", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("版本任务"), assigneeId: "cto" });
    store.reviseTask("boss", root.id, { title: "版本任务 v2" }, "scope clarified");
    store.db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?").run(new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString(), root.id);
    const view = store.readTask("boss", root.id, false);
    expect(view.revision).toBe(2);
    expect(view.versions).toHaveLength(2);
    expect(view.risks.stale).toBe(true);
    expect(view.status).toBe("assigned");
  });

  it("surfaces inbox changes without marking them read and supports reject/resubmit", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("Inbox 任务"), assigneeId: "cto" });
    expect(store.inbox("cto").assignedOrChangedTasks.map((task) => task.id)).toContain(root.id);
    expect(store.inbox("cto").assignedOrChangedTasks.map((task) => task.id)).toContain(root.id);
    store.readTask("cto", root.id);
    expect(store.inbox("cto").assignedOrChangedTasks.map((task) => task.id)).not.toContain(root.id);
    store.startTask("cto", root.id);
    store.submitTask("cto", root.id, "first submission", PROOF);
    expect(store.inbox("main").tasksAwaitingReview).toHaveLength(0);
    store.reviewTask("boss", root.id, "reject", "proof is incomplete");
    expect(store.inbox("cto").assignedOrChangedTasks.map((task) => task.id)).toContain(root.id);
    store.submitTask("cto", root.id, "second submission", [{ type: "artifact", label: "report", path: "/tmp/report.md" }]);
    store.reviewTask("boss", root.id, "accept");
    expect(store.readTask("boss", root.id, false).submissions.map((item: any) => item.status)).toEqual(["accepted", "rejected"]);
  });
});

describe("notices", () => {
  it("keeps notices immutable, tracks correction/effective state, and gives new employees unread consensus", () => {
    addOrg();
    const original = store.publishNotice("main", { title: "架构基线", body: "采用方案 A" });
    store.addMember("main", { agentId: "new-hire", name: "新员工", title: "工程师", managerId: "eng-a" });
    expect(store.listNotices("new-hire", { effectiveOnly: true })[0]?.readAt).toBeNull();
    store.readNotice("new-hire", original.id);
    expect(store.listNotices("new-hire")[0]?.readAt).toBeTruthy();
    const correction = store.publishNotice("main", {
      title: "架构基线更正",
      body: "采用方案 B",
      supersedesNoticeId: original.id,
    });
    const history = store.listNotices("boss");
    expect(history.find((notice) => notice.id === original.id)?.effective).toBe(false);
    expect(history.find((notice) => notice.id === original.id)?.body).toBe("采用方案 A");
    expect(store.listNotices("boss", { effectiveOnly: true }).map((notice) => notice.id)).toEqual([correction.id]);
    expect(() => store.publishNotice("main", { title: "二次更正", body: "C", supersedesNoticeId: original.id }))
      .toThrow(/only be directly superseded once/);
  });
});

describe("meeting room", () => {
  it("waits for Boss to start and requires Boss approval before a direct-participation meeting can end", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("Boss 参会父任务"), assigneeId: "cto" });
    const requested = store.requestMeeting("cto", {
      type: "task",
      title: "Boss 直接参会大会",
      agenda: "与 Boss 一起确定任务",
      parentTaskId: root.id,
      participants: [{ agentId: "eng-a", role: "worker" }],
      bossParticipates: true,
    });

    expect(requested.meeting.status).toBe("active");
    expect(requested.meeting.awaitingBossStart).toBe(true);
    expect(requested.advance.schedule).toBeUndefined();
    expect(store.pendingMeetingEmailNotifications().map((item) => item.kind)).toEqual(["created", "room_entered"]);
    expect(() => store.speakMeeting("cto", requested.meeting.id, "提前开会")).toThrow(/waiting for Boss/);

    store.db.prepare("UPDATE meetings SET waiting_on_host_since = ? WHERE id = ?")
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), requested.meeting.id);
    expect(store.sweepMeetingTimeouts(10 * 60 * 1000, 30 * 60 * 1000)).toEqual([]);
    expect(store.meetingView(requested.meeting.id).status).toBe("active");

    const start = store.startMeetingByBoss(requested.meeting.id);
    expect(start.schedule?.agentId).toBe("cto");
    expect(store.meetingView(requested.meeting.id).awaitingBossStart).toBe(false);
    store.setMeetingTaskDrafts("cto", requested.meeting.id, [{ ...taskFields("执行任务"), assigneeId: "eng-a" }]);

    const hostResult = store.endMeeting("cto", requested.meeting.id, "任务已经分配，请 Boss 批准结束", false);
    expect(hostResult.meeting.status).toBe("active");
    expect(hostResult.meeting.endRequestedSummary).toBe("任务已经分配，请 Boss 批准结束");
    expect(hostResult.createdTasks).toHaveLength(0);
    expect(store.listTasks("boss")).toHaveLength(1);
    expect(() => store.endMeeting("cto", requested.meeting.id, "再次申请", false)).toThrow(/waiting for Boss/);

    const approved = store.approveMeetingEndByBoss(requested.meeting.id);
    expect(approved.meeting.status).toBe("completed");
    expect(approved.createdTasks).toHaveLength(1);
    expect(approved.notice?.kind).toBe("meeting_report");
    expect(approved.meeting.audit.some((event: any) => event.actorId === "boss" && event.action === "meeting.completed")).toBe(true);
  });

  it("lets Boss reject an end request and returns control to the host", () => {
    addOrg();
    const meeting = store.requestMeeting("eng-a", {
      type: "discussion",
      title: "需要继续讨论",
      agenda: "由 Boss 判断是否结束",
      participants: [],
      bossParticipates: true,
    }).meeting;
    store.startMeetingByBoss(meeting.id);
    store.endMeeting("eng-a", meeting.id, "初步结论", false);

    const advance = store.rejectMeetingEndByBoss(meeting.id, "风险还没有讨论清楚");
    expect(advance.schedule?.agentId).toBe("eng-a");
    const resumed = store.meetingView(meeting.id);
    expect(resumed.endRequestedAt).toBeNull();
    expect(resumed.messages.at(-1)?.body).toContain("风险还没有讨论清楚");
  });

  it("serializes meetings and processes Boss @ intervention before returning to host", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("父任务"), assigneeId: "cto" });
    const first = store.requestMeeting("cto", {
      type: "task", title: "战略拆解会", agenda: "拆成工程任务", parentTaskId: root.id,
      participants: [{ agentId: "eng-a", role: "worker" }, { agentId: "advisor", role: "advisor" }],
    });
    const second = store.requestMeeting("eng-a", {
      type: "discussion", title: "技术讨论", agenda: "讨论实现", participants: [{ agentId: "dev-a", role: "advisor" }],
    });
    expect(first.meeting.status).toBe("active");
    expect(second.meeting.status).toBe("queued");
    expect(store.listMeetings("boss").filter((meeting) => meeting.status === "active")).toHaveLength(1);
    expect(() => store.speakMeeting("advisor", first.meeting.id, "抢话")).toThrow(/current speaker/);

    store.delegateMeeting("cto", first.meeting.id, "eng-a", "如何拆解？");
    store.bossInterject(first.meeting.id, "请顾问先评价风险", "advisor");
    const afterWorker = store.speakMeeting("eng-a", first.meeting.id, "先实现核心模块");
    expect(afterWorker.schedule?.agentId).toBe("advisor");
    expect(store.meetingView(first.meeting.id).currentTurn?.speakerId).toBe("advisor");
    const afterAdvisor = store.speakMeeting("advisor", first.meeting.id, "风险可控");
    expect(afterAdvisor.schedule?.agentId).toBe("cto");
    expect(store.meetingView(first.meeting.id).currentTurn).toBeNull();
  });

  it("atomically rejects incomplete drafts, then creates tasks, report, and advances queue", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("父任务"), assigneeId: "cto" });
    const meeting = store.requestMeeting("cto", {
      type: "task", title: "任务大会", agenda: "派发任务", parentTaskId: root.id,
      participants: [{ agentId: "eng-a", role: "worker" }, { agentId: "eng-b", role: "worker" }],
    }).meeting;
    store.requestMeeting("eng-a", { type: "discussion", title: "下一场", agenda: "排队", participants: [] });
    store.setMeetingTaskDrafts("cto", meeting.id, [{ ...taskFields("仅 A"), assigneeId: "eng-a" }]);
    expect(() => store.endMeeting("cto", meeting.id, "", false)).toThrow(/summary/);
    expect(() => store.endMeeting("cto", meeting.id, "总结", false)).toThrow(/every worker/);
    expect(store.listTasks("boss")).toHaveLength(1);
    expect(store.meetingView(meeting.id).status).toBe("active");

    store.setMeetingTaskDrafts("cto", meeting.id, [
      { ...taskFields("A 任务"), assigneeId: "eng-a" },
      { ...taskFields("B 任务"), assigneeId: "eng-b" },
    ]);
    const result = store.endMeeting("cto", meeting.id, "确定两条执行路线", false);
    expect(result.createdTasks).toHaveLength(2);
    expect(result.notice?.kind).toBe("meeting_report");
    expect(result.meeting.status).toBe("completed");
    expect(result.advance.activatedMeetingId).toBeTruthy();
    expect(store.listMeetings("boss").filter((item) => item.status === "active")).toHaveLength(1);
  });

  it("times out a participant back to host and times out an idle host without publishing", () => {
    addOrg();
    const meeting = store.requestMeeting("eng-a", {
      type: "discussion", title: "超时测试", agenda: "test", participants: [{ agentId: "dev-a", role: "advisor" }],
    }).meeting;
    store.delegateMeeting("eng-a", meeting.id, "dev-a", "请发言");
    store.db.prepare("UPDATE meeting_turns SET started_at = ? WHERE meeting_id = ?")
      .run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), meeting.id);
    const participantAdvance = store.sweepMeetingTimeouts(10 * 60 * 1000, 30 * 60 * 1000);
    expect(participantAdvance[0]?.schedule?.agentId).toBe("eng-a");
    expect(store.meetingView(meeting.id).status).toBe("active");
    store.db.prepare("UPDATE meetings SET waiting_on_host_since = ? WHERE id = ?")
      .run(new Date(Date.now() - 40 * 60 * 1000).toISOString(), meeting.id);
    store.sweepMeetingTimeouts(10 * 60 * 1000, 30 * 60 * 1000);
    expect(store.meetingView(meeting.id).status).toBe("timed_out");
    expect(store.listNotices("boss")).toHaveLength(0);
  });

  it("persists active meeting, drafts, and turns across restart", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("父任务"), assigneeId: "cto" });
    const meeting = store.requestMeeting("cto", {
      type: "task", title: "恢复测试", agenda: "restart", parentTaskId: root.id,
      participants: [{ agentId: "eng-a", role: "worker" }],
    }).meeting;
    store.setMeetingTaskDrafts("cto", meeting.id, [{ ...taskFields("持久草案"), assigneeId: "eng-a" }]);
    store.delegateMeeting("cto", meeting.id, "eng-a", "恢复后回答");
    store.close();
    store = openStore();
    const recovered = store.meetingView(meeting.id);
    expect(recovered.status).toBe("active");
    expect(recovered.taskDrafts).toHaveLength(1);
    expect(recovered.currentTurn?.speakerId).toBe("eng-a");
    expect(store.recoveryAdvance()?.schedule?.agentId).toBe("eng-a");
  });

  it("runs the complete Boss → CTO → senior → engineer → bottom-up closure rehearsal", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("交付 Company OS"), assigneeId: "cto" });
    const strategy = store.requestMeeting("cto", {
      type: "task", title: "高层战略会", agenda: "分解技术方向", parentTaskId: root.id,
      participants: [{ agentId: "eng-a", role: "worker" }],
    }).meeting;
    store.setMeetingTaskDrafts("cto", strategy.id, [{ ...taskFields("任务引擎"), assigneeId: "eng-a" }]);
    const strategyResult = store.endMeeting("cto", strategy.id, "由高工负责任务引擎", false);
    const seniorTask = strategyResult.createdTasks[0]!;
    const workshop = store.requestMeeting("eng-a", {
      type: "task", title: "任务引擎小会", agenda: "分解实现", parentTaskId: seniorTask.id,
      participants: [{ agentId: "dev-a", role: "worker" }],
    }).meeting;
    store.setMeetingTaskDrafts("eng-a", workshop.id, [{ ...taskFields("状态机实现"), assigneeId: "dev-a" }]);
    const workshopResult = store.endMeeting("eng-a", workshop.id, "工程师实现状态机", false);
    const leaf = workshopResult.createdTasks[0]!;

    store.startTask("dev-a", leaf.id);
    store.submitTask("dev-a", leaf.id, "状态机测试通过", PROOF);
    store.reviewTask("eng-a", leaf.id, "accept");
    store.startTask("eng-a", seniorTask.id);
    store.submitTask("eng-a", seniorTask.id, "任务引擎完成", PROOF);
    store.reviewTask("cto", seniorTask.id, "accept");
    store.startTask("cto", root.id);
    store.submitTask("cto", root.id, "Company OS 已交付", PROOF);
    store.reviewTask("boss", root.id, "accept");

    expect(store.listTasks("boss").every((task) => task.status === "closed")).toBe(true);
    expect(store.listNotices("boss").filter((notice) => notice.kind === "meeting_report")).toHaveLength(2);
  });
});
