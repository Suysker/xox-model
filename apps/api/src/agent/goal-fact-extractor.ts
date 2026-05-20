import type { AgentGoalFacts } from '@xox/contracts'

function cleanValue(value: string) {
  return value
    .replace(/[。；;，,]+$/u, '')
    .replace(/^["'“”]+|["'“”]+$/gu, '')
    .trim()
}

function valueAfterLabel(text: string, labels: string[]) {
  for (const label of labels) {
    const start = text.indexOf(label)
    if (start < 0) continue
    const after = text.slice(start + label.length)
    const line = after.split(/\r?\n/u)[0] ?? ''
    const value = cleanValue(line.split(/[，,。；;]/u)[0] ?? '')
    if (value.length > 0) return value
  }
  return undefined
}

function firstNumberBefore(text: string, suffix: string) {
  const index = text.indexOf(suffix)
  if (index < 0) return undefined
  const before = text.slice(Math.max(0, index - 24), index)
  const match = before.match(/(\d+)\s*$/u)
  return match ? Number(match[1]) : undefined
}

function firstNumberAfter(text: string, prefix: string) {
  const index = text.indexOf(prefix)
  if (index < 0) return undefined
  const after = text.slice(index + prefix.length, index + prefix.length + 24)
  const match = after.match(/^\s*(\d+)/u)
  return match ? Number(match[1]) : undefined
}

function positiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function uniqueSpecificShareholderCount(text: string) {
  const names = new Set<string>()
  for (const match of text.matchAll(/股东\s*([A-Za-z0-9\u4e00-\u9fa5]+)/gu)) {
    const name = match[1] ? cleanValue(match[1]) : ''
    if (name && !name.startsWith('和') && !name.startsWith('投资')) {
      names.add(name)
    }
  }
  const includesReservedPool = text.includes('激励池') && (text.includes('分红') || text.includes('预留'))
  return names.size + (includesReservedPool ? 1 : 0)
}

function workspaceNameFromObjective(text: string) {
  const byLabel = valueAfterLabel(text, ['项目名称：', '项目名称:', '项目：', '项目='])
  if (byLabel) return byLabel
  const renameMarker = text.includes('改名为') ? '改名为' : text.includes('重命名为') ? '重命名为' : null
  if (!renameMarker) return undefined
  const after = text.slice(text.indexOf(renameMarker) + renameMarker.length).trim()
  const quoted = after.match(/[“"]([^”"]+)[”"]/u)
  if (quoted?.[1]) return cleanValue(quoted[1])
  return cleanValue((after.split(/\r?\n/u)[0] ?? '').split(/[，,。；;]/u)[0] ?? '')
}

function forbiddenActionsFromObjective(text: string): AgentGoalFacts['forbiddenActions'] {
  const forbidden = new Set<NonNullable<AgentGoalFacts['forbiddenActions']>[number]>()
  if ((text.includes('不要发布') || text.includes('先不要发布') || text.includes('不要保存快照')) && text.includes('版本')) {
    forbidden.add('publish_release')
  }
  if ((text.includes('不要创建分享') || text.includes('先不要分享')) && text.includes('分享')) {
    forbidden.add('share_link')
  }
  if (text.includes('注销') || text.includes('退出登录') || text.includes('删除账号') || text.includes('改密码')) {
    forbidden.add('account_action')
  }
  return forbidden.size > 0 ? [...forbidden] : undefined
}

export function extractAgentGoalFacts(objective: string): AgentGoalFacts {
  const requiredCapabilities = new Set<NonNullable<AgentGoalFacts['requiredCapabilities']>[number]>()
  const workspaceName = workspaceNameFromObjective(objective)
  if (workspaceName) requiredCapabilities.add('workspace_rename')

  const expectedMemberCount = positiveInteger(firstNumberBefore(objective, '个成员'))
  const expectedHorizonMonths = positiveInteger(
    firstNumberBefore(objective, '个月模型') ??
    firstNumberBefore(objective, '个月预测') ??
    firstNumberBefore(objective, '个月') ??
    firstNumberAfter(objective, '预测'),
  )
  const expectedStartMonth = positiveInteger(firstNumberBefore(objective, '月开始'))
  const shareholderCount = uniqueSpecificShareholderCount(objective)
  const expectedShareholderCount = shareholderCount > 0 ? shareholderCount : undefined

  if (expectedMemberCount || expectedHorizonMonths || objective.includes('经营测算') || objective.includes('经营模型')) {
    requiredCapabilities.add('operating_model')
  }
  if (objective.includes('入账') || objective.includes('记账') || objective.includes('账本')) {
    requiredCapabilities.add('ledger')
  }
  if (objective.includes('版本') || objective.includes('快照') || objective.includes('发布')) {
    requiredCapabilities.add('version')
  }
  if (objective.includes('分享')) requiredCapabilities.add('share')

  const requiresForecastSummary =
    objective.includes('总收入') ||
    objective.includes('总成本') ||
    objective.includes('总利润') ||
    objective.includes('期末现金') ||
    objective.includes('回本')

  const forbiddenActions = forbiddenActionsFromObjective(objective)
  return {
    ...(workspaceName ? { workspaceName } : {}),
    ...(expectedMemberCount ? { expectedMemberCount } : {}),
    ...(expectedShareholderCount ? { expectedShareholderCount } : {}),
    ...(expectedHorizonMonths ? { expectedHorizonMonths } : {}),
    ...(expectedStartMonth ? { expectedStartMonth } : {}),
    ...(requiresForecastSummary ? { requiresForecastSummary } : {}),
    ...(forbiddenActions ? { forbiddenActions } : {}),
    ...(requiredCapabilities.size > 0 ? { requiredCapabilities: [...requiredCapabilities] } : {}),
  }
}
