import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CompanyOsStore } from "../src/store.js";
import { resolveConfig } from "../src/types.js";

const AGENTS = ["main", "jia-goushi", "cto", "eng-a", "eng-b", "dev-a", "dev-b", "advisor", "new-hire"];
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

function deliverAllMeetingCloseouts() {
  let advance: Record<string, unknown> = {};
  while (true) {
    const dispatch = store.claimNextMeetingCloseoutDispatch();
    if (!dispatch) return advance;
    const completed = store.completeMeetingCloseoutDispatch(dispatch.id);
    if (completed.activatedMeetingId || completed.hostDispatchId) advance = completed;
  }
}

describe("organization", () => {
  it("seeds Boss and main, rejects unknown agents, non-main writes, and cycles", () => {
    expect(store.listMembers().map((member) => member.id)).toEqual(["boss", "main"]);
    expect(() => store.addMember("cto", { agentId: "cto", name: "CTO", title: "CTO", managerId: "boss" }))
      .toThrow(/only organization admin main/);
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

  it("queues an idempotent Boss reminder, tracks delivery, and accepts blocked progress updates", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("催办测试"), assigneeId: "cto" });

    const queued = store.queueTaskReminderByBoss(root.id);
    const duplicate = store.queueTaskReminderByBoss(root.id);
    expect(duplicate.id).toBe(queued.id);
    expect(queued).toMatchObject({
      taskId: root.id,
      targetMemberId: "cto",
      targetAgentId: "cto",
      status: "pending",
    });
    expect(queued.prompt).toContain("Boss 正在跟进任务「催办测试」");
    expect(queued.prompt).toContain("company_task_read");
    expect(queued.prompt).toContain("company_task_progress");
    expect(queued.prompt).toContain("company_task_submit");
    expect(queued.prompt).toContain("不要只回复进度说明");

    const claimed = store.claimNextTaskDispatch();
    expect(claimed).toMatchObject({ id: queued.id, status: "running", attempts: 1 });
    expect(store.completeTaskDispatch(queued.id)).toBe(true);
    expect(store.readTask("boss", root.id, false).reminderDispatch).toMatchObject({ status: "succeeded" });
    expect(store.listAudit("task", root.id).map((item) => item.action)).toEqual(expect.arrayContaining([
      "task.reminder_queued",
      "task.reminder_delivered",
    ]));

    store.blockTask("cto", root.id, "等待依赖");
    store.addTaskProgress("cto", root.id, "已确认依赖将在今晚恢复");
    expect(store.readTask("boss", root.id, false)).toMatchObject({
      status: "blocked",
      progress: [expect.objectContaining({ body: "已确认依赖将在今晚恢复" })],
    });
  });

  it("enforces issuer-only review and durably notifies each task assignee", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("根任务验收通知"), assigneeId: "cto" });
    const child = store.createChildTask("cto", { ...taskFields("二级任务验收通知"), parentId: root.id, assigneeId: "eng-a" });
    store.startTask("cto", root.id);
    store.startTask("eng-a", child.id);
    store.submitTask("eng-a", child.id, "first child submission", PROOF);

    expect(() => store.reviewTask("boss", child.id, "accept")).toThrow(/only the task issuer/);
    const rejected = store.reviewTask("cto", child.id, "reject", "测试证据不完整");
    expect(rejected).toMatchObject({
      status: "in_progress",
      reviewNotificationDispatch: {
        kind: "review_rejected",
        targetMemberId: "eng-a",
        status: "pending",
      },
    });
    store.submitTask("eng-a", child.id, "second child submission", PROOF);
    const accepted = store.reviewTask("cto", child.id, "accept", "证据完整");
    expect(accepted).toMatchObject({
      status: "closed",
      reviewNotificationDispatch: {
        kind: "review_accepted",
        targetMemberId: "eng-a",
        status: "pending",
      },
    });

    const rejectedDispatch = store.claimNextTaskDispatch();
    expect(rejectedDispatch).toMatchObject({ kind: "review_rejected", targetAgentId: "eng-a" });
    expect(rejectedDispatch?.prompt).toContain("已由 CTO（首席技术官） 驳回验收");
    expect(rejectedDispatch?.prompt).toContain("验收意见：测试证据不完整");
    expect(rejectedDispatch?.prompt).toContain("company_task_progress");
    expect(store.failTaskDispatch(rejectedDispatch!.id, "temporary failure")).toBe(true);
    const rejectedRetry = store.claimNextTaskDispatch();
    expect(rejectedRetry).toMatchObject({ id: rejectedDispatch!.id, attempts: 2 });
    expect(store.completeTaskDispatch(rejectedRetry!.id)).toBe(true);

    const acceptedDispatch = store.claimNextTaskDispatch();
    expect(acceptedDispatch).toMatchObject({ kind: "review_accepted", targetAgentId: "eng-a" });
    expect(acceptedDispatch?.prompt).toContain("验收通过");
    expect(acceptedDispatch?.prompt).toContain("无需再次提交或修改该任务");
    expect(store.completeTaskDispatch(acceptedDispatch!.id)).toBe(true);

    store.submitTask("cto", root.id, "root submission", PROOF);
    expect(() => store.reviewTask("cto", root.id, "accept")).toThrow(/only the task issuer/);
    const closedRoot = store.reviewTask("boss", root.id, "accept", "目标达成");
    expect(closedRoot.reviewNotificationDispatch).toMatchObject({
      kind: "review_accepted",
      targetMemberId: "cto",
    });
    const rootDispatch = store.claimNextTaskDispatch();
    expect(rootDispatch).toMatchObject({ kind: "review_accepted", targetAgentId: "cto" });
    expect(rootDispatch?.prompt).toContain("已由 Boss 验收通过");
    expect(store.listAudit("task", child.id).map((event) => event.action)).toEqual(expect.arrayContaining([
      "task.review_notification_queued",
      "task.review_notification_retry",
      "task.review_notification_delivered",
    ]));
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
  it("builds named incremental context and advances a speaker watermark only after successful speech", () => {
    addOrg();
    const meeting = store.requestMeeting("cto", {
      type: "discussion",
      title: "增量上下文测试",
      agenda: "验证水位",
      participants: [{ agentId: "eng-a", role: "advisor" }],
    }).meeting;

    const first = store.delegateMeeting("cto", meeting.id, "eng-a", "给出第一轮判断");
    expect(first.fromSequence).toBe(0);
    expect(first.prompt).toContain("主持人：CTO（cto）");
    expect(first.prompt).toContain("你的身份：高工 A（eng-a）");
    expect(first.prompt).toContain("会议室已开放");
    store.speakMeeting("eng-a", meeting.id, "第一轮意见", first.turnId);

    store.speakMeeting("cto", meeting.id, "主持人追加问题背景");
    const second = store.delegateMeeting("cto", meeting.id, "eng-a", "给出第二轮判断");
    expect(second.fromSequence).toBeGreaterThan(0);
    expect(second.prompt).toContain("CTO（cto）：\n主持人追加问题背景");
    expect(second.prompt).not.toContain("会议室已开放");
    expect(second.prompt).not.toContain("第一轮意见");
  });

  it("queues receiver-perspective session history with real message and round numbers", () => {
    addOrg();
    const meeting = store.requestMeeting("cto", {
      type: "discussion",
      title: "Session 会议记录回写",
      agenda: "验证你视角和严格编号",
      participants: [{ agentId: "eng-a", role: "advisor" }],
    }).meeting;
    const hostSession = {
      agentId: "cto",
      sessionKey: "agent:cto:main",
      sessionId: "session-cto-main",
      toolCallId: "delegate-call-1",
    };
    const turn = store.delegateMeeting("cto", meeting.id, "eng-a", "请检查源码后给出判断", hostSession);
    const hostAppend = store.claimNextSessionContextAppend({
      agentId: "cto",
      sessionKey: "agent:cto:main",
      sessionId: "session-cto-main",
    });
    expect(hostAppend).toMatchObject({
      messageSequence: turn.messageSequence,
      roundNumber: 1,
      recordKind: "delegate",
      formattedText: "【消息 #000002｜第 1 轮｜点名】\n你（CTO） @高工 A：\n请检查源码后给出判断",
    });

    const speakerSession = {
      agentId: "eng-a",
      sessionKey: "agent:eng-a:main",
      sessionId: "session-eng-a-main",
      toolCallId: "speak-call-1",
    };
    store.speakMeeting("eng-a", meeting.id, "我已实际检查源码并确认接口行为", turn.turnId, speakerSession);
    expect(store.db.prepare(`
      SELECT sequence FROM meeting_context_watermarks WHERE meeting_id = ? AND member_id = 'eng-a'
    `).get(meeting.id)).toBeUndefined();
    const speakerAppend = store.claimNextSessionContextAppend({
      agentId: "eng-a",
      sessionKey: "agent:eng-a:main",
      sessionId: "session-eng-a-main",
    });
    expect(speakerAppend).toMatchObject({
      roundNumber: 1,
      recordKind: "speech",
      formattedText: "【消息 #000003｜第 1 轮｜发言】\n你（高工 A）：\n我已实际检查源码并确认接口行为",
    });
    store.completeSessionContextAppend(speakerAppend!.id, "transcript-message-1");
    expect(store.db.prepare(`
      SELECT sequence FROM meeting_context_watermarks WHERE meeting_id = ? AND member_id = 'eng-a'
    `).get(meeting.id)).toMatchObject({ sequence: 3 });
  });

  it("freezes a per-member final timeline and blocks the next meeting until everyone receives it", () => {
    addOrg();
    const meeting = store.requestMeeting("cto", {
      type: "discussion",
      title: "终局同步测试",
      agenda: "确保所有人得到最终记录",
      participants: [
        { agentId: "eng-a", role: "worker" },
        { agentId: "eng-b", role: "advisor" },
      ],
    }).meeting;
    const turn = store.delegateMeeting("cto", meeting.id, "eng-a", "请先给出实现意见");
    store.speakMeeting("eng-a", meeting.id, "我建议使用持久化 outbox", turn.turnId);
    store.speakMeeting("cto", meeting.id, "主持人确认采用该方案");
    const requestedEnd = store.endMeeting("cto", meeting.id, "采用持久化终局同步并设置关会屏障", false);
    const finalized = store.finalizeDueAutomaticMeetingEnd(Date.parse(requestedEnd.meeting.autoEndAt))!;
    const queued = store.requestMeeting("eng-a", { type: "discussion", title: "下一场", agenda: "不得抢跑" }).meeting;

    expect(finalized.meeting.status).toBe("completed");
    expect(finalized.meeting.messages.at(-2)).toMatchObject({
      authorId: "cto",
      body: "【主持人最终总结】\n采用持久化终局同步并设置关会屏障",
    });
    expect(store.bossSnapshot().meetings).toMatchObject({ active: null, closing: { id: meeting.id } });
    expect(queued.status).toBe("queued");

    const dispatches: any[] = [];
    while (true) {
      const dispatch = store.claimNextMeetingCloseoutDispatch();
      if (!dispatch) break;
      dispatches.push(dispatch);
      if (dispatch.memberId === "eng-a") {
        expect(dispatch.contextFromSequence).toBeGreaterThan(0);
        expect(dispatch.prompt).not.toContain("会议室已开放");
        expect(dispatch.prompt).not.toContain("我建议使用持久化 outbox");
        expect(dispatch.prompt).toContain("主持人确认采用该方案");
        expect(dispatch.prompt).toContain("【主持人最终总结】");
        expect(dispatch.prompt).toContain("结果：正常完成");
      }
      if (dispatch.memberId === "eng-b") {
        expect(dispatch.contextFromSequence).toBe(0);
        expect(dispatch.prompt).toContain("会议室已开放");
        expect(dispatch.prompt).toContain("第 1 轮｜点名");
      }
      const advance = store.completeMeetingCloseoutDispatch(dispatch.id);
      if (dispatches.length < 3) expect(advance).toEqual({});
    }

    expect(dispatches.map((item) => item.memberId)).toEqual(["eng-a", "eng-b", "cto"]);
    expect(dispatches.map((item) => item.memberId)).not.toContain("boss");
    expect(store.meetingView(meeting.id).closeoutStatus).toMatchObject({ state: "delivered", delivered: 3, total: 3 });
    expect(store.meetingView(queued.id).status).toBe("active");
  });

  it("retries closeout delivery without advancing the member watermark", () => {
    addOrg();
    const meeting = store.requestMeeting("cto", {
      type: "discussion",
      title: "终局失败恢复",
      agenda: "失败不得释放会议室",
      participants: [{ agentId: "eng-a", role: "advisor" }],
    }).meeting;
    const requested = store.endMeeting("cto", meeting.id, "重试直到送达", false);
    store.finalizeDueAutomaticMeetingEnd(Date.parse(requested.meeting.autoEndAt));

    const first = store.claimNextMeetingCloseoutDispatch()!;
    expect(first.memberId).toBe("eng-a");
    expect(store.retryMeetingCloseoutDispatch(first.id, "temporary in_flight")).toBeTruthy();
    expect(store.db.prepare(`
      SELECT sequence FROM meeting_context_watermarks WHERE meeting_id = ? AND member_id = ?
    `).get(meeting.id, first.memberId)).toBeUndefined();

    const otherMember = store.claimNextMeetingCloseoutDispatch()!;
    expect(otherMember.memberId).toBe("cto");
    store.acknowledgeHostContext(meeting.id, "cto");
    expect(store.db.prepare(`
      SELECT sequence FROM meeting_context_watermarks WHERE meeting_id = ? AND member_id = ?
    `).get(meeting.id, "cto")).toBeUndefined();
    store.completeMeetingCloseoutDispatch(otherMember.id);
    expect(store.claimNextMeetingCloseoutDispatch()).toBeNull();

    store.db.prepare("UPDATE meeting_closeout_dispatches SET next_attempt_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), first.id);
    const retried = store.claimNextMeetingCloseoutDispatch()!;
    expect(retried).toMatchObject({ id: first.id, attempts: 2, status: "running" });
    store.recoverMeetingCloseoutDispatches();
    const recovered = store.claimNextMeetingCloseoutDispatch()!;
    expect(recovered).toMatchObject({ id: first.id, attempts: 3, status: "running" });
    store.completeMeetingCloseoutDispatch(recovered.id);
    expect(store.db.prepare(`
      SELECT sequence FROM meeting_context_watermarks WHERE meeting_id = ? AND member_id = ?
    `).get(meeting.id, first.memberId)).toMatchObject({ sequence: recovered.contextToSequence });
  });

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
    expect(requested.advance.hostDispatchId).toBeUndefined();
    expect(store.pendingMeetingEmailNotifications().map((item) => item.kind)).toEqual(["created", "room_entered"]);
    expect(() => store.speakMeeting("cto", requested.meeting.id, "提前开会")).toThrow(/waiting for Boss/);

    store.db.prepare("UPDATE meetings SET waiting_on_host_since = ? WHERE id = ?")
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), requested.meeting.id);
    expect(store.sweepMeetingTimeouts(10 * 60 * 1000, 30 * 60 * 1000)).toEqual([]);
    expect(store.meetingView(requested.meeting.id).status).toBe("active");

    const start = store.startMeetingByBoss(requested.meeting.id);
    expect(start.hostDispatchId).toBeTruthy();
    expect(store.meetingView(requested.meeting.id).hostDispatchStatus).toMatchObject({ targetAgentId: "cto", status: "pending" });
    expect(store.meetingView(requested.meeting.id).awaitingBossStart).toBe(false);
    const hostContext = store.buildMeetingContext(requested.meeting.id, "cto", { role: "host", instruction: "回应 Boss" });
    expect(hostContext.prompt).toContain("【消息 #000001｜系统穿插事件】\n系统：\n会议已进入会议室");
    expect(hostContext.prompt).toContain("【消息 #000002｜Boss 穿插事件】\nBoss：\n我已进入会议室，现在开始会议。");
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

  it("lets Boss reject a waiting direct-participation meeting and advances only after closeout delivery", () => {
    addOrg();
    const waiting = store.requestMeeting("cto", {
      type: "discussion",
      title: "等待 Boss 决定是否召开",
      agenda: "议题尚未成熟",
      bossParticipates: true,
    }).meeting;
    const queued = store.requestMeeting("eng-a", {
      type: "discussion",
      title: "下一场会议",
      agenda: "验证会议室推进",
      bossParticipates: false,
    }).meeting;

    const rejected = store.rejectMeetingByBoss(waiting.id, "议题准备不充分");

    expect(rejected.meeting.status).toBe("canceled");
    expect(rejected.meeting.canceledReason).toBe("Boss 拒绝：议题准备不充分");
    expect(rejected.meeting.messages.at(-1)?.body).toContain("Boss 已拒绝召开本次会议");
    expect(rejected.meeting.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: "boss", action: "meeting.rejected_by_boss", reason: "议题准备不充分" }),
    ]));
    expect(rejected.advance).toEqual({});
    expect(store.meetingView(queued.id).status).toBe("queued");
    expect(store.bossSnapshot().meetings.closing?.id).toBe(waiting.id);
    const advance = deliverAllMeetingCloseouts();
    expect(advance).toMatchObject({ activatedMeetingId: queued.id, hostDispatchId: expect.any(String) });
    expect(store.meetingView(queued.id).status).toBe("active");
    expect(() => store.startMeetingByBoss(waiting.id)).toThrow(/not active/);
  });

  it("does not let Boss reject a meeting after starting it", () => {
    addOrg();
    const meeting = store.requestMeeting("cto", {
      type: "discussion",
      title: "已经开始的会议",
      agenda: "不能再按会前拒绝",
      bossParticipates: true,
    }).meeting;
    store.startMeetingByBoss(meeting.id);

    expect(() => store.rejectMeetingByBoss(meeting.id, "临时改变主意")).toThrow(/already started/);
  });

  it("notifies invitees when a queued meeting is canceled without blocking the occupied room", () => {
    addOrg();
    const active = store.requestMeeting("cto", { type: "discussion", title: "当前会议", agenda: "继续进行" }).meeting;
    const queued = store.requestMeeting("eng-a", {
      type: "discussion",
      title: "取消的排队会",
      agenda: "不再讨论",
      participants: [{ agentId: "dev-a", role: "advisor" }],
    }).meeting;

    const canceled = store.cancelMeeting("eng-a", queued.id, "议题已在线下解决");

    expect(canceled.status).toBe("canceled");
    expect(canceled.closeoutStatus).toMatchObject({ blocksRoom: false, pending: 2, total: 2 });
    expect(store.meetingView(active.id).status).toBe("active");
    const first = store.claimNextMeetingCloseoutDispatch()!;
    expect(first).toMatchObject({ outcome: "canceled", blocksRoom: false, memberId: "dev-a" });
    expect(first.prompt).toContain("结果：已取消");
    expect(first.prompt).toContain("议题已在线下解决");
  });

  it("recovers a running host dispatch with the same durable id and never reclaims a succeeded job", () => {
    addOrg();
    const meeting = store.requestMeeting("cto", {
      type: "discussion",
      title: "主持人任务恢复",
      agenda: "验证租约恢复",
      bossParticipates: true,
    }).meeting;
    const advance = store.startMeetingByBoss(meeting.id);
    const first = store.claimNextHostDispatch();
    expect(first).toMatchObject({ id: advance.hostDispatchId, targetAgentId: "cto", status: "running", attempts: 1 });

    expect(store.recoverAgentDispatches()).toBe(1);
    expect(store.recoveryAdvance()?.hostDispatchId).toBe(first?.id);
    expect((store.db.prepare("SELECT COUNT(*) AS count FROM meeting_agent_dispatches WHERE meeting_id = ?").get(meeting.id) as any).count).toBe(1);
    const recovered = store.claimNextHostDispatch();
    expect(recovered).toMatchObject({ id: first?.id, status: "running", attempts: 2 });
    const context = store.buildMeetingContext(meeting.id, "cto", { role: "host", instruction: "恢复主持" });
    store.completeHostDispatch(recovered!.id, context.toSequence);

    expect(store.claimNextHostDispatch()).toBeNull();
    expect(store.recoverAgentDispatches()).toBe(0);
    expect(store.meetingView(meeting.id).hostDispatchStatus).toMatchObject({ id: first?.id, status: "succeeded", attempts: 2 });
  });

  it("does not mistake an unrelated Boss message for verified host dispatch progress", () => {
    addOrg();
    const meeting = store.requestMeeting("cto", {
      type: "discussion",
      title: "主持人进度证据",
      agenda: "只接受主持人自己的工具操作",
      bossParticipates: true,
    }).meeting;
    const advance = store.startMeetingByBoss(meeting.id);
    const dispatch = store.claimNextHostDispatch();
    expect(dispatch?.id).toBe(advance.hostDispatchId);
    const context = store.buildMeetingContext(meeting.id, "cto", { role: "host", instruction: "开始主持" });
    store.setHostDispatchContext(dispatch!.id, context);

    store.bossInterject(meeting.id, "Boss 追加了一条消息");
    expect(store.hostDispatchHasProgress(dispatch!.id)).toBe(false);

    store.speakMeeting("cto", meeting.id, "主持人已回应 Boss");
    expect(store.hostDispatchHasProgress(dispatch!.id)).toBe(true);
  });

  it("uses the same real Agent ID for organization members and dispatch targets", () => {
    addOrg();
    const meeting = store.requestMeeting("boss", {
      type: "discussion",
      title: "成员与 Agent 同一 ID",
      agenda: "调用真实 Agent",
      hostId: "cto",
    }).meeting;

    const dispatch = store.claimNextHostDispatch();
    expect(dispatch).toMatchObject({ meetingId: meeting.id, targetMemberId: "cto", targetAgentId: "cto" });
    expect(store.meetingView(meeting.id).hostDispatchStatus).toMatchObject({ targetMemberId: "cto", targetAgentId: "cto" });
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
    expect(advance.hostDispatchId).toBeTruthy();
    expect(store.meetingView(meeting.id).hostDispatchStatus).toMatchObject({ targetAgentId: "eng-a", status: "pending" });
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

    const workerTurn = store.delegateMeeting("cto", first.meeting.id, "eng-a", "如何拆解？");
    store.bossInterject(first.meeting.id, "请顾问先评价风险", "advisor");
    expect(() => store.speakMeeting("eng-a", first.meeting.id, "错误轮次", "stale-turn")).toThrow(/does not match/);
    expect(() => store.speakMeeting("advisor", first.meeting.id, "伪造身份", workerTurn.turnId)).toThrow(/current speaker/);
    const afterWorker = store.speakMeeting("eng-a", first.meeting.id, "先实现核心模块", workerTurn.turnId);
    expect(afterWorker?.completionSource).toBe("tool");
    const bossTurn = store.nextPendingInterventionTurn(first.meeting.id);
    expect(bossTurn?.speakerId).toBe("advisor");
    expect(store.meetingView(first.meeting.id).currentTurn?.speakerId).toBe("advisor");
    const afterAdvisor = store.speakMeeting("advisor", first.meeting.id, "风险可控", bossTurn!.turnId);
    expect(afterAdvisor?.completionSource).toBe("tool");
    expect(store.nextPendingInterventionTurn(first.meeting.id)).toBeNull();
    expect(store.meetingView(first.meeting.id).currentTurn).toBeNull();
  });

  it("atomically rejects incomplete drafts, then creates tasks and report before closeout advances the queue", () => {
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
    const requestedEnd = store.endMeeting("cto", meeting.id, "确定两条执行路线", false);
    expect(requestedEnd.meeting.status).toBe("active");
    expect(requestedEnd.meeting.autoEndAt).toBeTruthy();
    expect(requestedEnd.createdTasks).toHaveLength(0);
    const result = store.finalizeDueAutomaticMeetingEnd(Date.parse(requestedEnd.meeting.autoEndAt))!;
    expect(result.createdTasks).toHaveLength(2);
    expect(result.notice?.kind).toBe("meeting_report");
    expect(result.meeting.status).toBe("completed");
    expect(result.advance).toEqual({});
    expect(store.listMeetings("boss").filter((item) => item.status === "active")).toHaveLength(0);
    expect(store.bossSnapshot().meetings.closing?.id).toBe(meeting.id);
    expect(deliverAllMeetingCloseouts().activatedMeetingId).toBeTruthy();
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
    expect(participantAdvance[0]?.hostDispatchId).toBeTruthy();
    expect(store.meetingView(meeting.id).hostDispatchStatus).toMatchObject({ targetAgentId: "eng-a", status: "pending" });
    expect(store.meetingView(meeting.id).status).toBe("active");
    store.db.prepare("UPDATE meetings SET waiting_on_host_since = ? WHERE id = ?")
      .run(new Date(Date.now() - 40 * 60 * 1000).toISOString(), meeting.id);
    store.sweepMeetingTimeouts(10 * 60 * 1000, 30 * 60 * 1000);
    expect(store.meetingView(meeting.id).status).toBe("timed_out");
    expect(store.meetingView(meeting.id).closeoutStatus).toMatchObject({ blocksRoom: true, pending: 2, total: 2 });
    expect(store.claimNextMeetingCloseoutDispatch()).toMatchObject({ outcome: "timed_out" });
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
    expect(store.recoveryAdvance()?.hostDispatchId).toBeTruthy();
    expect(store.meetingView(meeting.id).currentTurn).toBeNull();
    expect(store.meetingView(meeting.id).hostDispatchStatus).toMatchObject({ targetAgentId: "cto", status: "pending" });
  });

  it("persists a non-Boss end countdown across restart and closes only when due", () => {
    addOrg();
    const meeting = store.requestMeeting("cto", {
      type: "discussion",
      title: "普通会议倒计时",
      agenda: "一分钟后自动结束",
    }).meeting;
    const requested = store.endMeeting("cto", meeting.id, "普通会议总结", false);
    expect(Date.parse(requested.meeting.autoEndAt) - Date.parse(requested.meeting.endRequestedAt)).toBe(60_000);
    store.close();
    store = openStore();

    expect(store.nextAutomaticMeetingEnd()).toEqual({ meetingId: meeting.id, autoEndAt: requested.meeting.autoEndAt });
    expect(store.finalizeDueAutomaticMeetingEnd(Date.parse(requested.meeting.autoEndAt) - 1)).toBeNull();
    expect(store.finalizeDueAutomaticMeetingEnd(Date.parse(requested.meeting.autoEndAt))?.meeting.status).toBe("completed");
  });

  it("runs the complete Boss → CTO → senior → engineer → bottom-up closure rehearsal", () => {
    addOrg();
    const root = store.createRootTask({ ...taskFields("交付 Company OS"), assigneeId: "cto" });
    const strategy = store.requestMeeting("cto", {
      type: "task", title: "高层战略会", agenda: "分解技术方向", parentTaskId: root.id,
      participants: [{ agentId: "eng-a", role: "worker" }],
    }).meeting;
    store.setMeetingTaskDrafts("cto", strategy.id, [{ ...taskFields("任务引擎"), assigneeId: "eng-a" }]);
    const strategyEnd = store.endMeeting("cto", strategy.id, "由高工负责任务引擎", false);
    const strategyResult = store.finalizeDueAutomaticMeetingEnd(Date.parse(strategyEnd.meeting.autoEndAt))!;
    const seniorTask = strategyResult.createdTasks[0]!;
    deliverAllMeetingCloseouts();
    const workshop = store.requestMeeting("eng-a", {
      type: "task", title: "任务引擎小会", agenda: "分解实现", parentTaskId: seniorTask.id,
      participants: [{ agentId: "dev-a", role: "worker" }],
    }).meeting;
    store.setMeetingTaskDrafts("eng-a", workshop.id, [{ ...taskFields("状态机实现"), assigneeId: "dev-a" }]);
    const workshopEnd = store.endMeeting("eng-a", workshop.id, "工程师实现状态机", false);
    const workshopResult = store.finalizeDueAutomaticMeetingEnd(Date.parse(workshopEnd.meeting.autoEndAt))!;
    const leaf = workshopResult.createdTasks[0]!;
    deliverAllMeetingCloseouts();

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
