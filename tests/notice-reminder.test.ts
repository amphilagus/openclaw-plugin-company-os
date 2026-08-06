import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CompanyOsStore, nextNoticeReminderRunAt } from "../src/store.js";
import { resolveConfig } from "../src/types.js";

const AGENTS = ["main", "cto", "eng-a", "advisor", "outsider", "late-hire"];
const HALF_PAST_EIGHT = "2030-01-01T00:30:00.000Z";

let directory: string;
let databasePath: string;
let store: CompanyOsStore;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "company-os-notice-reminder-"));
  databasePath = path.join(directory, "company-os.sqlite");
  store = openStore();
  addOrganization();
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function openStore(config = resolveConfig({ bossEmailNotifications: { enabled: false } })) {
  return new CompanyOsStore({ databasePath, allowedAgentIds: AGENTS, config });
}

function addOrganization() {
  store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
  store.addMember("main", { agentId: "eng-a", name: "工程师", title: "高级工程师", managerId: "cto" });
  store.addMember("main", { agentId: "advisor", name: "顾问", title: "技术顾问", managerId: "main" });
  store.addMember("main", { agentId: "outsider", name: "未参会员工", title: "工程师", managerId: "cto" });
}

function completeCloseout() {
  while (true) {
    const dispatch = store.claimNextMeetingCloseoutDispatch();
    if (!dispatch) return;
    store.completeMeetingCloseoutDispatch(dispatch.id);
  }
}

