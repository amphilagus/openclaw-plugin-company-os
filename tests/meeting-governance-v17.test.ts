import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentInvoker } from "../src/agent-invoker.js";
import type { MeetingSessionRuntime } from "../src/meeting-session-runtime.js";
import { CompanyOsService } from "../src/service.js";
import { CompanyOsStore } from "../src/store.js";
import { resolveConfig, type MeetingToolSessionIdentity } from "../src/types.js";

const directories: string[] = [];
const AGENTS = ["main", "cto", "eng-a", "eng-b"];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Company OS meeting governance schema v17", () => {
  it("crosses the full main-notification barrier before running the host in a dedicated session", async () => {
    const events: string[] = [];
    const systemMessages: Array<{ sessionKey: string; text: string }> = [];
    const released: string[] = [];
    const meetingRuntime: MeetingSessionRuntime = {
      appendMainSystemMessage: vi.fn(async ({ sessionKey, text, idempotencyKey }) => {
        events.push(`main:${sessionKey}:${idempotencyKey.includes("closeout") ? "closeout" : "entry"}`);
        systemMessages.push({ sessionKey, text });
        return { sessionId: `session:${sessionKey}`, messageId: idempotencyKey };
      }),
      ensureSession: vi.fn(async ({ sessionKey, label, category }) => {
        events.push(`ensure:${sessionKey}`);
        expect(label).toBe("meeting");
        expect(category).toBe("Company OS 会议");
        return { sessionId: `session:${sessionKey}` };
      }),
      releaseSession: vi.fn(async ({ sessionKey }) => {
        events.push(`release:${sessionKey}`);
        released.push(sessionKey);
      }),
    };
    const invoked: Array<{ agentId: string; sessionKey?: string }> = [];
    const agentInvoker: AgentInvoker = {
      invoke: vi.fn(async ({ agentId, sessionKey }) => {
        events.push(`invoke:${sessionKey}`);
        invoked.push({ agentId, sessionKey });
        return { ok: true, text: "主持人当前无更多议题", raw: {}, attempts: 1 };
      }),
    };
    const service = createDedicatedService(meetingRuntime, agentInvoker);
    seedOrganization(service.store);
    const requested = service.store.requestMeeting("cto", {
      type: "discussion",
      title: "专属 Session 编排",
      agenda: "验证全员入会屏障",
      participants: [{ agentId: "eng-a", role: "advisor" }],
      bossParticipates: true,
    });

    expect(requested.meeting).toMatchObject({ sessionMode: "dedicated", entryState: "idle", awaitingBossStart: true });
    expect(invoked).toEqual([]);

    const advance = service.store.startMeetingByBoss(requested.meeting.id);
    await service.dispatchAdvance(advance);
    await waitFor(() => expect(service.store.meetingView(requested.meeting.id).controlState).toBe("waiting_boss"));

    const ready = service.store.meetingView(requested.meeting.id);
    expect(ready).toMatchObject({ entryState: "ready", controlState: "waiting_boss" });
    expect(ready.entryStatus).toMatchObject({ total: 2, notified: 2, ready: 2 });
    expect(ready.memberSessions.map((session) => session.sessionKey)).toEqual(expect.arrayContaining([
      "agent:cto:meeting",
      "agent:eng-a:meeting",
    ]));
    expect(systemMessages.filter((message) => message.text.includes("Company OS 系统通知 · 入会"))).toHaveLength(2);
    expect(invoked).toEqual([{
      agentId: "cto",
      sessionKey: "agent:cto:meeting",
    }]);
    const firstEnsure = events.findIndex((event) => event.startsWith("ensure:"));
    const lastEntry = Math.max(...events.map((event, index) => event.endsWith(":entry") ? index : -1));
    const firstInvoke = events.findIndex((event) => event.startsWith("invoke:"));
    const lastEnsure = Math.max(...events.map((event, index) => event.startsWith("ensure:") ? index : -1));
    expect(firstEnsure).toBeGreaterThan(lastEntry);
    expect(firstInvoke).toBeGreaterThan(lastEnsure);

    const ended = service.store.endMeetingByBoss(requested.meeting.id, "Boss 确认采用最终结论", false);
    await service.dispatchAdvance(ended.advance);
    await waitFor(() => expect(service.store.meetingView(requested.meeting.id).memberSessions.every((session) => session.status === "archived")).toBe(true));

    const completed = service.store.meetingView(requested.meeting.id);
    expect(completed.status).toBe("completed");
    expect(systemMessages.filter((message) => message.text.includes("Company OS 会议结束同步"))).toHaveLength(2);
    expect(released).toEqual(expect.arrayContaining(completed.memberSessions.map((session) => session.sessionKey)));
    expect(completed.messages.some((message) => message.body.includes("【Boss 最终总结】"))).toBe(true);
    expect(invoked).toHaveLength(1);
    await service.stop();
  });

  it("rejects main/foreign Agents, refreshes a rotated session ID by stable key, and keeps Boss end authority", () => {
    const store = createDedicatedStore();
    seedOrganization(store);
    try {
      const meeting = store.requestMeeting("cto", {
        type: "discussion",
        title: "Boss 独占结束权",
        agenda: "验证三项决策",
        participants: [{ agentId: "eng-a", role: "advisor" }],
        bossParticipates: true,
      }).meeting;
      store.startMeetingByBoss(meeting.id);
      provisionMeeting(store, meeting.id);
      let hostSession = sessionIdentity(store, meeting.id, "cto");

      expect(() => store.speakMeeting("cto", meeting.id, "缺少可信 session")).toThrow(/bound meeting session/);
      expect(() => store.speakMeeting("cto", meeting.id, "错误 main 发言", undefined, {
        ...hostSession,
        sessionKey: "agent:cto:main",
      })).toThrow(/bound meeting session/);
      hostSession = {
        ...hostSession,
        sessionId: "rotated-session-id",
        toolCallId: "rotated-session-tool",
      };
      store.speakMeeting("cto", meeting.id, "session reset 后继续主持", undefined, hostSession);
      expect(store.meetingView(meeting.id).memberSessions.find((session) => session.memberId === "cto")?.sessionId)
        .toBe("rotated-session-id");
      expect(store.meetingView(meeting.id).audit).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: "meeting.session_binding_refreshed",
          after: expect.objectContaining({
            memberId: "cto",
            sessionKey: "agent:cto:meeting",
            sessionId: "rotated-session-id",
          }),
        }),
      ]));
      expect(() => store.speakMeeting("cto", meeting.id, "错误 Agent", undefined, {
        ...hostSession,
        agentId: "eng-a",
      })).toThrow(/Agent does not match/);
      expect(() => store.endMeeting("cto", meeting.id, "主持人无权结束", false, hostSession)).toThrow(/only Boss WebUI can end/);

      store.speakMeeting("cto", meeting.id, "主持人完成议程推进", undefined, hostSession);
      store.yieldMeetingToBoss("cto", meeting.id, { ...hostSession, toolCallId: "yield" });
      expect(store.meetingView(meeting.id)).toMatchObject({ status: "active", controlState: "waiting_boss" });
      expect(store.sweepMeetingTimeouts(0, 0)).toEqual([]);

      const summaryAdvance = store.requestMeetingSummaryByBoss(meeting.id);
      expect(summaryAdvance.hostDispatchId).toBeTruthy();
      expect(store.meetingView(meeting.id).controlState).toBe("host_summary");
      store.submitMeetingSummary("cto", meeting.id, "主持人总结第一版", { ...hostSession, toolCallId: "summary" });
      expect(store.meetingView(meeting.id)).toMatchObject({
        status: "active",
        controlState: "waiting_boss",
        latestHostSummary: "主持人总结第一版",
      });

      const completed = store.endMeetingByBoss(meeting.id, undefined, false);
      expect(completed.meeting).toMatchObject({ status: "completed", summary: "主持人总结第一版" });
      expect(store.pendingMeetingEmailNotifications()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "completed",
          meetingId: meeting.id,
          summary: "主持人总结第一版",
          taskOutputs: [],
          noticeOutput: null,
        }),
      ]));
    } finally {
      store.close();
    }
  });

  it("atomically fulfills a required task meeting before creating its staged task flow on direct Boss end", () => {
    const store = createDedicatedStore();
    seedOrganization(store);
    try {
      const root = store.createRootTask({
        title: "需要 Boss 任务会拆解",
        description: "通过任务会议生成分阶段任务流",
        acceptanceCriteria: "任务流和子任务全部完成",
        assigneeId: "cto",
        requireTaskMeeting: true,
        taskMeetingBossParticipates: true,
      });
      const meeting = store.requestMeeting("cto", {
        type: "task",
        title: "任务拆解会",
        agenda: "形成两阶段任务流",
        parentTaskId: root.id,
        participants: [
          { agentId: "eng-a", role: "worker" },
          { agentId: "eng-b", role: "worker" },
        ],
        bossParticipates: true,
      }).meeting;
      store.startMeetingByBoss(meeting.id);
      provisionMeeting(store, meeting.id);
      const hostSession = sessionIdentity(store, meeting.id, "cto");
      store.setMeetingTaskDrafts("cto", meeting.id, [
        {
          name: "阶段一",
          objective: "并行熟悉",
          tasks: [
            { title: "工程任务 A", description: "完成 A", acceptanceCriteria: "A 可验收", assigneeId: "eng-a" },
            { title: "工程任务 B", description: "完成 B", acceptanceCriteria: "B 可验收", assigneeId: "eng-b" },
          ],
        },
      ], hostSession);
      store.yieldMeetingToBoss("cto", meeting.id, hostSession);

      const completed = store.endMeetingByBoss(meeting.id, "Boss 批准任务流", false);

      expect(completed.meeting).toMatchObject({ status: "completed", summary: "Boss 批准任务流" });
      expect(completed.createdTasks).toHaveLength(2);
      expect(store.readTask("boss", root.id, false)).toMatchObject({
        taskMeetingRequirement: { status: "fulfilled", meetingId: meeting.id },
        childFlow: { stages: [expect.objectContaining({ name: "阶段一", status: "active" })] },
      });
    } finally {
      store.close();
    }
  });

  it("retries a missing host-summary tool action and returns control to Boss without ending", () => {
    const store = createDedicatedStore();
    seedOrganization(store);
    try {
      const meeting = store.requestMeeting("cto", {
        type: "discussion",
        title: "主持总结失败恢复",
        agenda: "总结失败不能结束会议",
        bossParticipates: true,
      }).meeting;
      store.startMeetingByBoss(meeting.id);
      provisionMeeting(store, meeting.id);
      store.yieldMeetingToBoss("cto", meeting.id, sessionIdentity(store, meeting.id, "cto"));
      store.requestMeetingSummaryByBoss(meeting.id);

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const dispatch = store.claimNextHostDispatch();
        expect(dispatch).toMatchObject({ kind: "host_summary", attempts: attempt });
        store.setHostDispatchContext(dispatch!.id, store.buildMeetingContext(meeting.id, "cto", {
          role: "host",
          instruction: dispatch!.reason,
        }));
        store.failHostDispatch(dispatch!.id, "未调用 summary 工具");
      }

      const recovered = store.meetingView(meeting.id);
      expect(recovered).toMatchObject({ status: "active", controlState: "waiting_boss", latestHostSummary: null });
      expect(recovered.messages.at(-1)?.body).toContain("控制权已返回 Boss");
    } finally {
      store.close();
    }
  });

  it("migrates an active legacy Boss end request into a reusable host summary and Boss wait state", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-v16-boss-migration-"));
    directories.push(directory);
    const databasePath = path.join(directory, "company-os.sqlite");
    let legacy = new CompanyOsStore({
      databasePath,
      allowedAgentIds: AGENTS,
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      defaultMeetingSessionMode: "legacy_main",
      enforceBossExclusiveEnd: false,
    });
    seedOrganization(legacy);
    const meeting = legacy.requestMeeting("cto", {
      type: "discussion",
      title: "旧结束审批迁移",
      agenda: "保留主持人总结",
      bossParticipates: true,
    }).meeting;
    legacy.startMeetingByBoss(meeting.id);
    legacy.endMeeting("cto", meeting.id, "旧版主持人申请总结", false, {
      agentId: "cto",
      sessionKey: "agent:cto:main",
      sessionId: "legacy-main-session",
      toolCallId: "legacy-end",
    });
    legacy.close();

    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE schema_meta SET value = '16' WHERE key = 'schema_version'").run();
    raw.close();

    legacy = new CompanyOsStore({
      databasePath,
      allowedAgentIds: AGENTS,
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      defaultMeetingSessionMode: "dedicated",
      enforceBossExclusiveEnd: true,
    });
    try {
      expect(legacy.meetingView(meeting.id)).toMatchObject({
        status: "active",
        sessionMode: "legacy_main",
        controlState: "waiting_boss",
        latestHostSummary: "旧版主持人申请总结",
        endRequestedAt: null,
        endRequestedSummary: null,
      });
    } finally {
      legacy.close();
    }
  });

  it("recovers a stuck Gateway-permission entry into fixed meeting-session bindings", () => {
    const store = createDedicatedStore();
    seedOrganization(store);
    try {
      const meeting = store.requestMeeting("cto", {
        type: "discussion",
        title: "固定 meeting session 恢复",
        agenda: "从旧专属 key 恢复",
        participants: [{ agentId: "eng-a", role: "advisor" }],
        bossParticipates: true,
      }).meeting;
      store.startMeetingByBoss(meeting.id);
      store.db.prepare(`
        UPDATE meeting_entry_notifications SET status = 'failed',
          meeting_session_key = 'agent:' || runtime_agent_id || ':company-os:meeting:' || meeting_id,
          prompt = '专属 session：agent:' || runtime_agent_id || ':company-os:meeting:' || meeting_id,
          last_error = 'Gateway requests are only available to bundled or trusted official plugins.'
        WHERE meeting_id = ? AND member_id = 'eng-a'
      `).run(meeting.id);
      store.db.prepare(`
        UPDATE meeting_member_sessions SET
          session_key = 'agent:' || runtime_agent_id || ':company-os:meeting:' || meeting_id,
          label = '旧会议标题'
        WHERE meeting_id = ?
      `).run(meeting.id);

      store.recoverMeetingEntryWork();

      const notification = store.db.prepare(`
        SELECT status, meeting_session_key, prompt, last_error
        FROM meeting_entry_notifications WHERE meeting_id = ? AND member_id = 'eng-a'
      `).get(meeting.id) as Record<string, unknown>;
      expect(notification).toMatchObject({
        status: "pending",
        meeting_session_key: "agent:eng-a:meeting",
        prompt: "固定会议 session：meeting",
        last_error: null,
      });
      expect(store.meetingView(meeting.id).memberSessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ memberId: "cto", sessionKey: "agent:cto:meeting", label: "meeting" }),
        expect.objectContaining({ memberId: "eng-a", sessionKey: "agent:eng-a:meeting", label: "meeting" }),
      ]));
      expect(store.meetingView(meeting.id).entryStatus.waitingMembers).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("keeps ordinary meetings on host countdown and skips a focused member without blocking another main delivery", () => {
    const store = createDedicatedStore();
    seedOrganization(store);
    try {
      store.updateMember("main", "eng-a", { managerId: "boss" }, "测试不同 main session 的独立投递");
      const ctoTask = store.createRootTask({ title: "CTO 任务", description: "待提醒", acceptanceCriteria: "完成", assigneeId: "cto" });
      const engTask = store.createRootTask({ title: "工程任务", description: "待提醒", acceptanceCriteria: "完成", assigneeId: "eng-a" });
      const meeting = store.requestMeeting("cto", {
        type: "discussion",
        title: "普通会议",
        agenda: "验证旧结束规则与提醒避让",
      }).meeting;
      const entry = store.claimNextMeetingEntryNotification();
      expect(entry?.memberId).toBe("cto");
      store.completeMeetingEntryNotification(entry!.id);

      store.queueTaskReminderByBoss(ctoTask.id);
      const engReminder = store.queueTaskReminderByBoss(engTask.id);
      expect(store.claimNextTaskDispatch()).toMatchObject({ id: engReminder.id, targetMemberId: "eng-a" });

      provisionRemainingSessions(store, meeting.id);
      const requested = store.endMeeting("cto", meeting.id, "主持人提交普通会议总结", false, sessionIdentity(store, meeting.id, "cto"));
      expect(requested.meeting).toMatchObject({ status: "active", endRequestedSummary: "主持人提交普通会议总结" });
      expect(requested.meeting.autoEndAt).toBeTruthy();
      const completed = store.finalizeDueAutomaticMeetingEnd(Date.parse(requested.meeting.autoEndAt!));
      expect(completed?.meeting.status).toBe("completed");
    } finally {
      store.close();
    }
  });
});

