import type { ModelConfig, ModelResult } from '../types'

type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export type AuthUser = {
  id: string
  email: string
  displayName: string
  status: string
}

export type DraftResponse = {
  workspaceId: string
  workspaceName: string
  revision: number
  config: ModelConfig
  result: ModelResult
  lastAutosavedAt: string | null
}

export type VersionResponse = {
  id: string
  name: string
  kind: 'snapshot' | 'release'
  versionNo: number
  sourceVersionId: string | null
  createdAt: string
  config: ModelConfig
  activeShare: VersionShareResponse | null
}

export type VersionShareResponse = {
  id: string
  versionId: string
  shareToken: string
  sharePath: string
  createdAt: string
  updatedAt: string
}

export type PeriodResponse = {
  id: string
  monthIndex: number
  monthLabel: string
  status: string
  baselineVersionId: string | null
  baselineVersionName: string | null
  plannedRevenue: number
  plannedCost: number
  actualRevenue: number
  actualCost: number
}

export type SubjectResponse = {
  subjectKey: string
  subjectName: string
  subjectType: 'revenue' | 'cost'
  subjectGroup: string
  entityType?: string | null
  entityId?: string | null
  plannedAmount: number
}

export type EntryAllocation = {
  subjectKey: string
  subjectName: string
  subjectType: 'revenue' | 'cost'
  amount: number
}

export type EntryResponse = {
  id: string
  ledgerPeriodId: string
  direction: 'income' | 'expense'
  amount: number
  occurredAt: string
  postedAt: string | null
  counterparty: string | null
  description: string | null
  relatedEntityType?: 'teamMember' | 'employee' | null
  relatedEntityId?: string | null
  relatedEntityName?: string | null
  sourceEntryId?: string | null
  entryOrigin?: 'manual' | 'derived' | string
  derivedKind?: string | null
  status: string
  allocations: EntryAllocation[]
}

export type VarianceLine = {
  subjectKey: string
  subjectName: string
  subjectType: 'revenue' | 'cost'
  plannedAmount: number
  actualAmount: number
  varianceAmount: number
  varianceRate: number | null
}

export type VarianceResponse = {
  periodId: string
  monthLabel: string
  baselineVersionId: string | null
  baselineVersionName: string | null
  lines: VarianceLine[]
  plannedRevenue: number
  plannedCost: number
  actualRevenue: number
  actualCost: number
  revenueVarianceAmount: number
  revenueVarianceRate: number | null
  costVarianceAmount: number
  costVarianceRate: number | null
  cumulativePlannedRevenue: number
  cumulativePlannedCost: number
  cumulativeActualRevenue: number
  cumulativeActualCost: number
  cumulativeRevenueVarianceAmount: number
  cumulativeRevenueVarianceRate: number | null
  cumulativeCostVarianceAmount: number
  cumulativeCostVarianceRate: number | null
}

export type PublicShareResponse = {
  shareId: string
  shareToken: string
  workspaceId: string
  workspaceName: string
  versionId: string
  versionName: string
  versionNo: number
  versionKind: 'release'
  createdAt: string
  sharedAt: string
  config: ModelConfig
  result: ModelResult
}

type ApiValidationError = {
  loc?: Array<string | number>
  msg?: string
}

type ApiErrorPayload = {
  detail?: string | ApiValidationError[]
  message?: string
}

const fieldLabels: Record<string, string> = {
  email: '邮箱',
  password: '密码',
  displayName: '显示名称',
  revision: '修订号',
  workspaceName: '工作区名称',
  ledgerPeriodId: '记账期间',
  periodId: '期间',
  amount: '金额',
  counterparty: '对方单位',
  description: '摘要说明',
  allocations: '预算科目',
  subjectKey: '预算科目',
  occurredAt: '发生时间',
  request: '请求参数',
}

const exactMessageTranslations: Record<string, string> = {
  'Invalid credentials': '邮箱或密码错误。',
  'Email already exists': '邮箱已被注册。',
  'Not authenticated': '请先登录。',
  Forbidden: '无权访问该资源。',
  'Workspace not found': '未找到工作区。',
  'Draft not found': '未找到草稿。',
  'Draft revision conflict': '草稿已在其他会话中更新，请先刷新到最新草稿再继续。',
  'Version not found': '未找到版本。',
  'Share link not found': '未找到分享链接。',
  'Ledger period not found': '未找到该记账期间。',
  'Ledger period has no baseline version': '当前期间尚未绑定预算基线版本。',
  'Entry not found': '未找到该分录。',
  'Ledger period is locked': '当前期间已锁定，不能修改。',
  'Amount must be positive': '金额必须大于 0。',
  'At least one allocation is required': '请先选择预算科目。',
  'Allocation amounts must be positive': '预算科目金额必须大于 0。',
  'Allocations must equal the entry amount': '预算科目金额必须与录入金额一致。',
  'Member commission is derived automatically from posted member revenue': '成员提成会随成员收入自动计提，不需要手动录入。',
  'System-generated entry must be voided from its source entry': '自动生成的提成分录需要从对应收入记录里一起作废。',
  'Baseline version does not expose member commission subject': '当前预算基线缺少成员提成科目，无法自动计提。',
  'Active release cannot be deleted': '当前活动发布版本不能删除。',
  'Version has an active share link': '当前版本仍有有效分享链接，不能删除。',
  'Version is used by a ledger period': '当前版本已被记账期间引用，不能删除。',
}

function titleCase(value: string) {
  if (!value) {
    return value
  }

  return value.charAt(0).toUpperCase() + value.slice(1)
}