describe("unread notice reminder store", () => {
  it("resolves defaults, validates the configured window, and calculates future Beijing half-hour slots", () => {
    expect(resolveConfig(undefined).noticeUnreadReminders).toEqual({
      enabled: true,
      startHour: 8,
      endHour: 17,
      timeZone: "Asia/Shanghai",
    });
    expect(resolveConfig({ noticeUnreadReminders: { enabled: false, startHour: 10, endHour: 12 } }).noticeUnreadReminders)
      .toMatchObject({ enabled: false, startHour: 10, endHour: 12 });
    expect(() => resolveConfig({ noticeUnreadReminders: { startHour: 18, endHour: 8 } })).toThrow(/must not be later/);

    expect(nextNoticeReminderRunAt(Date.parse("2026-08-06T00:00:00.000Z"), 8, 17))
      .toBe("2026-08-06T00:30:00.000Z");
    expect(nextNoticeReminderRunAt(Date.parse("2026-08-06T00:30:00.000Z"), 8, 17))
      .toBe("2026-08-06T01:30:00.000Z");
    expect(nextNoticeReminderRunAt(Date.parse("2026-08-06T09:30:00.000Z"), 8, 17))
      .toBe("2026-08-07T00:30:00.000Z");
  });

  it("freezes one effective unread aggregate per Agent and excludes notices published after the snapshot", () => {
    const original = store.publishNotice("main", { title: "原公告", body: "采用方案 A" });
    const correction = store.publishNotice("main", {
      title: "更正公告",
      body: "采用方案 B",
      supersedesNoticeId: original.id,
    });
    const run = store.queueNoticeReminderRun(HALF_PAST_EIGHT);
    expect(store.queueNoticeReminderRun(HALF_PAST_EIGHT).id).toBe(run.id);

    expect(run.slotKey).toBe("2030-01-01T08:30");
    expect(run.dispatches).toHaveLength(4);
    expect(run.dispatches.every((dispatch) => dispatch.candidates.map((candidate) => candidate.noticeId).join() === correction.id)).toBe(true);
    expect(run.dispatches.map((dispatch) => dispatch.targetMemberId).sort()).toEqual(["advisor", "cto", "eng-a", "outsider"]);

    const late = store.publishNotice("main", { title: "快照后公告", body: "下一轮处理" });
    const first = store.claimNextNoticeReminderDispatch(Date.parse(HALF_PAST_EIGHT));
    expect(first).toMatchObject({ targetMemberId: "cto", status: "running", attempts: 1, candidateCount: 1 });
    expect(first?.candidates.map((candidate) => candidate.noticeId)).toEqual([correction.id]);
    expect(first?.prompt).toContain("【Company OS 公告半点提醒】");
    expect(first?.prompt).toContain(`提醒调度 ID：${first.id}`);
    expect(first?.prompt).toContain(`公告 ID：${correction.id}`);
    expect(first?.prompt).not.toContain(late.id);
    expect(first?.prompt).toContain("company_notice_list");
    expect(first?.prompt).toContain("effectiveOnly=true");
    expect(first?.prompt).toContain("company_notice_read");
  });

  it("includes historical effective unread notices when an employee joins before the next normal half-hour", () => {
    const historical = store.publishNotice("main", { title: "入职前公告", body: "新员工也必须阅读" });
    store.addMember("main", {
      agentId: "late-hire",
      name: "新员工",
      title: "工程师",
      managerId: "eng-a",
    });

    const run = store.queueNoticeReminderRun(HALF_PAST_EIGHT);
    expect(run.dispatches.find((dispatch) => dispatch.targetMemberId === "late-hire")?.candidates)
      .toEqual([expect.objectContaining({ noticeId: historical.id })]);
  });

  it("filters candidates immediately before delivery and skips a new run while an earlier aggregate is open", () => {
    const firstNotice = store.publishNotice("main", { title: "第一条", body: "内容一" });
    const secondNotice = store.publishNotice("main", { title: "第二条", body: "内容二" });
    const firstRun = store.queueNoticeReminderRun(HALF_PAST_EIGHT);
    const nextRun = store.queueNoticeReminderRun("2030-01-01T01:30:00.000Z");
    expect(nextRun.dispatches.every((dispatch) => dispatch.status === "skipped")).toBe(true);

    store.readNotice("cto", firstNotice.id);
    store.deleteNotice("boss", secondNotice.id);
    const claimed = store.claimNextNoticeReminderDispatch(Date.parse(HALF_PAST_EIGHT));
    expect(claimed?.targetMemberId).not.toBe("cto");
    const cto = store.db.prepare("SELECT status, attempts FROM notice_reminder_dispatches WHERE run_id = ? AND target_member_id = 'cto'")
      .get(firstRun.id);
    expect(cto).toMatchObject({ status: "skipped", attempts: 0 });
  });

  it("never retries an attempted aggregate and suppresses legacy queued retries after restart", () => {
    store.publishNotice("main", { title: "需提醒", body: "请阅读" });
    const run = store.queueNoticeReminderRun(HALF_PAST_EIGHT);
    const first = store.claimNextNoticeReminderDispatch(Date.parse(HALF_PAST_EIGHT));
    expect(first).toMatchObject({ targetMemberId: "cto", attempts: 1 });
    expect(store.failNoticeReminderDispatch(first!.id, "first failure")).toBe(false);
    expect(store.db.prepare("SELECT status, attempts, last_error FROM notice_reminder_dispatches WHERE id = ?").get(first!.id))
      .toMatchObject({ status: "failed", attempts: 1, last_error: "first failure" });

    const legacy = store.claimNextNoticeReminderDispatch(Date.parse(HALF_PAST_EIGHT));
    expect(legacy).toMatchObject({ status: "running", attempts: 1 });
    expect(legacy?.id).not.toBe(first!.id);
    store.db.prepare("UPDATE notice_reminder_dispatches SET status = 'pending' WHERE id = ?").run(legacy!.id);
    store.close();
    store = openStore();
    expect(store.recoverNoticeReminderDispatches()).toBe(1);
    expect(store.db.prepare("SELECT status, attempts, last_error FROM notice_reminder_dispatches WHERE id = ?").get(legacy!.id))
      .toMatchObject({ status: "failed", attempts: 1, last_error: expect.stringContaining("duplicate delivery") });
    expect(store.noticeReminderSummary(Date.parse(HALF_PAST_EIGHT)).today.latestRun)
      .toMatchObject({ id: run.id, candidateAgents: 4, candidateUnreadEntries: 4, failed: 2 });
  });

  it("treats a candidate read during an unsuccessful turn as trustworthy delivery progress", () => {
    const notice = store.publishNotice("main", { title: "阅读进展", body: "正文" });
    store.queueNoticeReminderRun(HALF_PAST_EIGHT);
    const dispatch = store.claimNextNoticeReminderDispatch(Date.parse(HALF_PAST_EIGHT));
    expect(store.noticeReminderDispatchHasReadProgress(dispatch!.id)).toBe(false);
    store.readNotice(dispatch!.targetMemberId, notice.id);
    expect(store.noticeReminderDispatchHasReadProgress(dispatch!.id)).toBe(true);
    expect(store.completeNoticeReminderDispatch(dispatch!.id)).toBe(true);
  });

  it("cancels an aggregate if the target employee is deactivated before delivery", () => {
    store.publishNotice("main", { title: "停用前公告", body: "不再需要投递" });
    const run = store.queueNoticeReminderRun(HALF_PAST_EIGHT);
    store.deactivateMember("main", "advisor", "合同结束");
    while (true) {
      const dispatch = store.claimNextNoticeReminderDispatch(Date.parse(HALF_PAST_EIGHT));
      if (!dispatch) break;
      store.completeNoticeReminderDispatch(dispatch.id);
    }

    expect(store.db.prepare("SELECT status, last_error FROM notice_reminder_dispatches WHERE run_id = ? AND target_member_id = 'advisor'").get(run.id))
      .toMatchObject({ status: "canceled", last_error: "target member is inactive" });
  });
});

