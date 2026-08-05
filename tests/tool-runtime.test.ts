import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import entry from "../src/index.js";
import { CompanyOsStore } from "../src/store.js";
import { resolveConfig } from "../src/types.js";

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
    const databasePath = path.join(stateDir, "plugins", "company-os", "company-os.sqlite");
    const seeded = new CompanyOsStore({ databasePath, allowedAgentIds: ["main", "jia-goushi", "engineer"], config: resolveConfig(undefined) });
    seeded.db.prepare("UPDATE members SET agent_id = 'jia-goushi' WHERE id = 'main'").run();
    seeded.close();
    const config = { agents: { list: [{ id: "jia-goushi" }, { id: "engineer" }] } };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    entry.register!({
      id: "company-os",
      name: "Company OS",
      config,
      pluginConfig: {},
      rootDir: path.resolve("."),
      logger,
      runtime: { state: { resolveStateDir: () => stateDir } },
      session: { controls: { registerControlUiDescriptor: vi.fn() } },
      registerTool: (factory: any, options: any) => tools.set(options.name, factory),
      registerService: (registration: any) => { serviceRegistration = registration; },
      registerGatewayMethod: vi.fn(),
      registerHttpRoute: vi.fn(),
    } as any);

    const factory = tools.get("company_org_list");
    expect(factory).toBeTypeOf("function");
    const tool = factory!({ agentId: "jia-goushi", config });
    const result = await tool.execute("call-1", {});

    expect(JSON.stringify(result)).toContain("架构师");
    expect(JSON.stringify(result)).not.toContain("service is not running");
    const publish = tools.get("company_notice_publish")!({ agentId: "jia-goushi", config });
    const notice = await publish.execute("call-2", { title: "身份映射", body: "使用真实 Agent ID 调用" });
    expect(JSON.stringify(notice)).toContain('"authorId":"main"');

    const fixture = new CompanyOsStore({ databasePath, allowedAgentIds: ["main", "jia-goushi", "engineer"], config: resolveConfig(undefined) });
    const meeting = fixture.requestMeeting("main", {
      type: "discussion",
      title: "主持人工具水位",
      agenda: "验证工具结果推进水位",
    }).meeting;
    fixture.close();
    const speak = tools.get("company_meeting_speak")!({ agentId: "jia-goushi", config });
    await speak.execute("call-3", { meetingId: meeting.id, body: "主持人已经回应" });
    const verification = new CompanyOsStore({ databasePath, allowedAgentIds: ["main", "jia-goushi", "engineer"], config: resolveConfig(undefined) });
    expect(verification.db.prepare(`
      SELECT sequence FROM meeting_context_watermarks WHERE meeting_id = ? AND member_id = 'main'
    `).get(meeting.id)).toMatchObject({ sequence: 2 });
    verification.close();
    await serviceRegistration.stop();
  });
});
