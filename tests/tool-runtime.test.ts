import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import entry from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("agent tool runtime lifecycle", () => {
  it("opens the shared store lazily when Gateway services are not started in the tool process", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "company-os-tool-runtime-"));
    temporaryDirectories.push(stateDir);
    const tools = new Map<string, (context: any) => any>();
    let serviceRegistration: any;
    const config = { agents: { list: [{ id: "main" }, { id: "engineer" }] } };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    entry.register!({
      id: "company-os",
      name: "Company OS",
      config,
      pluginConfig: {},
      rootDir: path.resolve("."),
      logger,
      runtime: { state: { resolveStateDir: () => stateDir } },
      session: {
        workflow: {
          scheduleSessionTurn: vi.fn(),
          unscheduleSessionTurnsByTag: vi.fn(),
        },
        controls: { registerControlUiDescriptor: vi.fn() },
      },
      registerTool: (factory: any, options: any) => tools.set(options.name, factory),
      registerService: (registration: any) => { serviceRegistration = registration; },
      registerGatewayMethod: vi.fn(),
      registerHttpRoute: vi.fn(),
    } as any);

    const factory = tools.get("company_org_list");
    expect(factory).toBeTypeOf("function");
    const tool = factory!({ agentId: "main", config });
    const result = await tool.execute("call-1", {});

    expect(JSON.stringify(result)).toContain("架构师");
    expect(JSON.stringify(result)).not.toContain("service is not running");
    await serviceRegistration.stop();
  });
});
