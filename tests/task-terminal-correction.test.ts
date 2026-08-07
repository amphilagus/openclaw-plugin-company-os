import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CompanyOsStore } from "../src/store.js";
import { resolveConfig } from "../src/types.js";

const PROOF = [{ type: "proof" as const, label: "tests", command: "npm test" }];
const PASS_REPORT = {
  checks: [{ criterion: "测试通过", outcome: "pass" as const, evidenceIndexes: [0], finding: "测试命令可复核" }],
  conclusion: "满足验收标准",
};
const FAIL_REPORT = {
  checks: [{ criterion: "测试通过", outcome: "fail" as const, evidenceIndexes: [], finding: "覆盖不足", remediation: "补充失败路径测试" }],
  conclusion: "二次审查不通过",
};

let directory: string;
let store: CompanyOsStore;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "company-os-correction-"));
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

describe("structured reviews and terminal correction", () => {
  it("requires a non-Boss reviewer to inspect the current submission and provide evidence-based checks", () => {
    const { child } = createSubmittedChild();
    expect(() => store.reviewTask("cto", child.id, "accept", "通过", PASS_REPORT)).toThrow(/must read/);
    store.readTask("cto", child.id);
    expect(() => store.reviewTask("cto", child.id, "accept", "通过", {
      checks: [{ criterion: "测试通过", outcome: "pass", evidenceIndexes: [], finding: "没有引用证据" }],
      conclusion: "通过",
    })).toThrow(/cite evidence/);
    expect(store.reviewTask("cto", child.id, "accept", "证据完整", PASS_REPORT).status).toBe("closed");
    expect(store.readTask("boss", child.id, false).submissions[0]).toMatchObject({
      status: "accepted",
      reviewReport: { conclusion: "满足验收标准" },
    });
  });

  it("reopens a closed descendant and every closed/review ancestor while preserving accepted submissions", () => {
    const { root, child } = createSubmittedChild();
    store.readTask("cto", child.id);
    store.reviewTask("cto", child.id, "accept", "子任务通过", PASS_REPORT);
    store.submitTask("cto", root.id, "根任务完成", PROOF);
    store.reviewTask("boss", root.id, "accept", "根任务通过");

    const corrected = store.correctTaskTerminalDecision("boss", child.id, "revoke_acceptance", "发现关键失败路径未覆盖");
    expect(corrected.status).toBe("in_progress");
    expect(store.readTask("boss", root.id, false).status).toBe("in_progress");
    expect(store.readTask("boss", child.id, false).submissions[0]?.status).toBe("accepted");
    expect(store.readTask("boss", root.id, false).submissions[0]?.status).toBe("accepted");
    expect(corrected.corrections[0]).toMatchObject({
      action: "revoke_acceptance",
      impacts: expect.arrayContaining([
        expect.objectContaining({ taskId: child.id, statusBefore: "closed", statusAfter: "in_progress" }),
        expect.objectContaining({ taskId: root.id, statusBefore: "closed", statusAfter: "in_progress" }),
      ]),
    });
    expect(store.db.prepare(`
      SELECT target_agent_id, kind FROM task_agent_dispatches
      WHERE source_event_id = ? ORDER BY target_agent_id
    `).all(corrected.corrections[0]!.id)).toEqual([
      expect.objectContaining({ target_agent_id: "cto", kind: "acceptance_revoked" }),
      expect.objectContaining({ target_agent_id: "eng-a", kind: "acceptance_revoked" }),
    ]);
    expect(store.db.prepare("SELECT member_id, task_id, kind FROM task_prompt_pool_items").all())
      .toEqual([expect.objectContaining({ member_id: "eng-a", task_id: child.id, kind: "execution" })]);
  });

  it("invalidates an ancestor's pending submission when a closed descendant fails second review", () => {
    const { root, child } = createSubmittedChild();
    store.readTask("cto", child.id);
    store.reviewTask("cto", child.id, "accept", "子任务通过", PASS_REPORT);
    store.submitTask("cto", root.id, "根任务待验收", PROOF);

    store.correctTaskTerminalDecision("boss", child.id, "revoke_acceptance", "子任务证据后来失效");
    const parent = store.readTask("boss", root.id, false);
    expect(parent.status).toBe("in_progress");
    expect(parent.submissions[0]).toMatchObject({ status: "invalidated" });
    expect(parent.submissions[0]?.feedback).toContain("子任务证据后来失效");
  });

  it("lets the original reviewer revoke their own acceptance with a failed report and restores cancellation exactly", () => {
    const { child } = createSubmittedChild();
    store.readTask("cto", child.id);
    store.reviewTask("cto", child.id, "accept", "初次通过", PASS_REPORT);
    expect(() => store.correctTaskTerminalDecision("eng-a", child.id, "revoke_acceptance", "越权", FAIL_REPORT))
      .toThrow(/original reviewer/);
    expect(store.correctTaskTerminalDecision("cto", child.id, "revoke_acceptance", "复查发现问题", FAIL_REPORT).status)
      .toBe("in_progress");

    const canceled = store.cancelTask("cto", child.id, "短期不再执行");
    expect(canceled.status).toBe("canceled");
    expect(store.correctTaskTerminalDecision("cto", child.id, "restore_cancellation", "恢复投入").status)
      .toBe("in_progress");
    expect(store.readTask("boss", child.id, false).cancellationEvents[0]).toMatchObject({
      statusBefore: "in_progress",
      restoredBy: "cto",
    });
  });

  it("routes blocked cancellation through a Boss request and restores the approved cancellation to blocked", () => {
    const { child } = createSubmittedChild(false);
    store.blockTask("eng-a", child.id, "外部依赖停机");
    expect(() => store.cancelTask("cto", child.id, "终止任务")).toThrow(/Boss cancellation request/);
    const request = store.requestTaskCancellation("cto", child.id, "依赖长期不可用");
    expect(request.status).toBe("pending");
    expect(store.reviewTaskCancellationRequest("boss", child.id, request.id, "accept", "批准").task.status).toBe("canceled");
    expect(store.correctTaskTerminalDecision("boss", child.id, "restore_cancellation", "依赖已经恢复").status).toBe("blocked");
  });
});

function createSubmittedChild(submit = true) {
  const root = store.createRootTask({
    title: "根任务",
    description: "根任务说明",
    acceptanceCriteria: "子任务完成",
    assigneeId: "cto",
  });
  store.startTask("cto", root.id);
  const child = store.createChildTask("cto", {
    parentId: root.id,
    title: "子任务",
    description: "子任务说明",
    acceptanceCriteria: "测试通过",
    assigneeId: "eng-a",
  });
  store.startTask("eng-a", child.id);
  if (submit) store.submitTask("eng-a", child.id, "子任务完成", PROOF);
  return { root, child };
}
