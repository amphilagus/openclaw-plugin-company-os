import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CompanyOsService } from "../src/service.js";
import { resolveConfig } from "../src/types.js";
import { GIT_INPUT, fakeGitRemoteVerifier } from "./test-git.js";

const PROOF = [{ type: "proof" as const, label: "tests", command: "npm test" }];

describe("task review handoff", () => {
  it("freezes child-task files and delivers versioned review material to the issuer workspace", async () => {
    const fixture = createFixture();
    try {
      const { service, ctoWorkspace, engineerWorkspace } = fixture;
      const { child } = createChildTask(service);
      writeFileSync(path.join(engineerWorkspace, "result.txt"), "frozen-result", "utf8");

      await service.submitTask("eng-a", child.id, "子任务已经完成", [
        ...PROOF,
        { type: "artifact", label: "result", path: "result.txt" },
      ], GIT_INPUT, {
        functionalVerification: { workingDirectory: ".", command: "npm test -- --runInBand" },
      });

      const firstReadme = path.join(ctoWorkspace, "验收材料", child.id, service.store.readTask("cto", child.id, false).submissions[0]!.id, "README.md");
      await waitFor(() => expect(existsSync(firstReadme)).toBe(true));
      const detail = service.store.readTask("cto", child.id, false);
      expect(detail.submissions[0]?.reviewHandoff).toMatchObject({
        files: [{ evidenceIndex: 1, fileName: "result.txt", sourcePath: "result.txt", byteSize: 13 }],
        functionalVerification: { command: "npm test -- --runInBand" },
        delivery: { channel: "issuer_workspace", status: "delivered", targetPath: realpathSync(firstReadme) },
      });
      expect(readFileSync(path.join(path.dirname(firstReadme), "files", "result.txt"), "utf8")).toBe("frozen-result");
      expect(readFileSync(firstReadme, "utf8")).toContain("company_task_review");
      expect(readFileSync(firstReadme, "utf8")).toContain("cd -- '");
      expect(readFileSync(path.join(ctoWorkspace, "验收材料", child.id, "CURRENT.md"), "utf8")).toContain(detail.submissions[0]!.id);

      service.store.readTask("cto", child.id);
      service.reviewTask("cto", child.id, "reject", "需要第二版", {
        checks: [{ criterion: "结果", outcome: "fail", evidenceIndexes: [0], finding: "版本不完整", remediation: "重新生成" }],
        conclusion: "驳回",
      });
      writeFileSync(path.join(engineerWorkspace, "result.txt"), "second-version", "utf8");
      await service.submitTask("eng-a", child.id, "第二版完成", [
        ...PROOF,
        { type: "artifact", label: "result", path: path.join(engineerWorkspace, "result.txt") },
      ], GIT_INPUT);
      const second = service.store.readTask("cto", child.id, false).submissions[0]!;
      const secondReadme = path.join(ctoWorkspace, "验收材料", child.id, second.id, "README.md");
      await waitFor(() => expect(existsSync(secondReadme)).toBe(true));
      expect(existsSync(firstReadme)).toBe(true);
      expect(readFileSync(path.join(ctoWorkspace, "验收材料", child.id, "CURRENT.md"), "utf8")).toContain(second.id);
    } finally {
      await fixture.dispose();
    }
  });

  it("attaches frozen root-task files and the one-line command to the Boss email", async () => {
    const send = vi.fn(async () => undefined);
    const fixture = createFixture(send);
    try {
      const { service, ctoWorkspace } = fixture;
      const root = service.store.createRootTask({
        title: "根任务验收包",
        description: "发送给 Boss",
        acceptanceCriteria: "附件和命令均可用",
        assigneeId: "cto",
      });
      service.store.startTask("cto", root.id);
      writeFileSync(path.join(ctoWorkspace, "report.md"), "# frozen report", "utf8");
      await service.submitTask("cto", root.id, "请 Boss 验收", [
        ...PROOF,
        { type: "artifact", label: "report", path: "report.md" },
      ], GIT_INPUT, {
        functionalVerification: { workingDirectory: ".", command: "npm run verify" },
      });

      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send.mock.calls[0]![0]).toMatchObject({
        kind: "task_review_requested",
        attachments: [{ evidenceIndex: 1, fileName: "report.md", byteSize: 15 }],
        functionalVerification: { command: "npm run verify" },
      });
      expect(send.mock.calls[0]![0].attachments[0].data.toString("utf8")).toBe("# frozen report");
      await waitFor(() => expect(service.store.readTask("boss", root.id, false).submissions[0]?.reviewHandoff?.delivery.status).toBe("delivered"));
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects unsafe source paths and multiline commands without partial submission writes", async () => {
    const fixture = createFixture();
    try {
      const { service, directory, engineerWorkspace } = fixture;
      const { child } = createChildTask(service);
      const outside = path.join(directory, "outside.txt");
      writeFileSync(outside, "secret", "utf8");
      await expect(service.submitTask("eng-a", child.id, "unsafe", [
        { type: "artifact", label: "outside", path: outside },
      ], GIT_INPUT))
        .rejects.toThrow(/inside the submitter workspace/);
      symlinkSync(outside, path.join(engineerWorkspace, "outside-link.txt"));
      await expect(service.submitTask("eng-a", child.id, "unsafe symlink", [
        { type: "artifact", label: "outside link", path: "outside-link.txt" },
      ], GIT_INPUT)).rejects.toThrow(/inside the submitter workspace/);
      writeFileSync(path.join(engineerWorkspace, "empty.txt"), "");
      await expect(service.submitTask("eng-a", child.id, "empty", [
        { type: "artifact", label: "empty", path: "empty.txt" },
      ], GIT_INPUT)).rejects.toThrow(/is empty/);
      mkdirSync(path.join(engineerWorkspace, "a"));
      mkdirSync(path.join(engineerWorkspace, "b"));
      writeFileSync(path.join(engineerWorkspace, "a", "same.txt"), "a");
      writeFileSync(path.join(engineerWorkspace, "b", "same.txt"), "b");
      await expect(service.submitTask("eng-a", child.id, "duplicate names", [
        { type: "artifact", label: "a", path: "a/same.txt" },
        { type: "artifact", label: "b", path: "b/same.txt" },
      ], GIT_INPUT)).rejects.toThrow(/duplicate file name/);
      expect(service.store.readTask("cto", child.id, false)).toMatchObject({ status: "in_progress", submissions: [] });

      await expect(service.submitTask("eng-a", child.id, "unsafe command", PROOF, GIT_INPUT, {
        functionalVerification: { workingDirectory: engineerWorkspace, command: "npm test\necho done" },
      })).rejects.toThrow(/must be one line/);
      expect(service.store.readTask("cto", child.id, false)).toMatchObject({ status: "in_progress", submissions: [] });
    } finally {
      await fixture.dispose();
    }
  });

  it("enforces the file count, regular-file, and 15 MB limits", async () => {
    const fixture = createFixture();
    try {
      const { service, engineerWorkspace } = fixture;
      const { child } = createChildTask(service);
      for (let index = 0; index < 6; index += 1) writeFileSync(path.join(engineerWorkspace, `${index}.txt`), String(index));
      await expect(service.submitTask("eng-a", child.id, "too many", Array.from({ length: 6 }, (_, index) => ({
        type: "artifact" as const, label: `file-${index}`, path: `${index}.txt`,
      })), GIT_INPUT)).rejects.toThrow(/at most 5 files/);
      await expect(service.submitTask("eng-a", child.id, "directory", [
        { type: "artifact", label: "directory", path: "." },
      ], GIT_INPUT))
        .rejects.toThrow(/regular file/);
      writeFileSync(path.join(engineerWorkspace, "large.bin"), Buffer.alloc(15_000_001, 1));
      await expect(service.submitTask("eng-a", child.id, "too large", [
        { type: "artifact", label: "large", path: "large.bin" },
      ], GIT_INPUT))
        .rejects.toThrow(/15 MB total limit/);
      expect(service.store.readTask("cto", child.id, false)).toMatchObject({ status: "in_progress", submissions: [] });
      await service.submitTask("eng-a", child.id, "five files", Array.from({ length: 5 }, (_, index) => ({
        type: "artifact" as const, label: `file-${index}`, path: `${index}.txt`,
      })), GIT_INPUT);
      expect(service.store.readTask("cto", child.id, false).submissions[0]?.reviewHandoff?.files).toHaveLength(5);
    } finally {
      await fixture.dispose();
    }
  });

  it("accepts the exact 15 MB boundary and proof-only submissions without fabricating attachments", async () => {
    const send = vi.fn(async () => undefined);
    const fixture = createFixture(send);
    try {
      const exact = serviceRootTask(fixture.service, "15 MB boundary");
      writeFileSync(path.join(fixture.ctoWorkspace, "exact.bin"), Buffer.alloc(15_000_000, 1));
      await fixture.service.submitTask("cto", exact.id, "exact boundary", [
        { type: "artifact", label: "exact", path: "exact.bin" },
      ], GIT_INPUT);
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send.mock.calls[0]![0].attachments[0]).toMatchObject({ evidenceIndex: 0, byteSize: 15_000_000 });

      const proofOnly = serviceRootTask(fixture.service, "proof only");
      await fixture.service.submitTask("cto", proofOnly.id, "proof only", PROOF, GIT_INPUT);
      await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(send.mock.calls[1]![0].attachments).toEqual([]);
      expect(fixture.service.store.readTask("boss", proofOnly.id, false).submissions[0]?.reviewHandoff).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it("retries Boss email with frozen bytes after the source file changes", async () => {
    let attempt = 0;
    const send = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary smtp failure");
    });
    const fixture = createFixture(send);
    try {
      const root = serviceRootTask(fixture.service, "frozen retry");
      const source = path.join(fixture.ctoWorkspace, "retry.txt");
      writeFileSync(source, "frozen-version");
      await fixture.service.submitTask("cto", root.id, "retry", [
        { type: "artifact", label: "retry", path: "retry.txt" },
      ], GIT_INPUT);
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      writeFileSync(source, "changed-version");
      await (fixture.service as any).flushMeetingEmails();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]![0].attachments[0].data.toString("utf8")).toBe("frozen-version");
    } finally {
      await fixture.dispose();
    }
  });

  it("does not block review when workspace delivery fails", async () => {
    const fixture = createFixture(undefined, true);
    try {
      const { service, ctoWorkspace, engineerWorkspace } = fixture;
      const { child } = createChildTask(service);
      const source = path.join(engineerWorkspace, "result.txt");
      writeFileSync(source, "result", "utf8");
      await service.submitTask("eng-a", child.id, "可依据 Git 验收", [
        ...PROOF,
        { type: "artifact", label: "result", path: "result.txt" },
      ], GIT_INPUT);
      await waitFor(() => expect(service.store.readTask("cto", child.id, false).submissions[0]?.reviewHandoff?.delivery.status).toBe("failed"));

      service.store.readTask("cto", child.id);
      const reviewed = service.reviewTask("cto", child.id, "accept", "Git 证据已核验", {
        checks: [{ criterion: "测试", outcome: "pass", evidenceIndexes: [0], finding: "测试通过" }],
        conclusion: "通过",
      });
      expect(reviewed.status).toBe("closed");

      rmSync(source);
      mkdirSync(ctoWorkspace, { recursive: true });
      await waitFor(() => expect(service.store.readTask("cto", child.id, false).submissions[0]?.reviewHandoff?.delivery.status).toBe("delivered"), 3_000);
      const deliveredPath = service.store.readTask("cto", child.id, false).submissions[0]!.reviewHandoff!.delivery.targetPath!;
      expect(readFileSync(path.join(path.dirname(deliveredPath), "files", "result.txt"), "utf8")).toBe("result");
    } finally {
      await fixture.dispose();
    }
  });
});

