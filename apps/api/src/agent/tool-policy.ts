import type { AgentActionKind, AgentNavigationEvent } from '@xox/contracts'
import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import { conflict, forbidden, unprocessable } from '../core/http.js'
import { composeAgentWriteApprovalPolicy } from '@agentic-os/core'

type RiskLevel = 'low' | 'medium' | 'high'
export type AgentAutomationLevel = 'manual' | RiskLevel

const riskRank: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 }
const autoExecutableHighRiskActions = new Set<AgentActionKind>()

export type AgentActionAuthorityDecision =
  | { mode: 'auto_execute'; reason: string }
  | { mode: 'require_confirmation'; reason: string }
  | { mode: 'forbidden'; reason: string }

type AgentActionPolicy = {
  kind: AgentActionKind
  minRiskLevel: RiskLevel
  requiredMainTab?: AgentNavigationEvent['route']['mainTab']
  requiredPanel?: AgentNavigationEvent['panel']
}

type DraftLike = {
  kind: AgentActionKind
  riskLevel: RiskLevel
  navigation: AgentNavigationEvent
}

type ActionRowLike = Pick<Row<'agent_action_requests'>, 'kind' | 'status' | 'workspace_id' | 'user_id' | 'payload_json' | 'navigation_json' | 'risk_level'>

export function normalizeAgentAutomationLevel(value: unknown): AgentAutomationLevel {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'manual'
}

const ACTION_POLICIES: Record<AgentActionKind, AgentActionPolicy> = {
  'ledger.create_entry': { kind: 'ledger.create_entry', minRiskLevel: 'medium', requiredMainTab: 'bookkeeping' },
  'ledger.update_entry': { kind: 'ledger.update_entry', minRiskLevel: 'medium', requiredMainTab: 'bookkeeping' },
  'ledger.void_entry': { kind: 'ledger.void_entry', minRiskLevel: 'high', requiredMainTab: 'bookkeeping' },
  'ledger.restore_entry': { kind: 'ledger.restore_entry', minRiskLevel: 'high', requiredMainTab: 'bookkeeping' },
  'ledger.lock_period': { kind: 'ledger.lock_period', minRiskLevel: 'high', requiredMainTab: 'bookkeeping' },
  'ledger.unlock_period': { kind: 'ledger.unlock_period', minRiskLevel: 'high', requiredMainTab: 'bookkeeping' },
  'workspace.rename': { kind: 'workspace.rename', minRiskLevel: 'medium', requiredMainTab: 'dashboard', requiredPanel: 'workspace' },
  'workspace.update_draft': { kind: 'workspace.update_draft', minRiskLevel: 'medium', requiredMainTab: 'inputs' },
  'workspace.save_snapshot': { kind: 'workspace.save_snapshot', minRiskLevel: 'low', requiredMainTab: 'dashboard', requiredPanel: 'workspace' },
  'workspace.publish_release': { kind: 'workspace.publish_release', minRiskLevel: 'high', requiredMainTab: 'dashboard', requiredPanel: 'workspace' },
  'workspace.promote_version': { kind: 'workspace.promote_version', minRiskLevel: 'high', requiredMainTab: 'dashboard', requiredPanel: 'workspace' },
  'workspace.rollback_version': { kind: 'workspace.rollback_version', minRiskLevel: 'high', requiredMainTab: 'dashboard', requiredPanel: 'workspace' },
  'workspace.delete_version': { kind: 'workspace.delete_version', minRiskLevel: 'high', requiredMainTab: 'dashboard', requiredPanel: 'workspace' },
  'workspace.reset_draft': { kind: 'workspace.reset_draft', minRiskLevel: 'high', requiredMainTab: 'inputs', requiredPanel: 'workspace' },
  'workspace.import_bundle': { kind: 'workspace.import_bundle', minRiskLevel: 'high', requiredMainTab: 'dashboard', requiredPanel: 'workspace' },
  'share.create': { kind: 'share.create', minRiskLevel: 'high', requiredMainTab: 'dashboard', requiredPanel: 'workspace' },
  'share.revoke': { kind: 'share.revoke', minRiskLevel: 'medium', requiredMainTab: 'dashboard', requiredPanel: 'workspace' },
  'sandbox.aggregate_tool_calls': { kind: 'sandbox.aggregate_tool_calls', minRiskLevel: 'low' },
}