function translateField(rawField: string) {
  return fieldLabels[rawField] ?? titleCase(rawField)
}

function translateValidationMessage(message: string) {
  if (message === 'Field required') {
    return '必填项'
  }

  if (message.includes('valid email address')) {
    return '邮箱格式不正确'
  }

  const minStringMatch = message.match(/^String should have at least (\d+) characters$/)
  if (minStringMatch) {
    return `长度不能少于 ${minStringMatch[1]} 个字符`
  }

  const maxStringMatch = message.match(/^String should have at most (\d+) characters$/)
  if (maxStringMatch) {
    return `长度不能超过 ${maxStringMatch[1]} 个字符`
  }

  return exactMessageTranslations[message] ?? message
}

function translateKnownMessage(message: string) {
  return exactMessageTranslations[message] ?? message
}

function formatValidationError(issue: ApiValidationError) {
  const rawPath = issue.loc?.filter((segment) => segment !== 'body').join('.')
  const path = translateField(rawPath ? rawPath.split('.').at(-1) ?? rawPath : 'request')
  return issue.msg ? `${path}：${translateValidationMessage(issue.msg)}` : `${path}：无效值`
}

export function formatApiErrorMessage(payload: ApiErrorPayload | null, statusCode: number) {
  if (typeof payload?.detail === 'string' && payload.detail.trim()) {
    return translateKnownMessage(payload.detail.trim())
  }

  if (Array.isArray(payload?.detail) && payload.detail.length > 0) {
    return payload.detail.map(formatValidationError).join('；')
  }

  if (typeof payload?.message === 'string' && payload.message.trim()) {
    return translateKnownMessage(payload.message.trim())
  }

  return `请求失败（状态码 ${statusCode}）`
}

async function apiRequest<T>(method: ApiMethod, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'include',
  }

  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  const response = await fetch(path, init)

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null
    throw new Error(formatApiErrorMessage(payload, response.status))
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

export const api = {
  health: () => apiRequest<{ status: string }>('GET', '/api/v1/health'),
  register: (payload: { email: string; password: string; displayName: string }) =>
    apiRequest<AuthUser>('POST', '/api/v1/auth/register', payload),
  login: (payload: { email: string; password: string }) =>
    apiRequest<AuthUser>('POST', '/api/v1/auth/login', payload),
  me: () => apiRequest<AuthUser>('GET', '/api/v1/auth/me'),
  logout: () => apiRequest<{ ok: boolean }>('POST', '/api/v1/auth/logout'),
  cancelAccount: () => apiRequest<{ ok: boolean }>('DELETE', '/api/v1/auth/me'),
  getDraft: () => apiRequest<DraftResponse>('GET', '/api/v1/workspace/draft'),
  saveDraft: (payload: { revision: number; workspaceName: string; config: ModelConfig }) =>
    apiRequest<DraftResponse>('PATCH', '/api/v1/workspace/draft', payload),
  listVersions: () => apiRequest<VersionResponse[]>('GET', '/api/v1/workspace/versions'),
  createVersion: (payload: { kind: 'snapshot' | 'release'; name?: string | null; note?: string | null }) =>
    apiRequest<VersionResponse>('POST', '/api/v1/workspace/versions', payload),
  createVersionShare: (versionId: string) =>
    apiRequest<VersionShareResponse>('POST', `/api/v1/workspace/versions/${versionId}/share`),
  revokeVersionShare: (versionId: string) =>
    apiRequest<{ ok: boolean }>('DELETE', `/api/v1/workspace/versions/${versionId}/share`),
  rollbackVersion: (versionId: string) =>
    apiRequest<DraftResponse>('POST', `/api/v1/workspace/versions/${versionId}/rollback`),
  deleteVersion: (versionId: string) =>
    apiRequest<{ ok: boolean }>('DELETE', `/api/v1/workspace/versions/${versionId}`),
  listPeriods: () => apiRequest<PeriodResponse[]>('GET', '/api/v1/ledger/periods'),
  listSubjects: (periodId: string) =>
    apiRequest<SubjectResponse[]>('GET', `/api/v1/ledger/periods/${periodId}/subjects`),
  lockPeriod: (periodId: string) =>
    apiRequest<PeriodResponse>('POST', `/api/v1/ledger/periods/${periodId}/lock`),
  unlockPeriod: (periodId: string) =>
    apiRequest<PeriodResponse>('POST', `/api/v1/ledger/periods/${periodId}/unlock`),
  listEntries: (periodId: string) =>
    apiRequest<EntryResponse[]>('GET', `/api/v1/ledger/entries?periodId=${encodeURIComponent(periodId)}`),
  createEntry: (payload: {
    ledgerPeriodId: string
    direction: 'income' | 'expense'
    amount: number
    counterparty?: string
    description?: string
    occurredAt?: string
    relatedEntityType?: 'teamMember' | 'employee'
    relatedEntityId?: string
    relatedEntityName?: string
    allocations: EntryAllocation[]
  }) => apiRequest<EntryResponse>('POST', '/api/v1/ledger/entries', payload),
  voidEntry: (entryId: string) =>
    apiRequest<{ ok: boolean }>('POST', `/api/v1/ledger/entries/${entryId}/void`),
  getVariance: (periodId: string) =>
    apiRequest<VarianceResponse>('GET', `/api/v1/variance/periods/${periodId}`),
  getSharedVersion: (shareToken: string) =>
    apiRequest<PublicShareResponse>('GET', `/api/v1/public/shares/${encodeURIComponent(shareToken)}`),
}
