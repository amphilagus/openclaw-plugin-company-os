import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CompanyOsStore, nextTaskCheckinRunAt } from "../src/store.js";
import { resolveConfig } from "../src/types.js";

const AGENTS = ["main", "cto", "eng-a"];
const PROOF = [{ type: "proof" as const, label: "tests", command: "npm test" }];
const TEN_AM = "2030-01-01T02:00:00.000Z";

let directory: string;
let store: CompanyOsStore;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "company-os-checkin-"));
  store = new CompanyOsStore({
    databasePath: path.join(directory, "company-os.sqlite"),
    allowedAgentIds: AGENTS,
    config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
  });
  store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
  store.addMember("main", { agentId: "eng-a", name: "工程师", title: "工程师", managerId: "cto" });
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function root(title: string) {
  return store.createRootTask({ title, description: `${title}说明`, acceptanceCriteria: `${title}标准`, assigneeId: "cto" });
}

describe("hourly task check-in store", () => {
  it("resolves the default schedule and rejects an inverted configured window", () => {
    expect(resolveConfig(undefined).taskHourlyCheckins).toEqual({
      enabled: true,
      startHour: 8,
      endHour: 17,
      timeZone: "Asia/Shanghai",
    });
    expect(resolveConfig({ taskHourlyCheckins: { enabled: false, startHour: 10, endHour: 12 } }).taskHourlyCheckins)
      .toMatchObject({ enabled: false, startHour: 10, endHour: 12 });
    expect(() => resolveConfig({ taskHourlyCheckins: { startHour: 18, endHour: 8 } })).toThrow(/must not be later/);
  });

  it("calculates future Beijing hourly slots without startup catch-up", () => {
    expect(nextTaskCheckinRunAt(Date.parse("2026-08-06T00:30:00.000Z"), 8, 17)).toBe("2026-08-06T01:00:00.000Z");
    expect(nextTaskCheckinRunAt(Date.parse("2026-08-06T09:00:00.000Z"), 8, 17)).toBe("2026-08-07T00:00:00.000Z");
    expect(nextTaskCheckinRunAt(Date.parse("2026-08-06T00:00:00.000Z"), 8, 17)).toBe("2026-08-06T01:00:00.000Z");
  });

  it("creates at most three spaced slots, replaces stale candidates, and rotates unseen tasks first", () => {
    const tasks = ["A", "B", "C", "D", "E"].map(root);
    tasks.forEach((task, index) => {
      store.db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?")
        .run(`2029-12-31T0${index}:00:00.000Z`, task.id);
    });

    const firstRun = store.queueTaskCheckinRun(TEN_AM);
    const ctoBatch = firstRun.batches.find((batch) => batch.targetMemberId === "cto");
    expect(ctoBatch?.candidateCount).toBe(5);
    expect(firstRun.dispatches.filter((dispatch) => dispatch.targetMemberId === "cto").map((dispatch) => dispatch.scheduledAt))
      .toEqual(["2030-01-01T02:00:00.000Z", "2030-01-01T02:15:00.000Z", "2030-01-01T02:30:00.000Z"]);

    const first = store.claimNextTaskCheckinDispatch(Date.parse(TEN_AM));
    expect(first).toMatchObject({ targetMemberId: "cto", taskId: tasks[0]!.id, actionKind: "execute" });
    expect(first?.prompt).toContain("本次只推进下面这一项任务");
    store.completeTaskCheckinDispatch(first!.id);

    const late = root("整点后新增");
    store.db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?")
      .run("2029-12-01T00:00:00.000Z", late.id);
    store.cancelTask("boss", tasks[1]!.id, "candidate became irrelevant");
    const second = store.claimNextTaskCheckinDispatch(Date.parse("2030-01-01T02:15:00.000Z"));
    expect(second).toMatchObject({ taskId: tasks[2]!.id });
    store.completeTaskCheckinDispatch(second!.id);
    const third = store.claimNextTaskCheckinDispatch(Date.parse("2030-01-01T02:30:00.000Z"));
    expect(third).toMatchObject({ taskId: tasks[3]!.id });
    store.completeTaskCheckinDispatch(third!.id);

    store.queueTaskCheckinRun("2030-01-01T03:00:00.000Z");
    const nextCycle = store.claimNextTaskCheckinDispatch(Date.parse("2030-01-01T03:00:00.000Z"));
    expect(nextCycle).toMatchObject({ taskId: late.id });
  });

  it("orders review and execution candidates by their shared waiting clock and sends one-task prompts", () => {
    const parent = root("父任务");
    const child = store.createChildTask("cto", {
      title: "待验收子任务",
      description: "子任务说明",
      acceptanceCriteria: "子任务标准",
      parentId: parent.id,
      assigneeId: "eng-a",
    });
    store.startTask("eng-a", child.id);
    store.submitTask("eng-a", child.id, "完成", PROOF);
    store.db.prepare("UPDATE tasks SET submitted_at = ?, last_activity_at = ? WHERE id = ?")
      .run("2029-12-30T00:00:00.000Z", "2029-12-30T00:00:00.000Z", child.id);
    store.db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?")
      .run("2029-12-31T00:00:00.000Z", parent.id);

    const run = store.queueTaskCheckinRun(TEN_AM);
    const candidates = run.batches.find((batch) => batch.targetMemberId === "cto")?.candidates as Array<{ taskId: string; actionKind: string }>;
    expect(candidates.slice(0, 2)).toEqual([
      expect.objectContaining({ taskId: child.id, actionKind: "review" }),
      expect.objectContaining({ taskId: parent.id, actionKind: "execute" }),
    ]);
    const dispatch = store.claimNextTaskCheckinDispatch(Date.parse(TEN_AM));
    expect(dispatch).toMatchObject({ taskId: child.id, actionKind: "review" });
    expect(dispatch?.prompt).toContain("本次只处理下面这一项任务验收");
    expect(dispatch?.prompt).toContain("company_task_review");
    expect(dispatch?.prompt).not.toContain(parent.id);
  });

  it("records empty runs and retries a relevant dispatch at most three times", () => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(path.join(os.tmpdir(), "company-os-checkin-empty-"));
    store = new CompanyOsStore({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: ["main"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
    });
    const empty = store.queueTaskCheckinRun(TEN_AM);
    expect(empty.batches).toEqual([]);
    expect(empty.dispatches).toEqual([]);
    expect(store.listAudit("task_checkin", empty.id)[0]?.action).toBe("task.checkin_empty");

    const task = store.createRootTask({ title: "重试任务", description: "说明", acceptanceCriteria: "标准", assigneeId: "main" });
    store.queueTaskCheckinRun("2030-01-01T03:00:00.000Z");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const dispatch = store.claimNextTaskCheckinDispatch(Date.parse("2030-01-01T03:00:00.000Z"));
      expect(dispatch).toMatchObject({ taskId: task.id, attempts: attempt });
      expect(store.failTaskCheckinDispatch(dispatch!.id, `failure ${attempt}`)).toBe(attempt < 3);
    }
    expect(store.db.prepare("SELECT status, attempts FROM task_checkin_dispatches WHERE task_id = ?").get(task.id))
      .toMatchObject({ status: "failed", attempts: 3 });

    store.queueTaskCheckinRun("2030-01-01T04:00:00.000Z");
    const interrupted = store.claimNextTaskCheckinDispatch(Date.parse("2030-01-01T04:00:00.000Z"));
    expect(interrupted).toMatchObject({ status: "running", attempts: 1 });
    expect(store.recoverTaskCheckinDispatches()).toBe(1);
    const recovered = store.claimNextTaskCheckinDispatch(Date.parse("2030-01-01T04:00:00.000Z"));
    expect(recovered).toMatchObject({ id: interrupted!.id, status: "running", attempts: 2 });
    expect(store.listAudit("task_checkin", recovered!.runId).map((event) => event.action))
      .toContain("task.checkin_dispatch_recovered");
  });
});

