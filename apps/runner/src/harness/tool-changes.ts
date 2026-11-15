import { createHash } from 'node:crypto'
import { asSchema, type ToolSet } from 'ai'

// A resumed conversation keeps the definitions of Brigade's tools it was given, whatever the
// runner serves now. Claude Code sends a deferred tool's definition as it first sent it for the
// rest of the conversation, in each new process too (the transcript's deferred_tools_record:
// "seeded … deferred tool(s) the previous process sent"), and a new tool search finds that one
// again. Codex keeps a thread's dynamic tools from its thread/start: thread/resume and turn/start
// take none. So after an update that changes a tool (computer_act's `steps`, Nov 15), the next
// message tells the teammate what changed, with each tool's current description and input.

/** A tool as the harness gives it to Claude Code or Codex (HarnessAgent's toolSpecs). */
export type ToolSpec = { name: string; description?: string; inputSchema?: unknown }

/** Each tool's definition as the harness sends it: its description and its input's JSON Schema. */
export function toolSpecs(tools: ToolSet): ToolSpec[] {
  return Object.entries(tools).map(([name, tool]) => {
    let inputSchema: unknown
    try {
      inputSchema = tool.inputSchema == null ? undefined : asSchema(tool.inputSchema).jsonSchema
    } catch {}
    // The harness sends a description as it is; Brigade's are text.
    const description = typeof tool.description === 'string' ? tool.description : undefined
    return { name, description, inputSchema }
  })
}

/** Each tool's definition, by name, as a short hash: what a conversation was given (SavedState). */
export function toolDigests(specs: readonly ToolSpec[]): Record<string, string> {
  return Object.fromEntries(
    specs.map((spec) => [
      spec.name,
      createHash('sha256')
        .update(JSON.stringify([spec.description ?? null, spec.inputSchema ?? null]))
        .digest('base64url')
        .slice(0, 16),
    ]),
  )
}

/**
 * The tools whose definition changed since the conversation was given the `known` ones. A tool
 * it never had is not one: new tools reach it as any do, and gone ones are refused when called.
 */
export function changedTools(
  known: Record<string, string> | undefined,
  specs: readonly ToolSpec[],
): ToolSpec[] {
  if (!known) return []
  const digests = toolDigests(specs)
  return specs.filter(
    (spec) => known[spec.name] !== undefined && known[spec.name] !== digests[spec.name],
  )
}

/**
 * A resumed conversation saved before the runner kept what it was given: which of its tools
 * changed is not known, so it is given Brigade's own as they are now, once. Not the Apps' (`apps`),
 * which come from the API rather than the runner an update brings. Smallest first: past the
 * note's room, the biggest go by name.
 */
export function toolsOfUnknownAge(
  specs: readonly ToolSpec[],
  apps: ReadonlySet<string>,
): ToolSpec[] {
  const size = (spec: ToolSpec) =>
    (spec.description?.length ?? 0) + JSON.stringify(spec.inputSchema ?? {}).length
  return specs.filter((spec) => !apps.has(spec.name)).sort((a, b) => size(a) - size(b))
}

/** How much of a message the changed tools' definitions may take; the rest go by name. */
export const TOOL_CHANGES_MAX_CHARS = 40_000

/** The note that goes before the next message, or none when nothing changed. */
export function toolChangesNote(
  changed: readonly ToolSpec[],
  {
    max = TOOL_CHANGES_MAX_CHARS,
    unsure = false,
  }: {
    max?: number
    /** Which changed is not known (toolsOfUnknownAge): they are the current ones, whether or not changed. */
    unsure?: boolean
  } = {},
): string | undefined {
  if (changed.length === 0) return
  const shown: string[] = []
  const named: string[] = []
  let used = 0
  for (const spec of changed) {
    const entry =
      `### ${spec.name}\n\n${spec.description ?? '(no description)'}\n\n` +
      `Input (JSON Schema): ${JSON.stringify(spec.inputSchema ?? {})}`
    if (used + entry.length > max) named.push(spec.name)
    else {
      shown.push(entry)
      used += entry.length
    }
  }
  return (
    '<brigade-tool-changes>\n' +
    (unsure
      ? 'Brigade may have updated some of your tools since they were first described to you in this conversation. ' +
        'These are their current definitions. Where your tool list shows another description or input, what follows replaces it. '
      : 'Brigade updated some of your tools since they were first described to you in this conversation. ' +
        'Your tool list may still show their old description and input: what follows replaces them. ') +
    'Calls with the inputs below work, the new ones included.\n\n' +
    shown.join('\n\n') +
    (named.length
      ? `${shown.length ? '\n\n' : ''}${unsure ? 'These may have changed' : 'These changed'} too, but their definitions did not fit here: ${named.join(', ')}. ` +
        'A call to one of them that is refused says what it expects.'
      : '') +
    '\n</brigade-tool-changes>'
  )
}
