import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentInvoker } from "../src/agent-invoker.js";
import { executeBossApi } from "../src/boss-api.js";
import type { SessionContextAppender } from "../src/session-context.js";
import { CompanyOsService } from "../src/service.js";
import { resolveConfig } from "../src/types.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("synchronous meeting orchestration", () => {
  it("blocks the host delegate call until the exact speaker submits through company_meeting_speak", async () => {
    let service: CompanyOsService;
    let meetingId = "";
    const agentInvoker: AgentInvoker = {
      invoke: vi.fn(async ({ agentId, prompt }) => {
        expect(agentId).toBe("eng-a");
        expect(prompt).toContain("你现在拥有发言权");
        expect(prompt).not.toContain("当前轮次 ID");
        expect(prompt).not.toContain("meetingId=");
        expect(prompt).not.toContain("company_meeting_speak 成功后");
        const turnId = service.store.meetingView(meetingId, agentId).currentTurn.id;
        service.store.speakMeeting(agentId, meetingId, "通过工具提交的完整发言", turnId);
        return { ok: true, text: "已调用工具", raw: {}, attempts: 1 };
      }),
    };
    service = createService(agentInvoker);
    seedOrganization(service);
    meetingId = service.store.requestMeeting("cto", {
      type: "discussion",
      title: "同步点名测试",
      agenda: "验证主持人等待",
      participants: [{ agentId: "eng-a", role: "advisor" }],
    }).meeting.id;

    const result = await service.delegateMeeting("cto", meetingId, "eng-a", "请提出方案");

    expect(result.delivery).toMatchObject({
      speakerId: "eng-a",
      status: "completed",
      body: "通过工具提交的完整发言",
      completionSource: "tool",
    });
    expect(result.meeting.currentTurn).toBeNull();
    expect(agentInvoker.invoke).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("auto-records an audited fallback when the invoked Agent returns text without the speak tool", async () => {
    const agentInvoker: AgentInvoker = {
      invoke: vi.fn(async () => ({ ok: true, text: "这是普通回复中的发言", raw: { payloads: [{ text: "这是普通回复中的发言" }] }, attempts: 1 })),
    };
    const service = createService(agentInvoker);
    seedOrganization(service);
    const meeting = service.store.requestMeeting("cto", {
      type: "discussion",
      title: "代录测试",
      agenda: "验证 fallback",
      participants: [{ agentId: "eng-a", role: "advisor" }],
    }).meeting;

    const result = await service.delegateMeeting("cto", meeting.id, "eng-a", "请发言");

    expect(result.delivery).toMatchObject({ body: "这是普通回复中的发言", completionSource: "fallback" });
    expect(result.meeting.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorId: "system",
        action: "meeting.spoke_fallback",
        after: expect.objectContaining({
          invokedAgentId: "eng-a",
          rawReturn: { payloads: [{ text: "这是普通回复中的发言" }] },
        }),
      }),
    ]));
    await service.stop();
  });

  it("returns a structured failed turn to the blocked host when the participant invocation times out", async () => {
    const agentInvoker: AgentInvoker = {
      invoke: vi.fn(async () => ({ ok: false, code: "timeout", error: "agent invocation timed out after 600s", attempts: 1 })),
    };
    const service = createService(agentInvoker);
    seedOrganization(service);
    const meeting = service.store.requestMeeting("cto", {
      type: "discussion",
      title: "参会者超时",
      agenda: "验证控制权返回",
      participants: [{ agentId: "eng-a", role: "advisor" }],
    }).meeting;

    const result = await service.delegateMeeting("cto", meeting.id, "eng-a", "请发言");

    expect(result.delivery).toMatchObject({ status: "failed", speakerId: "eng-a", error: "agent invocation timed out after 600s" });
    expect(result.meeting.currentTurn).toBeNull();
    expect(result.meeting.waitingOnHostSince).toBeTruthy();
    await service.stop();
  });

  it("processes FIFO Boss @ interventions after the current speech and then returns to the host", async () => {
    let service: CompanyOsService;
    let meetingId = "";
    const called: string[] = [];
    const agentInvoker: AgentInvoker = {
      invoke: vi.fn(async ({ agentId }) => {
        called.push(agentId);
        if (agentId === "eng-a") {
          service.store.bossInterject(meetingId, "先请顾问判断风险", "advisor");
          service.store.bossInterject(meetingId, "再请 B 补充", "eng-b");
        }
        const turnId = service.store.meetingView(meetingId, agentId).currentTurn.id;
        service.store.speakMeeting(agentId, meetingId, `${agentId} 的回答`, turnId);
        return { ok: true, text: "已提交", raw: {}, attempts: 1 };
      }),
    };
    service = createService(agentInvoker);
    seedOrganization(service);
    meetingId = service.store.requestMeeting("cto", {
      type: "discussion",
      title: "Boss 插话顺序",
      agenda: "验证 FIFO",
      participants: [
        { agentId: "eng-a", role: "advisor" },
        { agentId: "advisor", role: "advisor" },
        { agentId: "eng-b", role: "advisor" },
      ],
    }).meeting.id;

    const result = await service.delegateMeeting("cto", meetingId, "eng-a", "先开始");

    expect(called).toEqual(["eng-a", "advisor", "eng-b"]);
    expect(result.interventions.map((delivery) => delivery.speakerId)).toEqual(["advisor", "eng-b"]);
    expect(result.meeting.currentTurn).toBeNull();
    expect(result.meeting.waitingOnHostSince).toBeTruthy();
    await service.stop();
  });

  it("writes the host point to its session before a new host turn receives the participant answer", async () => {
    let service: CompanyOsService;
    let meetingId = "";
    const appended: string[] = [];
    const sessionContextAppender: SessionContextAppender = {
      append: vi.fn(async (record) => {
        appended.push(record.formattedText);
        return { appended: true, messageId: `transcript-${record.id}` };
      }),
    };
    const prompts: Array<{ agentId: string; prompt: string }> = [];
    const agentInvoker: AgentInvoker = {
      invoke: vi.fn(async ({ agentId, prompt }) => {
        prompts.push({ agentId, prompt });
        if (agentId === "eng-a") {
          const turnId = service.store.meetingView(meetingId, agentId).currentTurn.id;
          service.store.speakMeeting(agentId, meetingId, "参会者基于源码给出的回答", turnId);
        } else if (agentId === "cto") {
          service.store.speakMeeting("cto", meetingId, "主持人已收到回答并继续主持");
        }
        return { ok: true, text: "已推进", raw: {}, attempts: 1 };
      }),
    };
    service = createService(agentInvoker, sessionContextAppender);
    seedOrganization(service);
    const requested = service.store.requestMeeting("cto", {
      type: "discussion",
      title: "跨 turn 主持恢复",
      agenda: "参会者回答由编排器重新传给主持人",
      participants: [{ agentId: "eng-a", role: "advisor" }],
    });
    meetingId = requested.meeting.id;

    const hostSession = {
      agentId: "cto",
      sessionKey: "agent:cto:main",
      sessionId: "session-cto-main",
      toolCallId: "delegate-tool-call",
    };
    const delegated = await service.delegateMeeting("cto", meetingId, "eng-a", "请检查实现后回答", hostSession);

    expect(delegated.hostDispatchId).toBeTruthy();
    expect(service.store.claimNextHostDispatch()).toBeNull();
    expect(prompts.map((item) => item.agentId)).toEqual(["eng-a"]);

    await service.flushSessionContextAppends({
      agentId: "cto",
      sessionKey: "agent:cto:main",
      sessionId: "session-cto-main",
    });
    await waitFor(() => expect(prompts.some((item) => item.agentId === "cto")).toBe(true));

    expect(appended).toEqual([
      "【消息 #000002｜第 1 轮｜点名】\n你（CTO） @高工 A：\n请检查实现后回答",
    ]);
    const resumed = prompts.find((item) => item.agentId === "cto")!.prompt;
    expect(resumed).toContain("参会者基于源码给出的回答");
    expect(resumed).not.toContain("请检查实现后回答");
    await service.stop();
  });

  it("never appends a queued session record from the periodic timeout scan while an Agent turn may still be running", async () => {
    const sessionContextAppender: SessionContextAppender = {
      append: vi.fn(async (record) => ({ appended: true, messageId: `transcript-${record.id}` })),
    };
    const service = createService({ invoke: vi.fn() as any }, sessionContextAppender);
    seedOrganization(service);
    await service.start();
    const meeting = service.store.requestMeeting("cto", {
      type: "discussion",
      title: "禁止扫描期抢写 transcript",
      agenda: "回写只能发生在可信 agent_end 或启动恢复阶段",
    }).meeting;
    service.store.speakMeeting("cto", meeting.id, "当前 turn 已提交的主持人发言", undefined, {
      agentId: "cto",
      sessionKey: "agent:cto:main",
      sessionId: "session-cto-main",
      toolCallId: "speak-tool-call",
    });

    await (service as unknown as { scanTimeouts(): Promise<void> }).scanTimeouts();

    expect(sessionContextAppender.append).not.toHaveBeenCalled();
    expect(service.store.hasPendingSessionContextAppends()).toBe(true);
    await service.stop();
  });

  it("waits for the official main-session activity probe before appending a terminated tool turn", async () => {
    let active = true;
    const sessionContextAppender: SessionContextAppender = {
      append: vi.fn(async (record) => ({ appended: true, messageId: `transcript-${record.id}` })),
    };
    const service = createService({ invoke: vi.fn() as any }, sessionContextAppender, () => active);
    seedOrganization(service);
    await service.start();
    const meeting = service.store.requestMeeting("cto", {
      type: "discussion",
      title: "等待 main session 空闲",
      agenda: "terminate 后不抢写仍处于 active registry 的 transcript",
    }).meeting;
    const identity = {
      agentId: "cto",
      sessionKey: "agent:cto:main",
      sessionId: "session-cto-main",
      toolCallId: "host-speak-call",
    };
    service.store.speakMeeting("cto", meeting.id, "已经验收的主持人发言", undefined, identity);
    service.scheduleSessionContextAppendAfterTurn(identity);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sessionContextAppender.append).not.toHaveBeenCalled();

    active = false;
    await waitFor(() => expect(sessionContextAppender.append).toHaveBeenCalledTimes(1));
    expect(service.store.hasPendingSessionContextAppends()).toBe(false);
    await service.stop();
  });

  it("returns the Boss start API immediately while a durable host dispatch runs in the background", async () => {
    let release: ((value: { ok: true; text: string; raw: unknown; attempts: number }) => void) | undefined;
    const invocation = new Promise<{ ok: true; text: string; raw: unknown; attempts: number }>((resolve) => { release = resolve; });
    const agentInvoker: AgentInvoker = { invoke: vi.fn(async () => invocation) };
    const service = createService(agentInvoker);
    seedOrganization(service);
    const meeting = service.store.requestMeeting("cto", {
      type: "discussion",
      title: "Boss 后台启动",
      agenda: "验证立即响应",
      bossParticipates: true,
    }).meeting;

    const response = await executeBossApi(service, { method: "POST", path: `/meetings/${meeting.id}/start`, body: {} });

    expect(response.data).toMatchObject({ awaitingBossStart: false });
    expect((response.data as any).hostDispatchStatus.status).toMatch(/pending|running/);
    await waitFor(() => expect(agentInvoker.invoke).toHaveBeenCalledTimes(1));
    expect((agentInvoker.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].prompt)
      .toContain("Boss 刚刚说：“我已进入会议室，现在开始会议。”");

    release!({ ok: true, text: "主持流程已经启动", raw: {}, attempts: 1 });
    await waitFor(() => expect(service.store.meetingView(meeting.id).hostDispatchStatus?.status).toBe("succeeded"));
    await service.stop();
  });

  it("accepts a host dispatch with verified meeting progress even when the CLI final payload is empty", async () => {
    let service: CompanyOsService;
    let meetingId = "";
    const agentInvoker: AgentInvoker = {
      invoke: vi.fn(async () => {
        service.store.speakMeeting("cto", meetingId, "主持人已通过工具推进会议");
        return { ok: false, code: "empty_reply", error: "agent returned no text payload", attempts: 1 };
      }),
    };
    service = createService(agentInvoker);
    seedOrganization(service);
    meetingId = service.store.requestMeeting("cto", {
      type: "discussion",
      title: "主持人空 payload",
      agenda: "以持久工具进度为准",
      bossParticipates: true,
    }).meeting.id;
    const advance = service.store.startMeetingByBoss(meetingId);

    await service.dispatchAdvance(advance);
    await waitFor(() => expect(service.store.meetingView(meetingId).hostDispatchStatus?.status).toBe("succeeded"));

    expect(service.store.meetingView(meetingId).messages.at(-1)?.body).toBe("主持人已通过工具推进会议");
    await service.stop();
  });

  it("records success when the dispatched host requests the timed end of an ordinary meeting", async () => {
    let service: CompanyOsService;
    let meetingId = "";
    const agentInvoker: AgentInvoker = {
      invoke: vi.fn(async () => {
        service.store.endMeeting("cto", meetingId, "主持人已完成普通讨论会", false);
        return { ok: false, code: "empty_reply", error: "agent returned no text payload", attempts: 1 };
      }),
    };
    service = createService(agentInvoker);
    seedOrganization(service);
    const result = service.store.requestMeeting("boss", {
      type: "discussion",
      title: "后台主持人直接关会",
      agenda: "完成后直接结束",
      hostId: "cto",
    });
    meetingId = result.meeting.id;

    await service.dispatchAdvance(result.advance);
    await waitFor(() => expect(service.store.meetingView(meetingId).hostDispatchStatus?.status).toBe("succeeded"));

    const pending = service.store.meetingView(meetingId);
    expect(pending.status).toBe("active");
    expect(pending.autoEndAt).toBeTruthy();
    service.store.finalizeDueAutomaticMeetingEnd(Date.parse(pending.autoEndAt));
    expect(service.store.meetingView(meetingId).status).toBe("completed");
    await service.stop();
  });

  it("automatically finalizes a non-Boss meeting when the persistent countdown expires", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-auto-end-"));
    directories.push(directory);
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main", "cto"],
      config: resolveConfig({ meetingAutoEndDelaySeconds: 1, bossEmailNotifications: { enabled: false } }),
      runtimeConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      meetingEmailSender: { send: vi.fn(async () => undefined) },
      agentInvoker: { invoke: vi.fn() as any },
    });
    try {
      service.store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
      await service.start();
      const meeting = service.store.requestMeeting("cto", {
        type: "discussion",
        title: "一秒自动结束",
        agenda: "验证服务定时器",
      }).meeting;
      const requested = service.store.endMeeting("cto", meeting.id, "倒计时总结", false);
      await service.dispatchAdvance(requested.advance);

      expect(service.store.meetingView(meeting.id).status).toBe("active");
      await waitFor(() => expect(service.store.meetingView(meeting.id).status).toBe("completed"), 2_000);
    } finally {
      await service.stop();
    }
  });

  it("delivers a durable Boss task reminder to the assignee main session", async () => {
    const agentInvoker: AgentInvoker = {
      invoke: vi.fn(async ({ agentId, prompt }) => {
        expect(agentId).toBe("cto");
        expect(prompt).toContain("【Company OS 任务催办】");
        expect(prompt).toContain("company_task_read");
        expect(prompt).toContain("company_task_submit");
        return { ok: true, text: "已核对并更新任务进度", raw: {}, attempts: 1 };
      }),
    };
    const service = createService(agentInvoker);
    seedOrganization(service);
    const task = service.store.createRootTask({
      title: "交付催办闭环",
      description: "实现 Boss 催办",
      acceptanceCriteria: "负责人 main session 收到规范提醒",
      assigneeId: "cto",
    });

    const result = service.remindTaskByBoss(task.id);
    expect(result.dispatch).toMatchObject({ status: "pending", targetAgentId: "cto" });
    await waitFor(() => expect(service.store.readTask("boss", task.id, false).reminderDispatch?.status).toBe("succeeded"));
    expect(agentInvoker.invoke).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("delivers every level's review result to that task's assignee main session", async () => {
    const deliveries: Array<{ agentId: string; prompt: string }> = [];
    const agentInvoker: AgentInvoker = {
      invoke: vi.fn(async ({ agentId, prompt }) => {
        deliveries.push({ agentId, prompt });
        return { ok: true, text: "已收到验收结果", raw: {}, attempts: 1 };
      }),
    };
    const service = createService(agentInvoker);
    seedOrganization(service);
    const root = service.store.createRootTask({
      title: "交付全层级通知",
      description: "验证逐级验收通知",
      acceptanceCriteria: "各层负责人收到自己的验收结果",
      assigneeId: "cto",
    });
    const child = service.store.createChildTask("cto", {
      parentId: root.id,
      title: "实现通知编排",
      description: "接通审批结果",
      acceptanceCriteria: "eng-a 收到审批通知",
      assigneeId: "eng-a",
    });
    service.store.startTask("cto", root.id);
    service.store.startTask("eng-a", child.id);
    service.store.submitTask("eng-a", child.id, "child done", [{ type: "proof", label: "tests", command: "npm test" }]);

    service.reviewTask("cto", child.id, "accept", "子任务证据完整");
    await waitFor(() => expect(service.store.readTask("boss", child.id, false).reviewNotificationDispatch?.status).toBe("succeeded"));
    service.store.submitTask("cto", root.id, "root ready", [{ type: "artifact", label: "report", path: "/tmp/report.md" }]);
    service.reviewTask("boss", root.id, "reject", "根任务报告需要补充");
    await waitFor(() => expect(service.store.readTask("boss", root.id, false).reviewNotificationDispatch?.status).toBe("succeeded"));

    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({ agentId: "eng-a" });
    expect(deliveries[0]?.prompt).toContain("已由 CTO（首席技术官） 验收通过");
    expect(deliveries[1]).toMatchObject({ agentId: "cto" });
    expect(deliveries[1]?.prompt).toContain("已由 Boss 驳回验收");
    expect(deliveries[1]?.prompt).toContain("根任务报告需要补充");
    expect(deliveries[1]?.prompt).toContain("company_task_submit");
    await service.stop();
  });

  it("does not repeat review notifications after a completed empty reply or verified remediation action", async () => {
    let service!: CompanyOsService;
    let taskId = "";
    const invoke = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.includes("驳回验收")) {
        service.store.addTaskProgress("cto", taskId, "已读取驳回意见并开始整改");
        return { ok: false as const, code: "exit" as const, error: "CLI lost its final response", attempts: 1 };
      }
      return {
        ok: false as const,
        code: "empty_reply" as const,
        error: "agent returned no text payload",
        attempts: 1,
        completed: true,
        raw: { status: "ok", payloads: [] },
      };
    });
    service = createService({ invoke });
    seedOrganization(service);
    const task = service.store.createRootTask({
      title: "验收通知幂等",
      description: "通知不因空回复重复注入",
      acceptanceCriteria: "每次验收事件只投递一次",
      assigneeId: "cto",
    });
    taskId = task.id;
    service.store.startTask("cto", task.id);
    service.store.submitTask("cto", task.id, "首次提交", [{ type: "proof", label: "tests", command: "npm test" }]);

    service.reviewTask("boss", task.id, "reject", "需要补充证据");
    await waitFor(() => expect(service.store.readTask("boss", task.id, false).reviewNotificationDispatch)
      .toMatchObject({ kind: "review_rejected", status: "succeeded", attempts: 1 }));

    service.store.submitTask("cto", task.id, "整改后重新提交", [{ type: "proof", label: "tests", command: "npm test" }]);
    service.reviewTask("boss", task.id, "accept", "验收通过");
    await waitFor(() => expect(service.store.readTask("boss", task.id, false).reviewNotificationDispatch)
      .toMatchObject({ kind: "review_accepted", status: "succeeded", attempts: 1 }));

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.every(([input]) => input.prompt.includes("同一通知 ID 只处理一次"))).toBe(true);
    await service.stop();
  });

  it("does not automatically replay an ambiguously aborted review notification", async () => {
    const invoke = vi.fn(async () => ({
      ok: false as const,
      code: "aborted" as const,
      error: "agent invocation aborted after launch",
      attempts: 1,
    }));
    const service = createService({ invoke });
    seedOrganization(service);
    const task = service.store.createRootTask({
      title: "模糊失败不重放",
      description: "已启动的通知不能因结果未知而重复注入",
      acceptanceCriteria: "只调用一次 Agent",
      assigneeId: "cto",
    });
    service.store.startTask("cto", task.id);
    service.store.submitTask("cto", task.id, "提交验收", [{ type: "proof", label: "tests", command: "npm test" }]);

    service.reviewTask("boss", task.id, "reject", "需要整改");
    await waitFor(() => expect(service.store.readTask("boss", task.id, false).reviewNotificationDispatch)
      .toMatchObject({ status: "failed", attempts: 1, lastError: "agent invocation aborted after launch" }));

    expect(invoke).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("actively synchronizes every attendee before activating the next room meeting", async () => {
    const deliveries: Array<{ agentId: string; prompt: string }> = [];
    const agentInvoker: AgentInvoker = {
      invoke: vi.fn(async ({ agentId, prompt }) => {
        deliveries.push({ agentId, prompt });
        if (agentId === "eng-a") {
          return { ok: false, code: "empty_reply" as const, error: "agent returned no text payload", attempts: 1, completed: true, raw: { status: "ok", payloads: [] } };
        }
        return { ok: true, text: "已同步会议最终记录", raw: {}, attempts: 1 };
      }),
    };
    const service = createService(agentInvoker);
    seedOrganization(service);
    const meeting = service.store.requestMeeting("cto", {
      type: "discussion",
      title: "终局主动同步",
      agenda: "验证 main session 编排",
      participants: [
        { agentId: "eng-a", role: "worker" },
        { agentId: "eng-b", role: "advisor" },
      ],
    }).meeting;
    const next = service.store.requestMeeting("eng-a", {
      type: "discussion",
      title: "屏障后的会议",
      agenda: "必须后启动",
      bossParticipates: true,
    }).meeting;
    const requested = service.store.endMeeting("cto", meeting.id, "全员获得最终上下文", false);
    const finalized = service.store.finalizeDueAutomaticMeetingEnd(Date.parse(requested.meeting.autoEndAt))!;
    const messageCount = service.store.meetingView(meeting.id).messages.length;

    expect(service.store.meetingView(next.id).status).toBe("queued");
    await service.dispatchAdvance(finalized.advance);
    await waitFor(() => expect(service.store.meetingView(meeting.id).closeoutStatus?.state).toBe("delivered"));

    const closeouts = deliveries.filter((item) => item.prompt.includes("【Company OS 会议结束同步】"));
    expect(closeouts.map((item) => item.agentId)).toEqual(["eng-a", "eng-b", "cto"]);
    expect(closeouts.every((item) => item.prompt.includes("【主持人最终总结】"))).toBe(true);
    expect(closeouts.every((item) => item.prompt.includes("不要再调用会议工具"))).toBe(true);
    expect(service.store.meetingView(meeting.id).messages).toHaveLength(messageCount);
    expect(service.store.meetingView(next.id)).toMatchObject({ status: "active", awaitingBossStart: true });
    await service.stop();
  });
});

function createService(
  agentInvoker: AgentInvoker,
  sessionContextAppender?: SessionContextAppender,
  isSessionActive?: (sessionKey: string) => boolean,
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-orchestration-"));
  directories.push(directory);
  return new CompanyOsService({
    databasePath: path.join(directory, "company-os.sqlite"),
    allowedAgentIds: ["main", "cto", "eng-a", "eng-b", "advisor"],
    config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
    runtimeConfig: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    meetingEmailSender: { send: vi.fn(async () => undefined) },
    agentInvoker,
    ...(sessionContextAppender ? { sessionContextAppender } : {}),
    ...(isSessionActive ? { isSessionActive } : {}),
  });
}

function seedOrganization(service: CompanyOsService) {
  service.store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
  service.store.addMember("main", { agentId: "eng-a", name: "高工 A", title: "高级工程师", managerId: "cto" });
  service.store.addMember("main", { agentId: "eng-b", name: "高工 B", title: "高级工程师", managerId: "cto" });
  service.store.addMember("main", { agentId: "advisor", name: "顾问", title: "技术顾问", managerId: "main" });
}

async function waitFor(assertion: () => void, timeoutMs = 1000) {
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
