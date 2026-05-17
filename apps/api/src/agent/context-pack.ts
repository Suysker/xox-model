import type { Kysely } from 'kysely'
import { hydrateModelConfig } from '@xox/domain'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import type { CurrentUser } from '../modules/auth.js'
import { getWorkspaceDraft, listVersions } from '../modules/workspace.js'
import { listPeriods, listSubjectsForPeriod } from '../modules/ledger.js'
import { loadAgentRuntimeContext } from './memory.js'
import { buildAgentWritableConfigContext } from './tool-coverage.js'
import type { ParsedWorkspaceBundleArtifact } from './workspace-bundle-artifact.js'

export type AgentContextPackInput = {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  providedWorkspaceBundle?: ParsedWorkspaceBundleArtifact
}

export async function buildAgentContextPack(input: AgentContextPackInput) {
  const draft = await getWorkspaceDraft(input.db, input.workspace)
  const config = hydrateModelConfig(parseJson<unknown>(draft.config_json, null))
  const periods = await listPeriods(input.db, input.workspace)
  const versions = await listVersions(input.db, input.workspace)
  const runtimeContext = await loadAgentRuntimeContext({
    db: input.db,
    workspace: input.workspace,
    user: input.user,
    threadId: input.threadId,
  })

  return {
    months: config.months.map((month, index) => ({ label: month.label, index, id: month.id })),
    teamMembers: config.teamMembers.map((member) => ({ id: member.id, name: member.name })),
    employees: config.employees.map((employee) => ({ id: employee.id, name: employee.name, role: employee.role })),
    versions: versions.map((version) => ({ versionNo: version.version_no, name: version.name, kind: version.kind })),
    periods: periods.map((period) => ({ id: period.id, monthLabel: period.monthLabel })),
    ledgerSubjects: periods[0]
      ? (await listSubjectsForPeriod(input.db, input.workspace, periods[0].id)).map((subject) => ({
          key: subject.subjectKey,
          name: subject.subjectName,
          type: subject.subjectType,
          group: subject.subjectGroup,
        }))
      : [],
    tenantScopedMemory: runtimeContext.memories.map((memory) => ({
      kind: memory.kind,
      key: memory.key,
      value: memory.value,
    })),
    contextSummary: runtimeContext.contextSummary,
    recentMessages: runtimeContext.recentMessages.map((message) => ({
      role: message.role,
      content: message.content.slice(0, 500),
    })),
    writableConfig: buildAgentWritableConfigContext(config),
    ...(input.providedWorkspaceBundle
      ? {
          providedArtifacts: {
            workspaceBundle: input.providedWorkspaceBundle.summary,
          },
        }
      : {}),
  }
}
