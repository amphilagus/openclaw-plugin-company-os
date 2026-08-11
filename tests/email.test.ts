import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildTaskCheckinEmailText, buildTaskReviewEmailText, loadSmtpSettings } from "../src/email.js";
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

describe("Boss root-task review email", () => {
  it("renders the submitter, acceptance criteria, summary, evidence, and review action", () => {
    const text = buildTaskReviewEmailText({
      id: "email-1",
      kind: "task_review_requested",
      taskId: "task-root",
      submissionId: "submission-1",
      title: "上线 Company OS",
      acceptanceCriteria: "完整构建和测试通过",
      assigneeId: "cto",
      assigneeName: "CTO",
      submittedAt: "2026-08-06T06:30:00.000Z",
      summary: "根任务已经完成",
      evidence: [{ type: "proof", label: "tests", command: "npm test" }],
      gitLocation: {
        remoteUrl: "https://git.example.test/company/company-os.git",
        branch: "agents/root-task",
        commit: "a".repeat(40),
        verifiedAt: "2026-08-06T06:29:00.000Z",
      },
      attachments: [{ evidenceIndex: 0, fileName: "report.pdf", byteSize: 1234, sha256: "b".repeat(64), data: Buffer.from("report") }],
      functionalVerification: {
        workingDirectory: "/workspace/cto/project",
        command: "npm run verify",
        oneLineCommand: "cd -- '/workspace/cto/project' && npm run verify",
      },
    });

    expect(text).toContain("一级员工已提交根任务验收");
    expect(text).toContain("上线 Company OS");
    expect(text).toContain("CTO (cto)");
    expect(text).toContain("完整构建和测试通过");
    expect(text).toContain("根任务已经完成");
    expect(text).toContain("https://git.example.test/company/company-os.git");
    expect(text).toContain("agents/root-task");
    expect(text).toContain("a".repeat(40));
    expect(text).toContain("应由 Boss 在本验收阶段执行");
    expect(text).toContain("不是负责人提交前的前置条件");
    expect(text).toContain("[proof] tests — npm test");
    expect(text).toContain("report.pdf · 证据 #1 · 1234 bytes");
    expect(text).toContain("cd -- '/workspace/cto/project' && npm run verify");
    expect(text).toContain("验收通过、驳回整改或判定任务失败");
  });
});