function actionPolicy(kind: AgentActionKind) {
  const policy = ACTION_POLICIES[kind]
  if (!policy) throw unprocessable(`Unsupported agent action: ${kind}`)
  return policy
}

export function coerceAgentActionKind(kind: string): AgentActionKind {
  if (!(kind in ACTION_POLICIES)) throw unprocessable(`Unsupported agent action: ${kind}`)
  return kind as AgentActionKind
}

export function resolveActionAuthority(input: {
  automationLevel: AgentAutomationLevel
  kind: AgentActionKind | string
  riskLevel: RiskLevel | string
}): AgentActionAuthorityDecision {
  const kind = String(input.kind)
  if (kind.startsWith('account.')) {
    return { mode: 'forbidden', reason: '账号影响类动作不能由 Agent 执行。' }
  }

  const actionKind = coerceAgentActionKind(kind)
  assertRisk(actionKind, input.riskLevel)
  const riskLevel = input.riskLevel as RiskLevel

  return composeAgentWriteApprovalPolicy({
    automationLevel: input.automationLevel,
    riskLevel,
    highRiskAutoAllowed: autoExecutableHighRiskActions.has(actionKind),
  })
}

function parsePayload(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    throw unprocessable('Agent action payload is invalid')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function assertDraftConfigPayload(payload: Record<string, unknown>) {
  const config = payload.config
  if (!isRecord(config)) throw unprocessable('Workspace draft update requires config')
  if (!Array.isArray(config.teamMembers) || config.teamMembers.length < 1) {
    throw conflict('Workspace draft must keep at least one team member')
  }
  if (!Array.isArray(config.shareholders) || config.shareholders.length < 1) {
    throw conflict('Workspace draft must keep at least one shareholder')
  }
}

function assertRisk(kind: AgentActionKind, riskLevel: string) {
  const policy = actionPolicy(kind)
  if (!(riskLevel in riskRank)) throw unprocessable('Agent action risk level is invalid')
  if (riskRank[riskLevel as RiskLevel] < riskRank[policy.minRiskLevel]) {
    throw unprocessable(`Agent action ${kind} requires ${policy.minRiskLevel} risk level or higher`)
  }
}

function assertNavigation(kind: AgentActionKind, navigation: AgentNavigationEvent) {
  const policy = actionPolicy(kind)
  if (navigation.type !== 'navigation') throw unprocessable('Agent write action requires visible navigation')
  if (policy.requiredMainTab && navigation.route.mainTab !== policy.requiredMainTab) {
    throw unprocessable(`Agent action ${kind} must navigate to ${policy.requiredMainTab}`)
  }
  if (policy.requiredPanel && navigation.panel !== policy.requiredPanel) {
    throw unprocessable(`Agent action ${kind} must open ${policy.requiredPanel} panel`)
  }
}

function nestedSandboxActions(payload: Record<string, unknown>) {
  const nested = payload.nestedActions
  if (!Array.isArray(nested) || nested.length === 0) throw unprocessable('Sandbox aggregate action requires nestedActions')
  return nested.map((item) => {
    if (!isRecord(item)) throw unprocessable('Sandbox nested action is invalid')
    const kind = typeof item.kind === 'string' ? coerceAgentActionKind(item.kind) : null
    if (!kind || kind === 'sandbox.aggregate_tool_calls') throw unprocessable('Sandbox nested action kind is invalid')
    const riskLevel = typeof item.riskLevel === 'string' ? item.riskLevel : ''
    if (!(riskLevel in riskRank)) throw unprocessable('Sandbox nested action risk level is invalid')
    const navigation = isRecord(item.navigation) ? item.navigation as AgentNavigationEvent : null
    if (!navigation) throw unprocessable('Sandbox nested action navigation is required')
    const payloadValue = item.payload ?? {}
    const details = Array.isArray(item.details) ? item.details : []
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : kind
    const summary = typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim() : title
    const targetLabel = typeof item.targetLabel === 'string' && item.targetLabel.trim() ? item.targetLabel.trim() : 'Sandbox nested action'
    const draft = {
      kind,
      riskLevel: riskLevel as RiskLevel,
      navigation,
      title,
      summary,
      targetLabel,
      details,
      payload: payloadValue,
    }
    assertActionDraftAllowed(draft)
    return draft
  })
}

async function assertPeriodAllowed(db: Kysely<Database>, workspace: Row<'workspaces'>, periodId: unknown, options?: { allowLocked?: boolean }) {
  if (typeof periodId !== 'string') throw unprocessable('Ledger period id is required')
  const period = await db.selectFrom('ledger_periods').selectAll().where('id', '=', periodId).executeTakeFirst()
  if (!period || period.workspace_id !== workspace.id) throw forbidden()
  if (!options?.allowLocked && period.status === 'locked') throw conflict('Ledger period is locked')
  return period
}

async function assertEntryAllowed(db: Kysely<Database>, workspace: Row<'workspaces'>, entryId: unknown, actionKind: AgentActionKind) {
  if (typeof entryId !== 'string') throw unprocessable('Ledger entry id is required')
  const entry = await db.selectFrom('actual_entries').selectAll().where('id', '=', entryId).executeTakeFirst()
  if (!entry || entry.workspace_id !== workspace.id) throw forbidden()
  if (entry.entry_origin === 'derived') throw conflict('System-generated entry must be managed from its source entry')
  await assertPeriodAllowed(db, workspace, entry.ledger_period_id)
  if (actionKind === 'ledger.update_entry' && entry.status === 'voided') throw conflict('Voided entry cannot be edited')
  if (actionKind === 'ledger.restore_entry' && entry.status !== 'voided') throw conflict('Entry is not voided')
  return entry
}

async function assertVersionAllowed(db: Kysely<Database>, workspace: Row<'workspaces'>, versionId: unknown) {
  if (typeof versionId !== 'string') throw unprocessable('Version id is required')
  const version = await db.selectFrom('workspace_versions').selectAll().where('id', '=', versionId).executeTakeFirst()
  if (!version || version.workspace_id !== workspace.id) throw forbidden()
  return version
}

export function assertActionDraftAllowed(draft: DraftLike) {
  actionPolicy(draft.kind)
  assertRisk(draft.kind, draft.riskLevel)
  assertNavigation(draft.kind, draft.navigation)
}

export function assertActionUpdateAllowed(kind: AgentActionKind, update: { riskLevel?: RiskLevel; navigation?: AgentNavigationEvent }) {
  actionPolicy(kind)
  if (update.riskLevel) assertRisk(kind, update.riskLevel)
  if (update.navigation) assertNavigation(kind, update.navigation)
}

export async function assertActionExecutionAllowed(
  db: Kysely<Database>,
  workspace: Row<'workspaces'>,
  user: { id: string },
  action: ActionRowLike,
) {
  if (action.workspace_id !== workspace.id || action.user_id !== user.id) throw forbidden()
  if (action.status !== 'pending') throw conflict('Agent action is not pending')
  const kind = coerceAgentActionKind(action.kind)
  assertRisk(kind, action.risk_level)
  const navigation = JSON.parse(action.navigation_json) as AgentNavigationEvent
  assertNavigation(kind, navigation)
  const payload = parsePayload(action.payload_json)

  switch (kind) {
    case 'ledger.create_entry':
      await assertPeriodAllowed(db, workspace, payload.ledgerPeriodId)
      return
    case 'ledger.update_entry':
    case 'ledger.void_entry':
    case 'ledger.restore_entry':
      await assertEntryAllowed(db, workspace, payload.entryId, kind)
      return
    case 'ledger.lock_period':
    case 'ledger.unlock_period':
      await assertPeriodAllowed(db, workspace, payload.periodId, { allowLocked: true })
      return
    case 'workspace.rollback_version':
    case 'workspace.promote_version':
    case 'workspace.delete_version':
    case 'share.create':
    case 'share.revoke':
      await assertVersionAllowed(db, workspace, payload.versionId)
      return
    case 'workspace.update_draft':
      assertDraftConfigPayload(payload)
      return
    case 'workspace.rename':
      if (typeof payload.workspaceName !== 'string' || payload.workspaceName.trim().length === 0) throw unprocessable('Workspace name is required')
      return
    case 'workspace.save_snapshot':
    case 'workspace.publish_release':
    case 'workspace.reset_draft':
    case 'workspace.import_bundle':
      return
    case 'sandbox.aggregate_tool_calls': {
      const nested = nestedSandboxActions(payload)
      for (const nestedAction of nested) {
        await assertActionExecutionAllowed(db, workspace, user, {
          ...action,
          kind: nestedAction.kind,
          risk_level: nestedAction.riskLevel,
          payload_json: JSON.stringify(nestedAction.payload),
          navigation_json: JSON.stringify(nestedAction.navigation),
        })
      }
      return
    }
    default:
      actionPolicy(kind)
  }
}
