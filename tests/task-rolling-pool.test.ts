import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompanyOsService } from "../src/service.js";
import { CompanyOsStore, nextTaskPromptTickAt } from "../src/store.js";
import { resolveConfig } from "../src/types.js";
import { VERIFIED_GIT } from "./test-git.js";

const PROOF = [{ type: "proof" as const, label: "tests", command: "npm test" }];
const PASS_REPORT = {
  checks: [{ criterion: "验收标准", outcome: "pass" as const, evidenceIndexes: [0], finding: "证据有效" }],
  conclusion: "满足验收标准",
};
const FAIL_REPORT = {
  checks: [{ criterion: "验收标准", outcome: "fail" as const, evidenceIndexes: [], finding: "证据不足", remediation: "补充可复核证据" }],
  conclusion: "需要整改后重新提交",
};

let directory: string;
let store: CompanyOsStore;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "company-os-rolling-pool-"));
  store = new CompanyOsStore({
    databasePath: path.join(directory, "company-os.sqlite"),
    allowedAgentIds: ["main", "cto", "eng-a"],
    config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
  });
  store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
  store.addMember("main", { agentId: "eng-a", name: "工程师", title: "工程师", managerId: "cto" });
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("persistent rolling task prompt pool", () => {
  it("moves execution, review, rejection, and blocked-review items through the correct employee queues", () => {
    const root = store.createRootTask({
      title: "任务 A",
      description: "父任务",
      acceptanceCriteria: "子任务完成后汇总",
      assigneeId: "cto",
    });
    expect(poolRows()).toEqual([expect.objectContaining({ member_id: "cto", task_id: root.id, kind: "execution" })]);

    const child = store.createChildTask("cto", {
      parentId: root.id,
      title: "子任务 b",
      description: "实现功能",
      acceptanceCriteria: "测试通过",
      assigneeId: "eng-a",
    });
    expect(poolRows()).toEqual([expect.objectContaining({ member_id: "eng-a", task_id: child.id, kind: "execution" })]);

    store.startTask("eng-a", child.id);
    store.submitTask("eng-a", child.id, "实现完成", PROOF, VERIFIED_GIT);
    expect(poolRows()).toEqual([expect.objectContaining({ member_id: "cto", task_id: child.id, kind: "review" })]);
    const reviewTick = store.queueTaskPromptTick("2030-01-01T02:00:00.000Z");
    const reviewPrompt = store.createTaskPromptDispatch(reviewTick.id, "cto", false);
    expect(reviewPrompt.prompt).toContain(VERIFIED_GIT.remoteUrl);
    expect(reviewPrompt.prompt).toContain(VERIFIED_GIT.branch);
    expect(reviewPrompt.prompt).toContain(VERIFIED_GIT.commit);
    expect(reviewPrompt.prompt).toContain(VERIFIED_GIT.verifiedAt);
    expect(reviewPrompt.prompt).toContain("应由你在当前验收阶段执行");
    store.finishTaskPromptDispatch(reviewPrompt.id, { status: "canceled", error: "test inspection only" });
    store.readTask("cto", child.id);
    store.reviewTask("cto", child.id, "reject", "缺少边界测试", FAIL_REPORT);
    expect(poolRows()).toEqual([expect.objectContaining({ member_id: "eng-a", task_id: child.id, kind: "execution" })]);

    store.blockTask("eng-a", child.id, "依赖接口不可用");
    expect(poolRows()).toEqual([expect.objectContaining({ member_id: "cto", task_id: child.id, kind: "blocked_review" })]);
    const tick = store.queueTaskPromptTick("2030-01-01T02:20:00.000Z");
    const blockedPrompt = store.createTaskPromptDispatch(tick.id, "cto", false);
    expect(blockedPrompt.prompt).toContain("子任务 b");
    expect(blockedPrompt.prompt).toContain("依赖接口不可用");
    expect(blockedPrompt.prompt).toContain("company_task_unblock");
    expect(blockedPrompt.prompt).toContain(`自动阻塞父任务 ${root.id}`);
    expect(blockedPrompt.prompt).not.toContain("company_task_cancel");
    store.finishTaskPromptDispatch(blockedPrompt.id, { status: "canceled", error: "test inspection only" });
    store.unblockTask("cto", child.id, "使用稳定的本地适配器继续推进");
    expect(poolRows()).toEqual([expect.objectContaining({ member_id: "eng-a", task_id: child.id, kind: "execution" })]);
  });

  it("automatically escalates a started blocked review that ends without unblocking", () => {
    const root = store.createRootTask({
      title: "需要向上升级的根任务",
      description: "验证阻塞审查兜底",
      acceptanceCriteria: "阻塞不会在本级空转",
      assigneeId: "cto",
    });
    const child = store.createChildTask("cto", {
      parentId: root.id,
      title: "持续阻塞的子任务",
      description: "本级无法解决",
      acceptanceCriteria: "向上获得协助",
      assigneeId: "eng-a",
    });
    store.blockTask("eng-a", child.id, "需要公司级外部账号权限");

    const dueAt = store.peekNextTaskPromptDueAt();
    expect(dueAt).not.toBeNull();
    const dispatch = store.createTaskPromptCycleDispatch("cto", false, undefined, Date.parse(dueAt!));
    store.markTaskPromptCycleDispatchStarted(dispatch.id);
    store.finishTaskPromptCycleDispatch(dispatch.id, { status: "succeeded" });

    expect(store.readTask("boss", child.id, false).status).toBe("blocked");
    const escalatedRoot = store.readTask("boss", root.id, false);
    expect(escalatedRoot.status).toBe("blocked");
    expect(escalatedRoot.blockedReason).toContain(child.id);
    expect(poolRows("cto")).toEqual([]);
    expect(store.listAudit("task", child.id).some((event) => event.action === "task.blocked_review_auto_escalated")).toBe(true);
  });

  it("does not escalate when the reviewer actually unblocks the child before the started run ends", () => {
    const root = store.createRootTask({
      title: "可在本级解决的根任务",
      description: "验证解除优先",
      acceptanceCriteria: "父任务不被误阻塞",
      assigneeId: "cto",
    });
    const child = store.createChildTask("cto", {
      parentId: root.id,
      title: "可解除的子任务",
      description: "已有解决方案",
      acceptanceCriteria: "继续执行",
      assigneeId: "eng-a",
    });
    store.blockTask("eng-a", child.id, "等待本级配置建议");

    const dueAt = store.peekNextTaskPromptDueAt();
    const dispatch = store.createTaskPromptCycleDispatch("cto", false, undefined, Date.parse(dueAt!));
    store.markTaskPromptCycleDispatchStarted(dispatch.id);
    store.unblockTask("cto", child.id, "改用本地测试配置并继续");
    store.finishTaskPromptCycleDispatch(dispatch.id, { status: "succeeded" });

    expect(store.readTask("boss", root.id, false).status).toBe("assigned");
    expect(store.readTask("boss", child.id, false).status).toBe("in_progress");
    expect(poolRows("eng-a")).toEqual([expect.objectContaining({ task_id: child.id, kind: "execution" })]);
    expect(store.listAudit("task", child.id).some((event) => event.action === "task.blocked_review_auto_escalated")).toBe(false);
  });

  it("escalates an unresolved started blocked review during Gateway recovery", () => {
    const root = store.createRootTask({
      title: "恢复时升级的根任务",
      description: "验证中断恢复",
      acceptanceCriteria: "已启动审查不重复回转",
      assigneeId: "cto",
    });
    const child = store.createChildTask("cto", {
      parentId: root.id,
      title: "恢复时仍阻塞的子任务",
      description: "Agent run 启动后 Gateway 中断",
      acceptanceCriteria: "恢复时自动向上",
      assigneeId: "eng-a",
    });
    store.blockTask("eng-a", child.id, "外部权限尚未解决");

    const dueAt = store.peekNextTaskPromptDueAt();
    const dispatch = store.createTaskPromptCycleDispatch("cto", false, undefined, Date.parse(dueAt!));
    store.markTaskPromptCycleDispatchStarted(dispatch.id);
    expect(store.recoverTaskPromptCycleDispatches()).toBe(1);

    expect(store.readTask("boss", root.id, false).status).toBe("blocked");
    expect(poolRows("cto")).toEqual([]);
    expect(store.db.prepare("SELECT status FROM task_prompt_cycle_dispatches WHERE id = ?").get(dispatch.id))
      .toMatchObject({ status: "failed" });
  });

  it("keeps strict FIFO order and rotates only after injection has started", () => {
    const tasks = ["A", "B", "C"].map((title) => store.createRootTask({
      title,
      description: `${title} 说明`,
      acceptanceCriteria: `${title} 标准`,
      assigneeId: "cto",
    }));
    const tick = store.queueTaskPromptTick("2030-01-01T02:20:00.000Z");
    const dispatch = store.createTaskPromptDispatch(tick.id, "cto", false);
    expect(dispatch).toMatchObject({ claimed: true, taskId: tasks[0]!.id, kind: "execution", started: false });
    expect(dispatch.prompt).toContain("Boss 只在任务进入 review 后介入验收");
    expect(dispatch.prompt).toContain("待验收阶段检查");
    expect(poolRows("cto").map((row) => row.task_id)).toEqual(tasks.map((task) => task.id));

    store.markTaskPromptDispatchStarted(dispatch.id);
    store.finishTaskPromptDispatch(dispatch.id, { status: "failed", error: "Agent timed out after launch" });
    expect(poolRows("cto").map((row) => row.task_id)).toEqual([tasks[1]!.id, tasks[2]!.id, tasks[0]!.id]);

    const same = store.createTaskPromptDispatch(tick.id, "cto", false);
    expect(same).toMatchObject({ claimed: false, id: dispatch.id, status: "failed" });
  });

  it("keeps the old :00/:20/:40 helper for read-only history while removing the global interval from active config", () => {
    expect(nextTaskPromptTickAt(Date.parse("2026-08-06T02:19:00.000Z"), 8, 17)).toBe("2026-08-06T02:20:00.000Z");
    expect(nextTaskPromptTickAt(Date.parse("2026-08-06T09:40:00.000Z"), 8, 17)).toBe("2026-08-07T00:00:00.000Z");
    expect(resolveConfig(undefined).taskRollingPrompts).toEqual({
      enabled: true,
      startHour: 8,
      endHour: 17,
      timeZone: "Asia/Shanghai",
    });
  });
});

