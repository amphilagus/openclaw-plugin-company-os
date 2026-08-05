import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentInvoker } from "../src/agent-invoker.js";
import { executeBossApi } from "../src/boss-api.js";
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
        expect(prompt).toContain("当前轮次 ID");
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

  it("records success when the dispatched host completes an ordinary meeting inside the invocation", async () => {
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

    expect(service.store.meetingView(meetingId).status).toBe("completed");
    await service.stop();
  });
});

function createService(agentInvoker: AgentInvoker) {
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
