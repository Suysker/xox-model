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
  counterparty: string | null
  description: string | null
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
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null
    throw new Error(payload?.detail ?? `Request failed with status ${response.status}`)
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
  listEntries: (periodId: string) =>
    apiRequest<EntryResponse[]>('GET', `/api/v1/ledger/entries?periodId=${encodeURIComponent(periodId)}`),
  createEntry: (payload: {
    ledgerPeriodId: string
    direction: 'income' | 'expense'
    amount: number
    counterparty?: string
    description?: string
    occurredAt?: string
    allocations: EntryAllocation[]
  }) => apiRequest<EntryResponse>('POST', '/api/v1/ledger/entries', payload),
  voidEntry: (entryId: string) =>
    apiRequest<{ ok: boolean }>('POST', `/api/v1/ledger/entries/${entryId}/void`),
  getVariance: (periodId: string) =>
    apiRequest<VarianceResponse>('GET', `/api/v1/variance/periods/${periodId}`),
  getSharedVersion: (shareToken: string) =>
    apiRequest<PublicShareResponse>('GET', `/api/v1/public/shares/${encodeURIComponent(shareToken)}`),
}
