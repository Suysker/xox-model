import { hydrateModelConfig, projectModel } from '@xox/domain'
import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import { getWorkspaceDraft, listVersions } from '../modules/workspace.js'
import { listPeriods } from '../modules/ledger.js'

export type AgentDomainObservation = {
  draft: {
    workspaceName: string
    revision: number
    teamMemberCount: number
    employeeCount: number
    shareholderCount: number
    monthCount: number
    startMonth: number
    totalRevenue: number
    totalCost: number
    totalProfit: number
  }
  ledger: {
    periodCount: number
  }
  versions: {
    count: number
    releaseCount: number
  }
  shares: {
    activeCount: number
  }
  audit: {
    executedActionCount: number
  }
}

export async function collectAgentObservation(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  runId: string
}): Promise<AgentDomainObservation> {
  const [currentWorkspace, draft, periods, versions, shares, audits] = await Promise.all([
    input.db.selectFrom('workspaces').select(['id', 'name']).where('id', '=', input.workspace.id).executeTakeFirst(),
    getWorkspaceDraft(input.db, input.workspace),
    listPeriods(input.db, input.workspace),
    listVersions(input.db, input.workspace),
    input.db
      .selectFrom('workspace_version_shares')
      .select('id')
      .where('workspace_id', '=', input.workspace.id)
      .where('revoked_at', 'is', null)
      .execute(),
    input.db
      .selectFrom('audit_logs')
      .select('id')
      .where('workspace_id', '=', input.workspace.id)
      .where('action', '=', 'agent.action_executed')
      .execute(),
  ])
  const config = hydrateModelConfig(parseJson<unknown>(draft.config_json, null))
  const scenario = projectModel(config).scenarios.find((item) => item.key === 'base')
  return {
    draft: {
      workspaceName: currentWorkspace?.name ?? input.workspace.name,
      revision: draft.revision,
      teamMemberCount: config.teamMembers.length,
      employeeCount: config.employees.length,
      shareholderCount: config.shareholders.length,
      monthCount: config.months.length,
      startMonth: config.planning.startMonth,
      totalRevenue: scenario?.grossSales ?? 0,
      totalCost: scenario?.totalCost ?? 0,
      totalProfit: scenario?.totalProfit ?? 0,
    },
    ledger: {
      periodCount: periods.length,
    },
    versions: {
      count: versions.length,
      releaseCount: versions.filter((version) => version.kind === 'release').length,
    },
    shares: {
      activeCount: shares.length,
    },
    audit: {
      executedActionCount: audits.length,
    },
  }
}
