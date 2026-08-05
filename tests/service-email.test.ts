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
});
