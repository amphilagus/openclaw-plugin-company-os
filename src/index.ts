import os from "node:os";
import path from "node:path";

import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { Type } from "typebox";

import { createCompanyOsHttpHandler } from "./http.js";
import { CompanyOsService } from "./service.js";
import { COMPANY_TOOL_NAMES, createCompanyOsTools } from "./tools.js";
import { resolveConfig, type CompanyOsConfig } from "./types.js";

const PLUGIN_ID = "company-os";
const SQLITE_FILE = "company-os.sqlite";

const ConfigSchema = Type.Object({
  participantTurnTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 60, default: 600 })),
  hostIdleTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 60, default: 1800 })),
  taskStaleAfterHours: Type.Optional(Type.Integer({ minimum: 1, default: 72 })),
  databasePath: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const entry: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: PLUGIN_ID,
  name: "Company OS",
  description: "公司级会议、多级任务和告示板治理系统。",
  configSchema: buildJsonPluginConfigSchema(ConfigSchema as never),
  register(api) {
    let service: CompanyOsService | undefined;
    const getService = () => {
      if (!service) throw new Error("Company OS service is not running");
      return service;
    };

    for (const name of COMPANY_TOOL_NAMES) {
      api.registerTool(
        (toolContext) => createCompanyOsTools({ getService, toolContext }).find((tool) => tool.name === name),
        { name },
      );
    }

    api.registerService({
      id: PLUGIN_ID,
      start: async (context) => {
        const config = resolveConfig(api.pluginConfig as CompanyOsConfig | undefined);
        const databasePath = resolveDatabasePath(api, config.databasePath, context.stateDir);
        service = new CompanyOsService({
          databasePath,
          allowedAgentIds: resolveConfiguredAgentIds(context.config),
          config,
          workflow: api.session.workflow,
          logger: context.logger,
        });
        await service.start();
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
      path: "/plugins/company-os/meeting-room",
      requiredScopes: ["operator.write"],
    });

    api.registerHttpRoute({
      path: "/plugins/company-os",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createCompanyOsHttpHandler({
        getService,
        staticDir: path.join(api.rootDir ?? process.cwd(), "web", "dist"),
      }),
    });
  },
});

export default entry;

function resolveDatabasePath(api: OpenClawPluginApi, configured: string | undefined, serviceStateDir: string) {
  if (configured) {
    const expanded = configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(2)) : configured;
    return path.resolve(expanded);
  }
  const runtime = api.runtime as unknown as { state?: { resolveStateDir?: () => string } };
  const stateDir = runtime.state?.resolveStateDir?.() ?? serviceStateDir;
  return path.join(stateDir, "plugins", PLUGIN_ID, SQLITE_FILE);
}

function resolveConfiguredAgentIds(config: unknown) {
  const list = (config as { agents?: { list?: Array<{ id?: unknown }> } } | undefined)?.agents?.list ?? [];
  return list.flatMap((agent) => typeof agent.id === "string" && agent.id.trim() ? [agent.id.trim()] : []);
}
