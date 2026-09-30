import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyOsStore } from "../src/store.js";
import { resolveConfig } from "../src/types.js";
import { executeBossApi } from "../src/boss-api.js";

const at = (local: string) => Date.parse(`${local}+08:00`);
const iso = (local: string) => new Date(at(local)).toISOString();
let directory: string;
let store: CompanyOsStore;
const openStore = () => new CompanyOsStore({
  databasePath: path.join(directory, "company-os.sqlite"), allowedAgentIds: ["main"],
  config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
});
const createTask = () => store.createRootTask({ title: "夜间任务", description: "夜间执行", acceptanceCriteria: "工作时间内投递", assigneeId: "main" });
const queue = () => store.taskPromptPoolSummary().queues.find((row) => row.memberId === "main")!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at("2026-09-23T12:00:00"));
  directory = mkdtempSync(path.join(os.tmpdir(), "company-os-overnight-"));
  store = openStore();
});
afterEach(() => {
  store.close();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

describe("overnight task prompt scheduling", () => {
  it("saves overnight hours through the Boss API, survives reopening, and restores defaults", async () => {
    createTask();
    const result = await executeBossApi({ setTaskPromptWorkHours: store.setTaskPromptWorkHours.bind(store) } as any, {
      method: "PUT", path: "/task-prompt-settings", body: { startHour: 22, endHour: 5 },
    });
    expect(result).toEqual({ status: 200, data: { startHour: 22, endHour: 5, workHoursSource: "boss_override" } });
    expect(queue()).toMatchObject({ nextDueAt: iso("2026-09-23T22:05:00"), remainingWorkMinutes: 5 });
    store.close(); store = openStore();
    expect(store.taskPromptPoolSummary()).toMatchObject({ startHour: 22, endHour: 5, workHoursSource: "boss_override" });
    expect(queue().nextDueAt).toBe(iso("2026-09-23T22:05:00"));
    expect(store.setTaskPromptWorkHours(null, null)).toEqual({ startHour: 8, endHour: 17, workHoursSource: "config_default" });
  });

  it("holds a new first item until night and dispatches across midnight without admitting daytime work", () => {
    store.setTaskPromptWorkHours(22, 5);
    createTask();
    expect(queue().nextDueAt).toBe(iso("2026-09-23T22:00:00"));
    expect(store.nextTaskPromptDueAt()).toBe(iso("2026-09-23T22:00:00"));
    expect(store.dueTaskPromptMembers()).toEqual([]);
    expect(() => store.createTaskPromptCycleDispatch("main", false)).toThrow(/outside work hours/);
    vi.setSystemTime(at("2026-09-23T22:00:00"));
    expect(store.dueTaskPromptMembers()).toEqual(["main"]);
    expect(store.createTaskPromptCycleDispatch("main", true)).toMatchObject({ claimed: false, status: "skipped_busy" });
    vi.setSystemTime(at("2026-09-23T23:55:00"));
    store.setTaskPromptInterval("main", 10);
    expect(queue().nextDueAt).toBe(iso("2026-09-24T00:05:00"));
    vi.setSystemTime(at("2026-09-24T00:05:00"));
    expect(store.createTaskPromptCycleDispatch("main", false)).toMatchObject({ claimed: true, status: "running" });
  });

  it("preserves remaining seconds when pausing and resuming across the daytime gap", () => {
    store.setTaskPromptWorkHours(22, 5);
    createTask();
    vi.setSystemTime(at("2026-09-24T05:55:00"));
    store.setTaskPromptInterval("main", 10);
    expect(queue()).toMatchObject({ nextDueAt: iso("2026-09-24T22:05:00"), remainingWorkMinutes: 10 });
    vi.setSystemTime(at("2026-09-24T05:57:30"));
    store.setTaskPromptPaused(true);
    vi.setSystemTime(at("2026-09-24T14:00:00"));
    expect(queue()).toMatchObject({ nextDueAt: null, remainingWorkMinutes: 8 });
    expect(store.dueTaskPromptMembers()).toEqual([]);
    store.setTaskPromptPaused(false);
    expect(queue().nextDueAt).toBe(iso("2026-09-24T22:07:30"));
  });

  it("defers overdue callbacks during daytime and recovers offline countdowns into the next shift", () => {
    store.setTaskPromptWorkHours(22, 5);
    createTask();
    vi.setSystemTime(at("2026-09-24T12:00:00"));
    expect(store.peekNextTaskPromptDueAt()).toBe(iso("2026-09-24T22:00:00"));
    expect(store.dueTaskPromptMembers()).toEqual([]);
    expect(store.recoverOverdueTaskPromptSchedules()).toBe(1);
    expect(queue()).toMatchObject({ nextDueAt: iso("2026-09-24T22:05:00"), lastDispatch: { status: "skipped_offline" } });
  });

  it.each([[-1, 5], [24, 5], [22, -1], [22, 24], [22.5, 5], [22, 5.5], [22, null]])("rejects invalid hours %s..%s", (start, end) => {
    expect(() => store.setTaskPromptWorkHours(start, end)).toThrow(/hours|integers/);
  });
});
