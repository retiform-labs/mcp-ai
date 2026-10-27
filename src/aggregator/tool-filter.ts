/**
 * Per-tool visibility filtering for aggregated MCP servers.
 *
 * One predicate, applied at one point (the roster assembly in
 * aggregator/services.ts). A filtered tool never enters the routing map, and
 * executeTool throws on an unknown name, so removal from the map IS the denial.
 */

/** Minimal shape of an MCP config entry needed to decide tool visibility. */
export type ToolFilterConfig = Readonly<{
  id: string
  allowTools?: readonly string[]
  denyTools?: readonly string[]
}>

/**
 * Decide whether one UPSTREAM tool name survives the filter.
 *
 * Deny wins over allow. An ABSENT allow list means no allow filtering; an
 * EMPTY allow list means deny everything -- a deliberate empty list is not an
 * unset one, and conflating the two would turn a lock-out into a no-op.
 */
export const isToolAllowed = (
  name: string,
  allow: readonly string[] | undefined,
  deny: readonly string[] | undefined
): boolean => {
  if (deny !== undefined && deny.includes(name)) {
    return false
  }
  if (allow === undefined) {
    return true
  }
  return allow.includes(name)
}

/**
 * Apply one MCP entry filter to its tool list.
 *
 * Any configured name that matched no upstream tool is recorded in unmatched
 * so the caller can warn. A security control that silently matches nothing is
 * worse than no control: it reads as protection while granting everything.
 */
export const filterTools = <T extends Readonly<{ name: string }>>(
  mcpId: string,
  tools: readonly T[],
  config: ToolFilterConfig | undefined,
  unmatched: Set<string>
): readonly T[] => {
  const allow = config?.allowTools
  const deny = config?.denyTools
  if (allow === undefined && deny === undefined) {
    return tools
  }

  const present = new Set(tools.map(t => t.name))
  const configured = (allow ?? []).concat(deny ?? [])
  configured.forEach(entry => {
    if (!present.has(entry)) {
      unmatched.add(mcpId + ':' + entry)
    }
  })

  return tools.filter(t => isToolAllowed(t.name, allow, deny))
}