function createFixture(send = vi.fn(async () => undefined), missingReviewerWorkspace = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-review-handoff-"));
  const ctoWorkspace = path.join(directory, "workspace-cto");
  const engineerWorkspace = path.join(directory, "workspace-eng-a");
  const mainWorkspace = path.join(directory, "workspace-main");
  for (const workspace of [ctoWorkspace, engineerWorkspace, mainWorkspace]) {
    if (!(missingReviewerWorkspace && workspace === ctoWorkspace)) {
      mkdirSync(workspace, { recursive: true });
    }
  }
  const service = new CompanyOsService({
    databasePath: path.join(directory, "company-os.sqlite"),
    allowedAgentIds: ["main", "cto", "eng-a"],
    config: resolveConfig(undefined),
    runtimeConfig: { agents: { list: [
      { id: "main", workspace: mainWorkspace },
      { id: "cto", workspace: ctoWorkspace },
      { id: "eng-a", workspace: engineerWorkspace },
    ] } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    meetingEmailSender: { send },
    gitRemoteVerifier: fakeGitRemoteVerifier,
  });
  service.store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
  service.store.addMember("main", { agentId: "eng-a", name: "工程师 A", title: "工程师", managerId: "cto" });
  return {
    directory,
    ctoWorkspace,
    engineerWorkspace,
    service,
    dispose: async () => {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createChildTask(service: CompanyOsService) {
  const root = service.store.createRootTask({
    title: "父任务",
    description: "集成子任务",
    acceptanceCriteria: "子任务完成",
    assigneeId: "cto",
  });
  service.store.startTask("cto", root.id);
  const child = service.store.createChildTask("cto", {
    parentId: root.id,
    title: "子任务",
    description: "生成验收材料",
    acceptanceCriteria: "文件内容正确",
    assigneeId: "eng-a",
  });
  service.store.startTask("eng-a", child.id);
  return { root, child };
}

function serviceRootTask(service: CompanyOsService, title: string) {
  const task = service.store.createRootTask({
    title,
    description: "review material test",
    acceptanceCriteria: "submission succeeds",
    assigneeId: "cto",
  });
  service.store.startTask("cto", task.id);
  return task;
}

async function waitFor(assertion: () => void, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
