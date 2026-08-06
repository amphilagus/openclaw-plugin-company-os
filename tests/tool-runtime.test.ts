import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import entry from "../src/index.js";
import { CompanyOsStore } from "../src/store.js";
import { createCompanyOsTools } from "../src/tools.js";
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
    let agentEndHook: any;
    const databasePath = path.join(stateDir, "plugins", "company-os", "company-os.sqlite");
    const seeded = new CompanyOsStore({
      databasePath,
      allowedAgentIds: ["jia-goushi", "engineer"],
      organizationAdminAgentId: "jia-goushi",
      config: resolveConfig(undefined),
    });
    seeded.close();
    const config = { agents: { list: [{ id: "jia-goushi", default: true }, { id: "engineer" }] } };
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
      on: (name: string, handler: any) => {
        if (name === "agent_end") agentEndHook = handler;
      },
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
    expect(JSON.stringify(notice)).toContain('"authorId":"jia-goushi"');

    const fixture = new CompanyOsStore({ databasePath, allowedAgentIds: ["jia-goushi", "engineer"], organizationAdminAgentId: "jia-goushi", config: resolveConfig(undefined) });
    const meeting = fixture.requestMeeting("jia-goushi", {
      type: "discussion",
      title: "主持人工具水位",
      agenda: "验证工具结果推进水位",
    }).meeting;
    fixture.close();
    const meetingSession = {
      agentId: "jia-goushi",
      sessionKey: "agent:jia-goushi:main",
      sessionId: "session-jia-goushi-main",
      config,
    };
    const speak = tools.get("company_meeting_speak")!(meetingSession);
    expect(Object.keys((speak.parameters as any).properties)).toEqual(["body"]);
    const delegate = tools.get("company_meeting_delegate")!(meetingSession);
    expect(Object.keys((delegate.parameters as any).properties).sort()).toEqual(["prompt", "speakerId"]);
    const drafts = tools.get("company_meeting_set_task_drafts")!(meetingSession);
    expect(Object.keys((drafts.parameters as any).properties)).toEqual(["drafts"]);
    const end = tools.get("company_meeting_end")!(meetingSession);
    expect(Object.keys((end.parameters as any).properties).sort()).toEqual(["publishNotice", "summary"]);
    const speakResult = await speak.execute("call-3", { body: "主持人已经回应" });
    const verification = new CompanyOsStore({ databasePath, allowedAgentIds: ["jia-goushi", "engineer"], organizationAdminAgentId: "jia-goushi", config: resolveConfig(undefined) });
    expect(speakResult).toMatchObject({ terminate: true });
    expect(JSON.stringify(speakResult)).toContain('"accepted":true');
    expect(JSON.stringify(speakResult)).toContain('"receipt":"成功，本轮会话结束"');
    expect(verification.db.prepare(`SELECT status, formatted_text FROM meeting_session_context_appends WHERE meeting_id = ?`).get(meeting.id))
      .toMatchObject({
        status: "pending",
        formatted_text: "【消息 #000002｜主持人发言事件】\n你（架构师）：\n主持人已经回应",
      });
    expect(agentEndHook).toBeTypeOf("function");
    verification.close();
    await serviceRegistration.stop();
  });

  it("routes agent task reviews through the service dispatcher", async () => {
    const task = { id: "task-child", status: "closed", reviewNotificationDispatch: { status: "pending" } };
    const reviewTask = vi.fn(() => task);
    const service = {
      store: { requireAgentMember: vi.fn(() => ({ id: "cto" })) },
      reviewTask,
    } as any;
    const reviewTool = createCompanyOsTools({
      getService: () => service,
      toolContext: { agentId: "cto" } as any,
    }).find((tool) => tool.name === "company_task_review")!;

    const result = await reviewTool.execute("call-review", {
      taskId: "task-child",
      decision: "reject",
      feedback: "需要补充证据",
    });

    expect(reviewTask).toHaveBeenCalledWith("cto", "task-child", "reject", "需要补充证据");
    expect(JSON.stringify(result)).toContain('"reviewNotificationDispatch":{"status":"pending"}');
  });
});
