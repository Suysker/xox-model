import type { PlannerContext } from '../planning-context.js'
import type { RuntimePlannerStep, ReadDraft } from '../action-draft-builder.js'
import { getTenantMemory, searchTenantMemory, summarizeMemoryToolItems } from './memory-backend.js'

function maxResultsFromStep(step: RuntimePlannerStep) {
  const explicit = typeof step.maxResults === 'number'
    ? step.maxResults
    : typeof step.limit === 'number'
      ? step.limit
      : null
  return Math.max(1, Math.min(20, explicit ?? 8))
}

export async function runMemorySearchTool(ctx: PlannerContext, step: RuntimePlannerStep): Promise<ReadDraft> {
  const query = typeof step.query === 'string' && step.query.trim()
    ? step.query.trim()
    : typeof step.question === 'string' && step.question.trim()
      ? step.question.trim()
      : ctx.message
  const result = await searchTenantMemory({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    query,
    maxResults: maxResultsFromStep(step),
    includeDailyNotes: step.includeDailyNotes !== false,
    includeDurable: step.includeDurable !== false,
  })
  return {
    title: '搜索记忆',
    message: summarizeMemoryToolItems(result.items),
    readKind: 'tool_observation',
    displayPreview: result.items.length > 0 ? `找到 ${result.items.length} 条相关记忆。` : '没有找到相关记忆。',
    status: 'executed',
  }
}

export async function runMemoryGetTool(ctx: PlannerContext, step: RuntimePlannerStep): Promise<ReadDraft> {
  const memoryId = typeof step.memoryId === 'string'
    ? step.memoryId
    : typeof step.id === 'string'
      ? step.id
      : ''
  if (!memoryId) {
    return {
      title: '读取记忆',
      message: '缺少 memoryId，无法读取记忆。',
      readKind: 'tool_observation',
      status: 'info',
    }
  }
  const result = await getTenantMemory({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    memoryId,
  })
  return {
    title: '读取记忆',
    message: result.item ? summarizeMemoryToolItems([result.item]) : '没有找到这条记忆，或当前用户/工作区无权读取。',
    readKind: 'tool_observation',
    displayPreview: result.item ? result.item.title : '未找到记忆。',
    status: result.item ? 'executed' : 'info',
  }
}