describe("Boss task check-in digest", () => {
  it("contains every current root review and risk and repeats them in the next hourly run", () => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(path.join(os.tmpdir(), "company-os-checkin-boss-"));
    store = new CompanyOsStore({
      databasePath: path.join(directory, "company-os.sqlite"),
      allowedAgentIds: AGENTS,
      config: resolveConfig(undefined),
    });
    store.addMember("main", { agentId: "cto", name: "CTO", title: "首席技术官", managerId: "boss" });
    store.addMember("main", { agentId: "eng-a", name: "工程师", title: "工程师", managerId: "cto" });

    const review = root("待 Boss 验收");
    store.startTask("cto", review.id);
    store.submitTask("cto", review.id, "完成", PROOF);
    const risk = root("异常根任务");
    const child = store.createChildTask("cto", {
      title: "阻塞子任务",
      description: "说明",
      acceptanceCriteria: "标准",
      parentId: risk.id,
      assigneeId: "eng-a",
    });
    store.blockTask("eng-a", child.id, "等待外部依赖");

    const run = store.queueTaskCheckinRun(TEN_AM);
    store.db.prepare("UPDATE task_checkin_dispatches SET status = 'skipped', completed_at = ? WHERE run_id = ? AND channel = 'agent'")
      .run(new Date().toISOString(), run.id);
    const boss = store.claimNextTaskCheckinDispatch(Date.parse(TEN_AM));
    expect(boss).toMatchObject({ targetMemberId: "boss", channel: "boss_email", actionKind: "boss_digest" });
    expect(boss?.emailNotification?.reviews.map((item) => item.taskId)).toContain(review.id);
    expect(boss?.emailNotification?.anomalies.map((item) => item.taskId)).toContain(risk.id);
    store.completeTaskCheckinDispatch(boss!.id);
    expect(store.taskCheckinSummary(Date.parse(TEN_AM)).boss.emailStatus).toBe("succeeded");

    const next = store.queueTaskCheckinRun("2030-01-01T03:00:00.000Z");
    const nextBossRow = next.dispatches.find((dispatch) => dispatch.channel === "boss_email");
    expect(nextBossRow).toMatchObject({ status: "pending" });
  });
});
