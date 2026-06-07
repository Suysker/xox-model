import type { AgentPlannerSource } from '@xox/contracts'
import type { PlannerContext } from './planning-context.js'
import {
  isActionDraft,
  type ActionDraftBuilderHandlers,
  type PlannedItem,
} from './action-draft-builder.js'
import type { RuntimePlanResult } from './runtime/runtime-adapter.js'
import { configuredRuntimePlannerSource, readDraftsFromRuntimeResult } from './runtime-plan-reader.js'
import { extractWorkspaceBundleArtifact } from './workspace-bundle-artifact.js'
import { superviseRuntimeToolCalls } from './tool-runtime/tool-call-supervisor.js'

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

function actionPayload(item: PlannedItem) {
  return isActionDraft(item) && item.payload && typeof item.payload === 'object'
    ? item.payload as Record<string, unknown>
    : null
}

function configureOperatingModelWorkspaceNames(items: PlannedItem[]) {
  return new Set(items.flatMap((item) => {
    const payload = actionPayload(item)
    return isActionDraft(item) &&
      item.kind === 'workspace.update_draft' &&
      payload?.source === 'workspace_configure_operating_model' &&
      typeof payload.workspaceName === 'string' &&
      payload.workspaceName.trim()
      ? [payload.workspaceName.trim()]
      : []
  }))
}

function removeRedundantWorkspaceRename(items: PlannedItem[]) {
  const configuredWorkspaceNames = configureOperatingModelWorkspaceNames(items)
  if (configuredWorkspaceNames.size === 0) return items
  return items.filter((item) => {
    if (!isActionDraft(item) || item.kind !== 'workspace.rename') return true
    const payload = actionPayload(item)
    const workspaceName = typeof payload?.workspaceName === 'string' ? payload.workspaceName.trim() : ''
    return !configuredWorkspaceNames.has(workspaceName)
  })
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
      items.push(...readDraftsFromRuntimeResult(result))
      continue
    }

    source =
      result.source === 'openai_agents' || source === 'openai_agents'
        ? 'openai_agents'
        : 'openai_compatible_tool_calls'

    const supervisorInput: Parameters<typeof superviseRuntimeToolCalls>[1] = {
      steps: result.steps,
      handlers: input.handlers,
      ...(result.toolInventorySnapshot ? { inventorySnapshot: result.toolInventorySnapshot } : {}),
    }
    const supervised = await superviseRuntimeToolCalls(planningCtx, supervisorInput)
    const partItems = supervised.items
    if (partItems.length > 0) {
      items.push(...partItems)
    } else if (requiredSource) {
      items.push(...readDraftsFromRuntimeResult(result))
    }
  }

  const normalizedItems = removeRedundantWorkspaceRename(items)
  return normalizedItems.length > 0
    ? { source: source ?? requiredSource ?? 'openai_compatible_tool_calls', items: normalizedItems }
    : null
}
