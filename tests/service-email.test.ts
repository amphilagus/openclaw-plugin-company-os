import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CompanyOsService } from "../src/service.js";
import { resolveConfig } from "../src/types.js";

describe("meeting email outbox", () => {
  it("delivers and acknowledges both direct-participation meeting notifications", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-service-email-"));
    const send = vi.fn(async () => undefined);
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main", "cto"],
      config: resolveConfig(undefined),
      runtimeConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      meetingEmailSender: { send },
    });
    try {
      service.store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
      const result = service.store.requestMeeting("cto", {
        type: "discussion",
        title: "Boss 邮件提醒测试",
        agenda: "验证两阶段提醒",
        bossParticipates: true,
      });

      await service.dispatchAdvance(result.advance);

      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls.map(([notification]) => notification.kind)).toEqual(["created", "room_entered"]);
      expect(service.store.pendingMeetingEmailNotifications()).toEqual([]);
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("immediately emails Boss when a level-one employee submits a root task", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-task-review-email-"));
    const send = vi.fn(async () => undefined);
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main", "cto"],
      config: resolveConfig(undefined),
      runtimeConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      meetingEmailSender: { send },
    });
    try {
      service.store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
      const task = service.store.createRootTask({
        title: "根任务提交邮件",
        description: "提交时通知 Boss",
        acceptanceCriteria: "邮件包含验收信息",
        assigneeId: "cto",
      });
      service.store.startTask("cto", task.id);
      service.submitTask("cto", task.id, "已经完成", [{ type: "proof", label: "tests", command: "npm test" }]);

      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        kind: "task_review_requested",
        taskId: task.id,
        assigneeId: "cto",
        summary: "已经完成",
      }));
      await waitFor(() => expect(service.store.db.prepare(`
        SELECT status, attempts FROM task_review_email_notifications WHERE task_id = ?
      `).get(task.id)).toMatchObject({ status: "sent", attempts: 1 }));
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries a persisted root-task review email after Gateway restart", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-task-review-email-recovery-"));
    const databasePath = path.join(directory, "company-os.sqlite");
    const failedSend = vi.fn(async () => { throw new Error("temporary SMTP failure"); });
    let service = new CompanyOsService({
      databasePath,
      allowedAgentIds: ["main", "cto"],
      config: resolveConfig(undefined),
      runtimeConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      meetingEmailSender: { send: failedSend },
    });
    try {
      service.store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
      const task = service.store.createRootTask({
        title: "重启恢复邮件",
        description: "SMTP 临时失败",
        acceptanceCriteria: "重启后送达",
        assigneeId: "cto",
      });
      service.store.startTask("cto", task.id);
      service.submitTask("cto", task.id, "等待 Boss 验收", [{ type: "proof", label: "tests", command: "npm test" }]);
      await waitFor(() => expect(service.store.db.prepare(`
        SELECT status, attempts FROM task_review_email_notifications WHERE task_id = ?
      `).get(task.id)).toMatchObject({ status: "failed", attempts: 1 }));
      expect(failedSend).toHaveBeenCalledTimes(1);
      await service.stop();

      const recoveredSend = vi.fn(async () => undefined);
      service = new CompanyOsService({
        databasePath,
        allowedAgentIds: ["main", "cto"],
        config: resolveConfig(undefined),
        runtimeConfig: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        meetingEmailSender: { send: recoveredSend },
      });
      await service.start();
      await waitFor(() => expect(service.store.db.prepare(`
        SELECT status, attempts FROM task_review_email_notifications WHERE task_id = ?
      `).get(task.id)).toMatchObject({ status: "sent", attempts: 2 }));
      expect(recoveredSend).toHaveBeenCalledTimes(1);
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("immediately emails Boss for a root blockage and a blocked child cancellation request", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-task-action-email-"));
    const send = vi.fn(async () => undefined);
    const service = new CompanyOsService({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main", "cto", "eng-a"],
      config: resolveConfig(undefined),
      runtimeConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      meetingEmailSender: { send },
      agentInvoker: { invoke: vi.fn(async () => ({ ok: true as const, text: "handled", raw: {}, attempts: 1 })) },
    });
    try {
      service.store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
      service.store.addMember("main", { agentId: "eng-a", name: "工程师", title: "工程师", managerId: "cto" });
      const root = service.store.createRootTask({
        title: "根任务阻塞",
        description: "需要 Boss 协调",
        acceptanceCriteria: "依赖恢复",
        assigneeId: "cto",
      });
      service.store.startTask("cto", root.id);
      service.blockTask("cto", root.id, "需要 Boss 开通外部资源");
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "task_block_escalated", taskId: root.id }));

      service.unblockTask("boss", root.id, "资源已开通");
      const child = service.store.createChildTask("cto", {
        parentId: root.id,
        title: "长期阻塞子任务",
        description: "等待外部系统",
        acceptanceCriteria: "系统恢复",
        assigneeId: "eng-a",
      });
      service.store.startTask("eng-a", child.id);
      service.blockTask("eng-a", child.id, "供应商停止服务");
      const result = service.cancelTask("cto", child.id, "没有替代供应商");
      expect(result.outcome).toBe("approval_requested");
      await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "task_cancel_requested", taskId: child.id }));
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

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
