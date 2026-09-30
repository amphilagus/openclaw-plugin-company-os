import { describe, expect, it } from "vitest";
import { addShanghaiWorkMinutes, isShanghaiWorkTime, remainingShanghaiWorkMilliseconds } from "../src/work-hours.js";
import { nextTaskPromptTickAt } from "../src/store.js";
import { resolveConfig } from "../src/types.js";

const at = (local: string) => Date.parse(`${local}+08:00`);

describe("Shanghai recurring work windows", () => {
  it.each([
    ["2026-09-23T21:59:59", false], ["2026-09-23T22:00:00", true],
    ["2026-09-24T00:00:00", true], ["2026-09-24T05:59:59", true],
    ["2026-09-24T06:00:00", false], ["2026-09-24T12:00:00", false],
  ])("treats %s as inside=%s for 22:00–06:00", (local, inside) => {
    expect(isShanghaiWorkTime(at(local), 22, 5)).toBe(inside);
  });

  it.each([
    [22, 5, "2026-09-23T12:00:00", 10, "2026-09-23T22:10:00"],
    [22, 5, "2026-09-23T23:55:00", 10, "2026-09-24T00:05:00"],
    [22, 5, "2026-09-24T02:00:00", 10, "2026-09-24T02:10:00"],
    [22, 5, "2026-09-24T05:55:00", 10, "2026-09-24T22:05:00"],
    [22, 5, "2026-09-24T05:55:00", 5, "2026-09-24T22:00:00"],
    [22, 5, "2026-09-24T06:00:00", 0, "2026-09-24T22:00:00"],
    [22, 5, "2026-12-31T23:55:00", 10, "2027-01-01T00:05:00"],
    [22, 5, "2026-09-23T22:00:00", 970, "2026-09-25T22:10:00"],
    [8, 17, "2026-09-23T17:55:00", 10, "2026-09-24T08:05:00"],
    [8, 17, "2026-09-23T17:55:00", 5, "2026-09-24T08:00:00"],
    [22, 23, "2026-09-23T23:55:00", 10, "2026-09-24T22:05:00"],
    [0, 23, "2026-09-23T23:55:00", 10, "2026-09-24T00:05:00"],
    [6, 5, "2026-09-24T05:55:00", 10, "2026-09-24T06:05:00"],
    [2, 2, "2026-09-24T02:55:00", 10, "2026-09-25T02:05:00"],
  ])("counts only work minutes for %i..%i from %s + %i", (start, end, from, minutes, expected) => {
    const due = addShanghaiWorkMinutes(at(from), minutes, start, end);
    expect(due).toBe(new Date(at(expected)).toISOString());
    expect(remainingShanghaiWorkMilliseconds(at(from), Date.parse(due), start, end)).toBe(minutes * 60_000);
    expect(isShanghaiWorkTime(Date.parse(due), start, end)).toBe(true);
  });

  it("preserves sub-minute precision and freezes remaining work during the daytime gap", () => {
    const due = at("2026-09-24T22:05:00.250");
    expect(addShanghaiWorkMinutes(at("2026-09-24T05:55:00.250"), 10, 22, 5)).toBe(new Date(due).toISOString());
    expect(remainingShanghaiWorkMilliseconds(at("2026-09-24T12:00:00"), due, 22, 5)).toBe(300_250);
    expect(remainingShanghaiWorkMilliseconds(due, due, 22, 5)).toBe(0);
  });

  it("accepts overnight configuration and legacy tick helpers across midnight", () => {
    expect(resolveConfig({ taskRollingPrompts: { startHour: 22, endHour: 5 } }).taskRollingPrompts)
      .toMatchObject({ startHour: 22, endHour: 5 });
    expect(nextTaskPromptTickAt(at("2026-09-23T23:40:00"), 22, 5)).toBe(new Date(at("2026-09-24T00:00:00")).toISOString());
    expect(nextTaskPromptTickAt(at("2026-09-24T05:40:00"), 22, 5)).toBe(new Date(at("2026-09-24T22:00:00")).toISOString());
  });
});
