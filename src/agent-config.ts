type ConfiguredAgent = Record<string, unknown> & { id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function agentSection(config: unknown) {
  return isRecord(config) && isRecord(config.agents) ? config.agents : undefined;
}

/** Canonical entries take precedence, including an intentionally empty map. */
export function resolveConfiguredAgents(config: unknown): ConfiguredAgent[] {
  const agents = agentSection(config);
  if (isRecord(agents?.entries)) {
    return Object.entries(agents.entries).flatMap(([key, value]) => {
      const id = nonEmptyString(key);
      return id && isRecord(value) ? [{ ...value, id }] : [];
    });
  }
  if (!Array.isArray(agents?.list)) return [];
  return agents.list.flatMap((value) => {
    if (!isRecord(value)) return [];
    const id = nonEmptyString(value.id);
    return id ? [{ ...value, id }] : [];
  });
}

export function resolveConfiguredAgentIds(config: unknown) {
  return resolveConfiguredAgents(config).map((agent) => agent.id);
}

export function resolveConfiguredAgent(config: unknown, agentId: string) {
  return resolveConfiguredAgents(config).find((agent) => agent.id === agentId);
}

export function resolveOrganizationAdminAgentId(config: unknown, configured?: string) {
  const explicit = nonEmptyString(configured);
  if (explicit) return explicit;
  const defaults = agentSection(config)?.defaults;
  const systemAgent = isRecord(defaults) ? defaults.systemAgent : undefined;
  const systemAgentId = isRecord(systemAgent) ? nonEmptyString(systemAgent.agentId) : undefined;
  if (systemAgentId) return systemAgentId;

  const agents = resolveConfiguredAgents(config);
  const selected = agents.find((agent) => agent.default === true);
  return selected?.id ?? agents.find((agent) => agent.id === "main")?.id ?? agents[0]?.id ?? "main";
}