function createDedicatedService(meetingSessionRuntime: MeetingSessionRuntime, agentInvoker: AgentInvoker) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-v17-service-"));
  directories.push(directory);
  return new CompanyOsService({
    databasePath: path.join(directory, "company-os.sqlite"),
    allowedAgentIds: AGENTS,
    config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
    runtimeConfig: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    meetingEmailSender: { send: vi.fn(async () => undefined) },
    meetingSessionRuntime,
    agentInvoker,
    isSessionActive: () => false,
  });
}

function createDedicatedStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-v17-store-"));
  directories.push(directory);
  return new CompanyOsStore({
    databasePath: path.join(directory, "company-os.sqlite"),
    allowedAgentIds: AGENTS,
    config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
    defaultMeetingSessionMode: "dedicated",
    enforceBossExclusiveEnd: true,
  });
}

function seedOrganization(store: CompanyOsStore) {
  store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
  store.addMember("main", { agentId: "eng-a", name: "高工 A", title: "高级工程师", managerId: "cto" });
  store.addMember("main", { agentId: "eng-b", name: "高工 B", title: "高级工程师", managerId: "cto" });
}

function provisionMeeting(store: CompanyOsStore, meetingId: string) {
  while (true) {
    const notification = store.claimNextMeetingEntryNotification();
    if (!notification) break;
    store.completeMeetingEntryNotification(notification.id);
  }
  provisionRemainingSessions(store, meetingId);
}

function provisionRemainingSessions(store: CompanyOsStore, meetingId: string) {
  while (true) {
    const memberSession = store.claimNextMeetingSessionProvision();
    if (!memberSession) break;
    store.completeMeetingSessionProvision(memberSession.id, `session:${memberSession.sessionKey}`);
  }
  expect(store.meetingView(meetingId).entryState).toBe("ready");
}

function sessionIdentity(store: CompanyOsStore, meetingId: string, memberId: string): MeetingToolSessionIdentity {
  const memberSession = store.meetingView(meetingId).memberSessions.find((session) => session.memberId === memberId)!;
  return {
    agentId: memberId,
    sessionKey: memberSession.sessionKey,
    sessionId: memberSession.sessionId!,
    toolCallId: `tool:${memberId}`,
  };
}

async function waitFor(assertion: () => void, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
