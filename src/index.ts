import os from "node:os";
import path from "node:path";

import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { Type } from "typebox";

import {
  COMPANY_OS_API_PREFIX,
  COMPANY_OS_WEB_PREFIX,
  createCompanyOsApiHttpHandler,
  createCompanyOsWebHttpHandler,
} from "./http.js";
import { COMPANY_RULES_PROMPT } from "./company-rules.js";
import { COMPANY_OS_GATEWAY_METHOD, createCompanyOsGatewayHandler } from "./rpc.js";
import { CompanyOsService } from "./service.js";
import { COMPANY_TOOL_NAMES, createCompanyOsTools } from "./tools.js";
import { resolveConfig, type CompanyOsConfig } from "./types.js";

const PLUGIN_ID = "company-os";
const SQLITE_FILE = "company-os.sqlite";

const ConfigSchema = Type.Object({
  participantTurnTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 60, default: 600 })),
  hostIdleTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 60, default: 1800 })),
  meetingAutoEndDelaySeconds: Type.Optional(Type.Integer({ minimum: 1, default: 60 })),
  taskStaleAfterHours: Type.Optional(Type.Integer({ minimum: 1, default: 72 })),
  databasePath: Type.Optional(Type.String({ minLength: 1 })),
  organizationAdminAgentId: Type.Optional(Type.String({ minLength: 1 })),
  bossAvatarPath: Type.Optional(Type.String({ minLength: 1, default: "~/.openclaw/workspace-boss/avatar.png" })),
  bossEmailNotifications: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean({ default: true })),
    account: Type.Optional(Type.String({ minLength: 1, pattern: "^[A-Za-z0-9]+$" })),
    recipient: Type.Optional(Type.String({ minLength: 3 })),
    configPath: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const entry: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: PLUGIN_ID,
  name: "Company OS",
  description: "公司级会议、多级任务和告示板治理系统。",
  configSchema: buildJsonPluginConfigSchema(ConfigSchema as never),
  register(api) {
    let service: CompanyOsService | undefined;
    const getService = (
      runtimeConfig = api.config,
      stateDir?: string,
      logger = api.logger,
    ) => {
      if (!service) {
        const config = resolveConfig(api.pluginConfig as CompanyOsConfig | undefined);
        service = new CompanyOsService({
          databasePath: resolveDatabasePath(api, config.databasePath, stateDir),
          allowedAgentIds: resolveConfiguredAgentIds(runtimeConfig),
          config,
          runtimeConfig,
          logger,
        });
      }
      return service;
    };

    for (const name of COMPANY_TOOL_NAMES) {
      api.registerTool(
        (toolContext) => createCompanyOsTools({
          getService: () => getService(
            toolContext.getRuntimeConfig?.() ?? toolContext.runtimeConfig ?? toolContext.config ?? api.config,
          ),
          toolContext,
        }).find((tool) => tool.name === name),
        { name },
      );
    }

    api.on("before_prompt_build", async () => ({
      prependSystemContext: COMPANY_RULES_PROMPT,
    }));

    api.on("agent_end", async (_event, context) => {
      if (!service) return;
      const agentId = context.agentId?.trim();
      const sessionKey = context.sessionKey?.trim();
      const sessionId = context.sessionId?.trim();
      if (!agentId || !sessionKey || !sessionId) return;
      service.scheduleSessionContextAppendAfterTurn({ agentId, sessionKey, sessionId });
    });

    api.registerService({
      id: PLUGIN_ID,
      start: async (context) => {
        const databasePath = resolveDatabasePath(
          api,
          resolveConfig(api.pluginConfig as CompanyOsConfig | undefined).databasePath,
          context.stateDir,
        );
        await getService(context.config, context.stateDir, context.logger).start();
        context.logger.info(`company-os database ready: ${databasePath}`);
      },
      stop: async () => {
        await service?.stop();
        service = undefined;
      },
    });

    api.session.controls.registerControlUiDescriptor({
      id: "company",
      surface: "tab",
      label: "公司",
      description: "会议室、任务树与告示板",
      icon: "building-2",
      group: "control",
      order: 30,
      path: `${COMPANY_OS_WEB_PREFIX}/meeting-room`,
      requiredScopes: ["operator.write"],
    });

    api.registerGatewayMethod(
      COMPANY_OS_GATEWAY_METHOD,
      createCompanyOsGatewayHandler({ getService }),
      { scope: "operator.write" },
    );

    api.registerHttpRoute({
      path: COMPANY_OS_API_PREFIX,
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createCompanyOsApiHttpHandler({ getService }),
    });

    api.registerHttpRoute({
      path: COMPANY_OS_WEB_PREFIX,
      auth: "plugin",
      match: "prefix",
      handler: createCompanyOsWebHttpHandler({
        staticDir: path.join(api.rootDir ?? process.cwd(), "web", "dist"),
      }),
    });
  },
});

export default entry;

function resolveDatabasePath(api: OpenClawPluginApi, configured: string | undefined, serviceStateDir?: string) {
  if (configured) {
    const expanded = configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(2)) : configured;
    return path.resolve(expanded);
  }
  const stateDir = serviceStateDir ?? api.runtime.state.resolveStateDir();
  return path.join(stateDir, "plugins", PLUGIN_ID, SQLITE_FILE);
}

function resolveConfiguredAgentIds(config: unknown) {
  const list = (config as { agents?: { list?: Array<{ id?: unknown }> } } | undefined)?.agents?.list ?? [];
  return list.flatMap((agent) => typeof agent.id === "string" && agent.id.trim() ? [agent.id.trim()] : []);
}
