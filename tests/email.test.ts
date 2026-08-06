import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildTaskCheckinEmailText, loadSmtpSettings } from "../src/email.js";
import { resolveConfig } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Boss meeting email configuration", () => {
  it("reuses the shared QQ mail account and defaults delivery to the same mailbox", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-email-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, ".env");
    writeFileSync(configPath, "PROVIDER=qq\nUSERNAME=boss@qq.com\nPASSWORD=authorization-code\n");

    const config = resolveConfig({ bossEmailNotifications: { configPath } }).bossEmailNotifications;
    const settings = loadSmtpSettings(config);

    expect(settings).toMatchObject({
      host: "smtp.qq.com",
      port: 587,
      secure: false,
      user: "boss@qq.com",
      from: "boss@qq.com",
      recipient: "boss@qq.com",
    });
  });

  it("supports a named account and an explicit Boss recipient", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-email-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, ".env");
    writeFileSync(configPath, "WORK_PROVIDER=qq\nWORK_USERNAME=sender@qq.com\nWORK_PASSWORD=code\n");

    const config = resolveConfig({
      bossEmailNotifications: { configPath, account: "work", recipient: "boss@qq.com" },
    }).bossEmailNotifications;

    expect(loadSmtpSettings(config)).toMatchObject({ user: "sender@qq.com", recipient: "boss@qq.com" });
  });
});

describe("Boss task check-in email", () => {
  it("renders every review and anomaly in one actionable digest", () => {
    const text = buildTaskCheckinEmailText({
      id: "dispatch-1",
      kind: "task_checkin",
      runId: "run-1",
      scheduledAt: "2026-08-06T02:00:00.000Z",
      reviews: [{
        taskId: "review-1",
        title: "根任务验收",
        assigneeId: "cto",
        assigneeName: "CTO",
        status: "review",
        submittedAt: "2026-08-06T01:30:00.000Z",
        lastActivityAt: "2026-08-06T01:30:00.000Z",
        blocked: false,
        stale: false,
        blockedDescendants: 0,
        staleDescendants: 0,
      }],
      anomalies: [{
        taskId: "risk-1",
        title: "异常根任务",
        assigneeId: "cto",
        assigneeName: "CTO",
        status: "in_progress",
        submittedAt: null,
        lastActivityAt: "2026-08-01T01:00:00.000Z",
        blocked: false,
        stale: true,
        blockedDescendants: 1,
        staleDescendants: 2,
      }],
    });

    expect(text).toContain("待验收根任务（1）");
    expect(text).toContain("根任务验收");
    expect(text).toContain("异常根任务（1）");
    expect(text).toContain("根任务停滞、阻塞后代 1、停滞后代 2");
    expect(text).toContain("公司 → 任务");
  });
});
