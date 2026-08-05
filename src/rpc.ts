import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";

import { executeBossApi } from "./boss-api.js";
import type { CompanyOsService } from "./service.js";

export const COMPANY_OS_GATEWAY_METHOD = "companyOs.api";

type GatewayRequestHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

export function createCompanyOsGatewayHandler(options: { getService: () => CompanyOsService }): GatewayRequestHandler {
  return async ({ params, respond }) => {
    try {
      const method = readString(params.method, "method");
      const path = readString(params.path, "path");
      const service = options.getService();

      if (method.toUpperCase() === "GET" && path === "/events") {
        const lastEventId = readOptionalEventId(params.lastEventId);
        if (lastEventId === undefined) {
          respond(true, { changed: false, lastEventId: service.latestEventId() });
          return;
        }
        const events = await service.waitForEventsAfter(lastEventId, 20_000);
        respond(true, {
          changed: events.length > 0,
          lastEventId: events.at(-1)?.id ?? lastEventId,
        });
        return;
      }

      const result = await executeBossApi(service, { method, path, body: params.body });
      respond(true, result.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes("service is not running") ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST;
      respond(false, undefined, errorShape(code, message));
    }
  };
}

function readString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function readOptionalEventId(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("lastEventId must be a non-negative integer");
  }
  return value;
}
