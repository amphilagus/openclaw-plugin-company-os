import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const [{ default: entry }, { COMPANY_TOOL_NAMES }] = await Promise.all([
  import(path.join(root, "dist", "index.js")),
  import(path.join(root, "dist", "tools.js")),
]);

assert(manifest.id === "company-os", "manifest id must be company-os");
assert(entry.id === manifest.id, "runtime and manifest plugin ids must match");
assert(pkg.version === manifest.version, "package and plugin manifest versions must match");
assert(typeof entry.register === "function", "native plugin entry must expose register(api)");
assert(pkg.peerDependencies?.openclaw === ">=2026.7.1", "OpenClaw peer dependency must be >=2026.7.1");
assert(JSON.stringify(manifest.contracts?.tools) === JSON.stringify(COMPANY_TOOL_NAMES), "manifest tool contracts must exactly match runtime tools");
assert(existsSync(path.join(root, "web", "dist", "index.html")), "built WebUI index is missing");

const registered = { tools: [], services: [], routes: [], tabs: [], gatewayMethods: [] };
entry.register({
  id: "company-os",
  rootDir: root,
  runtime: {},
  session: {
    controls: { registerControlUiDescriptor: (descriptor) => registered.tabs.push(descriptor) },
  },
  registerTool: (_factory, options) => registered.tools.push(options?.name),
  registerService: (service) => registered.services.push(service),
  registerHttpRoute: (route) => registered.routes.push(route),
  registerGatewayMethod: (method, handler, options) => registered.gatewayMethods.push({ method, handler, options }),
});

assert(JSON.stringify(registered.tools) === JSON.stringify(COMPANY_TOOL_NAMES), "not all company_* tools were registered");
assert(registered.services.length === 1 && registered.services[0].id === "company-os", "CompanyOsService registration is missing");
const apiRoute = registered.routes.find((route) => route.path === "/plugins/company-os/api/v1");
const webRoute = registered.routes.find((route) => route.path === "/plugins/company-os-ui");
assert(registered.routes.length === 2, "Company OS must register separate API and WebUI routes");
assert(apiRoute?.auth === "gateway", "Gateway-authenticated API route is missing");
assert(apiRoute?.gatewayRuntimeScopeSurface === "trusted-operator", "API route must use trusted operator scope propagation");
assert(webRoute?.auth === "plugin", "Plugin-served WebUI route is missing");
assert(registered.tabs[0]?.path === "/plugins/company-os-ui/meeting-room", "Control UI tab must target the public WebUI shell");
assert(registered.tabs.length === 1 && registered.tabs[0].requiredScopes?.includes("operator.write"), "Control UI tab must require operator.write");
assert(registered.gatewayMethods.length === 1, "Company OS authenticated Gateway bridge is missing");
assert(registered.gatewayMethods[0].method === "companyOs.api", "Company OS Gateway bridge method name is invalid");
assert(registered.gatewayMethods[0].options?.scope === "operator.write", "Company OS Gateway bridge must require operator.write");

console.log(`company-os validation passed: ${registered.tools.length} tools, 1 service, 1 authenticated Gateway bridge, 2 isolated HTTP routes, 1 Control UI tab`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
