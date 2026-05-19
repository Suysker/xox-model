import type { AgentPlannerSource } from '@xox/contracts'
import type { PlannerContext } from './planning-context.js'
import {
  buildPlannedItemFromRuntimeStep,
  type ActionDraftBuilderHandlers,
  type PlannedItem,
} from './action-draft-builder.js'
import type { RuntimePlanResult } from './runtime/runtime-adapter.js'
import { configuredRuntimePlannerSource, readDraftFromRuntimeResult } from './runtime-plan-reader.js'
import { extractWorkspaceBundleArtifact } from './workspace-bundle-artifact.js'

type RuntimePlanner = (ctx: PlannerContext) => Promise<RuntimePlanResult | null>

function isStepDelimiter(char: string) {
  return char === '；' || char === ';' || char === '\n'
}

function shouldPreserveDelimitersAsStructuredBrief(message: string) {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (message.length >= 1200 || lines.length >= 8) return true
  const startsWithNumberedMarker = (line: string) => {
    let index = 0
    while (index < line.length) {
      const code = line.charCodeAt(index)
      if (code < 48 || code > 57) break
      index += 1
    }
    if (index === 0) return false
    const marker = line[index]
    return marker === '.' || marker === ')' || marker === '、'
  }
  const listLikeLines = lines.filter((line) =>
    line.startsWith('-') ||
    line.startsWith('*') ||
    line.startsWith('•') ||
    startsWithNumberedMarker(line),
  )
  return listLikeLines.length >= 4
}

export function splitRequestedSteps(message: string) {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let inString = false
  let escaped = false
  const preserveStructuredDelimiters = shouldPreserveDelimitersAsStructuredBrief(message)

  for (let index = 0; index < message.length; index += 1) {
    const char = message[index] ?? ''
    if (inString) {
      current += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      current += char
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      current += char
      continue
    }
    if ((char === '}' || char === ']') && depth > 0) {
      depth -= 1
      current += char
      continue
    }
    if (depth === 0 && isStepDelimiter(char) && !preserveStructuredDelimiters) {
      const part = current.trim()
      if (part) parts.push(part)
      current = ''
      continue
    }
    current += char
  }

  const finalPart = current.trim()
  if (finalPart) parts.push(finalPart)
  return parts.length > 0 ? parts : [message]
}

export async function runPlanningSession(
  ctx: PlannerContext,
  input: { handlers: ActionDraftBuilderHandlers<PlannerContext>; callRuntimePlanner: RuntimePlanner },
): Promise<{ source: AgentPlannerSource; items: PlannedItem[] } | null> {
  const requiredSource = configuredRuntimePlannerSource(ctx.settings)
  const items: PlannedItem[] = []
  let source: AgentPlannerSource | null = null

  const requestedParts = ctx.planningTurn === 'evaluator_repair' ? [ctx.message] : splitRequestedSteps(ctx.message)
  for (const part of requestedParts) {
    const artifact = extractWorkspaceBundleArtifact(part)
    const baseCtx: PlannerContext = { ...ctx, message: part }
    const planningCtx: PlannerContext = artifact ? { ...baseCtx, providedWorkspaceBundle: artifact } : baseCtx
    const runtimeCtx: PlannerContext = artifact ? { ...planningCtx, message: artifact.messageForModel } : planningCtx
    const result = await input.callRuntimePlanner(runtimeCtx)

    if (!result || result.steps.length === 0) {
      if (!requiredSource) return null
      source = source ?? result?.source ?? requiredSource
      items.push(readDraftFromRuntimeResult(result))
      continue
    }

    source =
      result.source === 'openai_agents' || source === 'openai_agents'
        ? 'openai_agents'
        : 'openai_compatible_tool_calls'

    const partItems: PlannedItem[] = []
    for (const step of result.steps) {
      const item = await buildPlannedItemFromRuntimeStep(planningCtx, step, input.handlers)
      if (Array.isArray(item)) {
        partItems.push(...item)
      } else if (item) {
        partItems.push(item)
      }
    }
    if (partItems.length > 0) {
      items.push(...partItems)
    } else if (requiredSource) {
      items.push(readDraftFromRuntimeResult(result))
    }
  }

  return items.length > 0 ? { source: source ?? requiredSource ?? 'openai_compatible_tool_calls', items } : null
}