describe("rolling prompt session arbitration", () => {
  it("skips a busy main session without moving the head, then rotates after a later confirmed start", async () => {
    store.close();
    let busy = true;
    const invoke = vi.fn(async () => ({
      ok: false as const,
      code: "timeout" as const,
      error: "timed out after Agent run started",
      attempts: 1,
    }));
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os-service.sqlite"),
      allowedAgentIds: ["main"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      runtimeConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      agentInvoker: { invoke },
      isSessionActive: () => busy,
    });
    const task = service.store.createRootTask({
      title: "回转寿司任务",
      description: "验证忙碌跳过",
      acceptanceCriteria: "池首不丢失",
      assigneeId: "main",
    });
    try {
      await service.dispatchTaskPromptTick("2030-01-01T02:20:00.000Z");
      expect(invoke).not.toHaveBeenCalled();
      expect(service.store.db.prepare("SELECT status FROM task_prompt_dispatches WHERE task_id IS NULL").get())
        .toMatchObject({ status: "skipped_busy" });
      expect(service.store.db.prepare("SELECT task_id, prompt_count FROM task_prompt_pool_items").get())
        .toMatchObject({ task_id: task.id, prompt_count: 0 });

      busy = false;
      await service.dispatchTaskPromptTick("2030-01-01T02:40:00.000Z");
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(service.store.db.prepare("SELECT status, started FROM task_prompt_dispatches WHERE task_id = ?").get(task.id))
        .toMatchObject({ status: "failed", started: 1 });
      expect(service.store.db.prepare("SELECT prompt_count FROM task_prompt_pool_items WHERE task_id = ?").get(task.id))
        .toMatchObject({ prompt_count: 1 });

      await service.dispatchTaskPromptTick("2030-01-01T02:40:00.000Z");
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      await service.stop();
      // afterEach closes the original store handle; the service owns a second DB.
      store = new CompanyOsStore({
        databasePath: path.join(directory, "company-os.sqlite"),
        allowedAgentIds: ["main", "cto", "eng-a"],
        config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      });
    }
  });

  it("lets an earlier immediate notification hold the main session and makes the rolling tick skip", async () => {
    store.close();
    let finish!: (value: { ok: true; text: string; raw: {}; attempts: number }) => void;
    const invoke = vi.fn(() => new Promise<{ ok: true; text: string; raw: {}; attempts: number }>((resolve) => { finish = resolve; }));
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os-coordinator.sqlite"),
      allowedAgentIds: ["main"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      runtimeConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      agentInvoker: { invoke },
      isSessionActive: () => false,
    });
    const task = service.store.createRootTask({
      title: "即时通知优先占位",
      description: "先发生的调度先执行",
      acceptanceCriteria: "滚动点跳过",
      assigneeId: "main",
    });
    service.store.startTask("main", task.id);
    service.store.submitTask("main", task.id, "提交验收", PROOF, VERIFIED_GIT);
    try {
      service.reviewTask("boss", task.id, "reject", "需要整改");
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      await service.dispatchTaskPromptTick("2030-01-01T03:00:00.000Z");
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(service.store.db.prepare(`
        SELECT status FROM task_prompt_dispatches WHERE scheduled_at = '2030-01-01T03:00:00.000Z'
      `).get()).toMatchObject({ status: "skipped_busy" });
      expect(service.store.db.prepare("SELECT prompt_count FROM task_prompt_pool_items WHERE task_id = ?").get(task.id))
        .toMatchObject({ prompt_count: 0 });
      finish({ ok: true, text: "已处理", raw: {}, attempts: 1 });
      await waitFor(() => expect(service.store.readTask("boss", task.id, false).reviewNotificationDispatch?.status).toBe("succeeded"));
    } finally {
      await service.stop();
      store = new CompanyOsStore({
        databasePath: path.join(directory, "company-os.sqlite"),
        allowedAgentIds: ["main", "cto", "eng-a"],
        config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      });
    }
  });

  it("skips hosts and participants of an active meeting without moving the pool head", async () => {
    store.close();
    const invoke = vi.fn(async () => ({ ok: true as const, text: "不应发送", raw: {}, attempts: 1 }));
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os-meeting-busy.sqlite"),
      allowedAgentIds: ["main", "cto"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      runtimeConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      agentInvoker: { invoke },
      isSessionActive: () => false,
    });
    service.store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
    const meeting = service.store.requestMeeting("main", {
      type: "discussion",
      title: "架构讨论会",
      agenda: "讨论系统架构",
      participants: [{ agentId: "cto", role: "advisor" }],
    }).meeting;
    const task = service.store.createRootTask({
      title: "会议期间不派发",
      description: "验证参会者忙碌判定",
      acceptanceCriteria: "池首保持不动",
      assigneeId: "cto",
    });
    try {
      expect(service.store.meetingView(meeting.id).status).toBe("active");
      await service.dispatchTaskPromptTick("2030-01-01T03:20:00.000Z");

      expect(invoke).not.toHaveBeenCalled();
      expect(service.store.db.prepare(`
        SELECT status, last_error FROM task_prompt_dispatches
        WHERE target_member_id = 'cto' AND scheduled_at = '2030-01-01T03:20:00.000Z'
      `).get()).toMatchObject({
        status: "skipped_busy",
        last_error: expect.stringContaining(meeting.id),
      });
      expect(service.store.db.prepare("SELECT task_id, prompt_count FROM task_prompt_pool_items WHERE member_id = 'cto'").get())
        .toMatchObject({ task_id: task.id, prompt_count: 0 });
    } finally {
      await service.stop();
      store = new CompanyOsStore({
        databasePath: path.join(directory, "company-os.sqlite"),
        allowedAgentIds: ["main", "cto", "eng-a"],
        config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      });
    }
  });
});

function poolRows(memberId?: string) {
  return store.db.prepare(`
    SELECT member_id, task_id, kind, queue_seq, prompt_count
    FROM task_prompt_pool_items ${memberId ? "WHERE member_id = ?" : ""}
    ORDER BY member_id, queue_seq
  `).all(...(memberId ? [memberId] : [])) as Array<Record<string, unknown>>;
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