describe("meeting report automatic read marks", () => {
  it("marks the task meeting host, every worker and advisor read while leaving non-participants unread", () => {
    const root = store.createRootTask({
      title: "父任务",
      description: "召开任务会",
      acceptanceCriteria: "形成子任务",
      assigneeId: "cto",
    });
    const meeting = store.requestMeeting("cto", {
      type: "task",
      title: "任务拆解",
      agenda: "形成执行任务",
      parentTaskId: root.id,
      participants: [
        { agentId: "eng-a", role: "worker" },
        { agentId: "advisor", role: "advisor" },
      ],
    }).meeting;
    store.setMeetingTaskDrafts("cto", meeting.id, [{
      title: "执行任务",
      description: "完成实现",
      acceptanceCriteria: "测试通过",
      assigneeId: "eng-a",
    }]);
    const requested = store.endMeeting("cto", meeting.id, "形成一致结论", false);
    const result = store.finalizeDueAutomaticMeetingEnd(Date.parse(requested.meeting.autoEndAt))!;
    const report = result.notice!;

    expect(store.listNotices("cto").find((notice) => notice.id === report.id)?.readAt).toBeTruthy();
    expect(store.listNotices("eng-a").find((notice) => notice.id === report.id)?.readAt).toBeTruthy();
    expect(store.listNotices("advisor").find((notice) => notice.id === report.id)?.readAt).toBeTruthy();
    expect(store.listNotices("main").find((notice) => notice.id === report.id)?.readAt).toBeNull();
    expect(store.listNotices("outsider").find((notice) => notice.id === report.id)?.readAt).toBeNull();
    expect(store.listNotices("boss").find((notice) => notice.id === report.id))
      .toMatchObject({ activeEmployeeCount: 5, readCount: 3 });
    expect(store.listAudit("notice", report.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorId: "system",
        action: "notice.meeting_participants_marked_read",
        after: expect.objectContaining({ meetingId: meeting.id, memberIds: ["eng-a", "advisor", "cto"] }),
      }),
    ]));

    const correction = store.publishNotice("main", {
      title: "会议汇报更正",
      body: "更正后的结论",
      supersedesNoticeId: report.id,
    });
    expect(store.listNotices("cto", { effectiveOnly: true }).find((notice) => notice.id === correction.id)?.readAt).toBeNull();
    expect(store.listNotices("eng-a", { effectiveOnly: true }).find((notice) => notice.id === correction.id)?.readAt).toBeNull();
  });

  it("uses the same member set for a published discussion report and closeout, excluding an attending Boss", () => {
    const meeting = store.requestMeeting("cto", {
      type: "discussion",
      title: "发布讨论结论",
      agenda: "统一认知",
      participants: [
        { agentId: "eng-a", role: "worker" },
        { agentId: "advisor", role: "advisor" },
      ],
      bossParticipates: true,
    }).meeting;
    store.startMeetingByBoss(meeting.id);
    store.endMeeting("cto", meeting.id, "讨论形成共识", true);
    const result = store.approveMeetingEndByBoss(meeting.id);
    const report = result.notice!;

    const readMembers = store.db.prepare("SELECT member_id FROM notice_reads WHERE notice_id = ? ORDER BY member_id")
      .all(report.id).map((row: any) => row.member_id);
    const closeoutMembers = store.db.prepare("SELECT member_id FROM meeting_closeout_dispatches WHERE meeting_id = ? ORDER BY member_id")
      .all(meeting.id).map((row: any) => row.member_id);
    expect(readMembers).toEqual(["advisor", "cto", "eng-a"]);
    expect(closeoutMembers).toEqual(readMembers);
    expect(readMembers).not.toContain("boss");
  });

  it("does not create read marks for an unpublished, canceled, or timed-out meeting", () => {
    const unpublished = store.requestMeeting("cto", {
      type: "discussion",
      title: "不发布公告",
      agenda: "仅内部讨论",
      participants: [{ agentId: "advisor", role: "advisor" }],
    }).meeting;
    const requested = store.endMeeting("cto", unpublished.id, "不形成公告", false);
    store.finalizeDueAutomaticMeetingEnd(Date.parse(requested.meeting.autoEndAt));
    completeCloseout();

    const active = store.requestMeeting("cto", { type: "discussion", title: "占用会议室", agenda: "占用" }).meeting;
    const queued = store.requestMeeting("advisor", { type: "discussion", title: "被取消", agenda: "取消" }).meeting;
    store.cancelMeeting("advisor", queued.id, "不再需要");
    store.db.prepare("UPDATE meetings SET waiting_on_host_since = ? WHERE id = ?")
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), active.id);
    store.sweepMeetingTimeouts(10 * 60 * 1000, 30 * 60 * 1000);

    expect(store.listNotices("boss")).toHaveLength(0);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM notice_reads").get()).toMatchObject({ count: 0 });
  });

  it("rolls back tasks, report, read marks, meeting completion, and closeout dispatches together", () => {
    const root = store.createRootTask({
      title: "回滚父任务",
      description: "验证原子提交",
      acceptanceCriteria: "全部回滚",
      assigneeId: "cto",
    });
    const meeting = store.requestMeeting("cto", {
      type: "task",
      title: "回滚任务会",
      agenda: "触发终局失败",
      parentTaskId: root.id,
      participants: [{ agentId: "eng-a", role: "worker" }],
    }).meeting;
    store.setMeetingTaskDrafts("cto", meeting.id, [{
      title: "不能留下的任务",
      description: "应被回滚",
      acceptanceCriteria: "不存在",
      assigneeId: "eng-a",
    }]);
    const requested = store.endMeeting("cto", meeting.id, "应整体回滚", false);
    store.db.exec(`
      CREATE TRIGGER fail_meeting_closeout BEFORE INSERT ON meeting_closeout_dispatches
      BEGIN SELECT RAISE(ABORT, 'forced closeout failure'); END;
    `);

    expect(() => store.finalizeDueAutomaticMeetingEnd(Date.parse(requested.meeting.autoEndAt)))
      .toThrow(/forced closeout failure/);
    expect(store.listTasks("boss").map((task) => task.id)).toEqual([root.id]);
    expect(store.listNotices("boss")).toHaveLength(0);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM notice_reads").get()).toMatchObject({ count: 0 });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM meeting_closeout_dispatches WHERE meeting_id = ?").get(meeting.id))
      .toMatchObject({ count: 0 });
    expect(store.meetingView(meeting.id).status).toBe("active");
  });
});
