import { describe, expect, it } from "vitest";
import { resolveConfiguredAgentIds, resolveOrganizationAdminAgentId } from "../src/agent-config.js";

describe("OpenClaw agent config compatibility", () => {
  it("uses canonical map keys and never revives removed agents from a stale legacy list", () => {
    const config = { agents: {
      entries: { architect: { id: "wrong-id" }, engineer: {} },
      list: [{ id: "removed", default: true }],
      defaults: { systemAgent: { agentId: "architect" } },
    } };
    expect(resolveConfiguredAgentIds(config)).toEqual(["architect", "engineer"]);
    expect(resolveOrganizationAdminAgentId(config)).toBe("architect");
    expect(resolveConfiguredAgentIds({ agents: { ...config.agents, entries: {} } })).toEqual([]);
  });

  it("keeps an explicit organization admin separate from the system agent", () => {
    const config = { agents: {
      entries: { engineer: {}, architect: {} },
      defaults: { systemAgent: { agentId: "engineer" } },
    } };
    expect(resolveOrganizationAdminAgentId(config, " architect ")).toBe("architect");
    // A retired configured owner must reach the store's validation, not gain a fallback owner.
    expect(resolveOrganizationAdminAgentId(config, "retired")).toBe("retired");
  });

  it("preserves the default marker used by legacy configurations", () => {
    const config = { agents: { list: [{ id: "engineer" }, { id: "architect", default: true }] } };
    expect(resolveConfiguredAgentIds(config)).toEqual(["engineer", "architect"]);
    expect(resolveOrganizationAdminAgentId(config)).toBe("architect");
  });
});
