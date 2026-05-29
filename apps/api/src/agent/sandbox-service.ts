import { createHash } from 'node:crypto'
import { projectModel } from '@xox/domain'
import type {
  SandboxArtifactKind,
  SandboxCapabilityProfile,
  SandboxDataScope,
  SandboxFileKind,
  SandboxManifest,
  SandboxObservation,
  SandboxRunCodeInput,
} from '@xox/contracts'
import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import { draftContext, getWorkspaceDraft } from '../modules/workspace.js'
import { listEntries, listPeriods } from '../modules/ledger.js'
import type { CurrentUser } from '../modules/auth.js'
import { normalizeSandboxArtifactKinds, normalizeSandboxFileKinds } from './sandbox-file-adapters.js'
import type { ReadDraft, RuntimePlannerStep } from './action-draft-builder.js'
import type { PlannerContext } from './planning-context.js'

type SandboxExpectedOutput = NonNullable<SandboxRunCodeInput['expectedOutputs']>[number]

type SandboxServiceContext = {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
}

type SandboxDataBundle = {
  bundleId: string
  scope: SandboxDataScope
  fields: string[]
  rows?: unknown[]
  files?: Array<{ fileId: string; kind?: SandboxFileKind }>
  structured: unknown
  rowCount?: number
  fileCount?: number
  fileKinds?: SandboxFileKind[]
  redactions: number
  contentHash: string
}

type SandboxSessionRef = {
  id: string
  manifest: SandboxManifest
}

type SandboxExecuteInput = {
  input: SandboxRunCodeInput
  bundle: SandboxDataBundle
}

type SandboxExecuteResult = {
  status: SandboxObservation['status']
  result: SandboxObservation['result']
  artifacts: SandboxObservation['artifacts']
  resourceUsage: SandboxObservation['resourceUsage']
  errorMessage?: string
}

interface SandboxBackend {
  create(manifest: SandboxManifest): Promise<SandboxSessionRef>
  execute(session: SandboxSessionRef, input: SandboxExecuteInput): Promise<SandboxExecuteResult>
  collect(session: SandboxSessionRef): Promise<SandboxObservation['artifacts']>
  destroy(session: SandboxSessionRef): Promise<void>
}

const DEFAULT_SANDBOX_ARTIFACT_KINDS: SandboxArtifactKind[] = [
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xlsx',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'html',
  'txt',
  'md',
  'pdf',
  'docx',
]

const DEFAULT_CAPABILITIES: SandboxCapabilityProfile = {
  filesystem: 'input_readonly_output_tmp',
  shell: false,
  packageInstall: false,
  internalApi: false,
  productionDatabase: false,
  objectStorage: 'selected_upload_readonly',
  providerSecrets: false,
  userSessionTokens: false,
  businessWrites: false,
  memoryWrites: false,
  accountActions: false,
}

function hashJson(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : []
}

function asSandboxDataScope(value: unknown): SandboxDataScope {
  return value === 'forecast_months' ||
    value === 'ledger_entries' ||
    value === 'entity_summary' ||
    value === 'uploaded_file' ||
    value === 'custom_bundle'
    ? value
    : 'workspace_summary'
}

function normalizeSandboxInput(step: RuntimePlannerStep): SandboxRunCodeInput {
  const dataRequest = step.dataRequest && typeof step.dataRequest === 'object'
    ? step.dataRequest as Record<string, unknown>
    : {}
  const language = step.language === 'javascript' ? 'javascript' : 'python'
  const code = typeof step.code === 'string' ? step.code : ''
  const purpose = typeof step.purpose === 'string' && step.purpose.trim()
    ? step.purpose.trim()
    : typeof step.question === 'string' && step.question.trim()
      ? step.question.trim()
      : '运行受控沙箱任务'
  return {
    purpose,
    language,
    code,
    dataRequest: {
      scope: asSandboxDataScope(dataRequest.scope ?? step.scope),
      fields: asStringArray(dataRequest.fields ?? step.fields),
      monthLabels: asStringArray(dataRequest.monthLabels ?? step.monthLabels),
      fileIds: asStringArray(dataRequest.fileIds ?? step.fileIds),
      fileKinds: normalizeSandboxFileKinds(dataRequest.fileKinds ?? step.fileKinds),
      ...(typeof dataRequest.rowLimit === 'number' || typeof step.rowLimit === 'number'
        ? { rowLimit: Math.max(1, Math.min(5000, Math.round(Number(dataRequest.rowLimit ?? step.rowLimit)))) }
        : {}),
    },
    expectedOutputs: Array.isArray(step.expectedOutputs)
      ? step.expectedOutputs.filter((item): item is SandboxExpectedOutput =>
        item === 'json' ||
        item === 'table' ||
        item === 'chart' ||
        item === 'csv' ||
        item === 'spreadsheet' ||
        item === 'document' ||
        item === 'image' ||
        item === 'markdown')
      : [],
  }
}

async function currentProjection(ctx: SandboxServiceContext) {
  const draft = await getWorkspaceDraft(ctx.db, ctx.workspace)
  const { config } = draftContext(draft)
  return { config, projection: projectModel(config) }
}

async function buildSandboxDataBundle(ctx: SandboxServiceContext, input: SandboxRunCodeInput): Promise<SandboxDataBundle> {
  const { config, projection } = await currentProjection(ctx)
  const baseScenario = projection.scenarios.find((scenario) => scenario.key === 'base') ?? projection.scenarios[0] ?? null
  const scope = input.dataRequest.scope
  const fields = input.dataRequest.fields ?? []
  const monthLabels = new Set(input.dataRequest.monthLabels ?? [])
  const rowLimit = input.dataRequest.rowLimit ?? 500

  let rows: unknown[] | undefined
  let structured: unknown
  let fileCount: number | undefined
  let fileKinds: SandboxFileKind[] | undefined

  if (scope === 'forecast_months') {
    rows = (baseScenario?.months ?? [])
      .filter((month) => monthLabels.size === 0 || monthLabels.has(month.label))
      .slice(0, rowLimit)
      .map((month) => ({
        monthIndex: month.monthIndex,
        monthLabel: month.label,
        grossSales: month.grossSales,
        totalCost: month.totalCost,
        monthlyProfit: month.monthlyProfit,
        cumulativeCash: month.cumulativeCash,
      }))
    structured = { scope, rows }
  } else if (scope === 'entity_summary') {
    structured = {
      teamMembers: config.teamMembers.map((member, index) => ({
        index: index + 1,
        id: member.id,
        name: member.name,
        monthlyBasePay: member.monthlyBasePay,
        commissionRate: member.commissionRate,
      })),
      shareholders: config.shareholders.map((shareholder, index) => ({
        index: index + 1,
        id: shareholder.id,
        name: shareholder.name,
        investmentAmount: shareholder.investmentAmount,
        dividendRate: shareholder.dividendRate,
      })),
      employees: config.employees.map((employee, index) => ({
        index: index + 1,
        id: employee.id,
        name: employee.name,
        role: employee.role,
        monthlyBasePay: employee.monthlyBasePay,
        perEventCost: employee.perEventCost,
      })),
    }
    rows = [
      ...config.teamMembers,
      ...config.shareholders,
      ...config.employees,
    ].slice(0, rowLimit)
  } else if (scope === 'ledger_entries') {
    const periods = await listPeriods(ctx.db, ctx.workspace)
    const targetPeriods = periods.filter((period) => monthLabels.size === 0 || monthLabels.has(period.monthLabel))
    rows = []
    for (const period of targetPeriods) {
      const entries = await listEntries(ctx.db, ctx.workspace, period.id)
      rows.push(...entries.map((entry) => ({ monthLabel: period.monthLabel, ...entry })))
      if (rows.length >= rowLimit) break
    }
    rows = rows.slice(0, rowLimit)
    structured = { scope, rows }
  } else if (scope === 'uploaded_file' || scope === 'custom_bundle') {
    const fileIds = input.dataRequest.fileIds ?? []
    fileKinds = input.dataRequest.fileKinds ?? []
    fileCount = fileIds.length
    structured = {
      scope,
      files: fileIds.map((fileId, index) => ({ fileId, kind: fileKinds?.[index] ?? null })),
      note: '文件内容由 File Adapter Registry 解析后进入沙箱；当前 fake backend 只处理 manifest 和安全边界。',
    }
  } else {
    const totalRevenue = baseScenario?.months.reduce((sum, month) => sum + month.grossSales, 0) ?? 0
    const totalCost = baseScenario?.months.reduce((sum, month) => sum + month.totalCost, 0) ?? 0
    const totalProfit = totalRevenue - totalCost
    structured = {
      scope,
      workspaceName: ctx.workspace.name,
      monthCount: baseScenario?.months.length ?? 0,
      grossSales: totalRevenue,
      totalCost,
      totalProfit,
      endingCash: baseScenario?.months.at(-1)?.cumulativeCash ?? 0,
      paybackMonthLabel: baseScenario?.paybackMonthLabel ?? null,
    }
    rows = [structured]
  }

  const bundle = {
    scope,
    fields,
    rows,
    fileCount,
    fileKinds,
    structured,
  }
  return {
    bundleId: `bundle_${shortHash(`${ctx.runId}:${scope}:${JSON.stringify(bundle)}`)}`,
    scope,
    fields: fields.length > 0 ? fields : Object.keys((rows?.[0] ?? structured ?? {}) as Record<string, unknown>).slice(0, 20),
    structured,
    ...(rows ? { rows, rowCount: rows.length } : {}),
    ...(fileCount !== undefined ? { fileCount } : {}),
    ...(fileKinds !== undefined ? { fileKinds } : {}),
    redactions: 0,
    contentHash: hashJson(bundle),
  }
}

function outputKindsForExpectedOutputs(expectedOutputs: SandboxRunCodeInput['expectedOutputs']) {
  const requested = new Set(expectedOutputs ?? [])
  const kinds: SandboxArtifactKind[] = []
  if (requested.has('csv')) kinds.push('csv')
  if (requested.has('spreadsheet')) kinds.push('xlsx')
  if (requested.has('document')) kinds.push('pdf', 'docx')
  if (requested.has('image') || requested.has('chart')) kinds.push('png')
  if (requested.has('markdown')) kinds.push('md')
  if (requested.has('json') || requested.has('table')) kinds.push('json')
  return kinds.length > 0 ? kinds : ['json', 'csv', 'xlsx', 'png', 'txt', 'md']
}

function buildManifest(ctx: SandboxServiceContext, input: SandboxRunCodeInput, bundle: SandboxDataBundle, toolCallId: string): SandboxManifest {
  const allowedArtifactKinds = normalizeSandboxArtifactKinds(outputKindsForExpectedOutputs(input.expectedOutputs))
  return {
    schemaVersion: 1,
    identity: {
      tenantId: ctx.workspace.owner_id,
      workspaceId: ctx.workspace.id,
      threadId: ctx.threadId,
      runId: ctx.runId,
      toolCallId,
      userIdHash: shortHash(ctx.user.id),
    },
    inputBundle: {
      bundleId: bundle.bundleId,
      kind: bundle.scope,
      schemaVersion: 'xox.sandbox.bundle.v1',
      mountPath: '/input',
      readonly: true,
      fields: bundle.fields,
      ...(bundle.rowCount !== undefined ? { rowCount: bundle.rowCount } : {}),
      ...(bundle.fileCount !== undefined ? { fileCount: bundle.fileCount } : {}),
      ...(bundle.fileKinds && bundle.fileKinds.length > 0 ? { fileKinds: bundle.fileKinds } : {}),
      redactions: bundle.redactions,
      contentHash: bundle.contentHash,
    },
    runtime: {
      language: input.language,
      entrypoint: 'single_script',
      timeoutMs: 10_000,
      cpuMs: 5_000,
      memoryMb: 256,
      processLimit: 1,
      openFileLimit: 64,
      stdoutLimitBytes: 32_768,
      stderrLimitBytes: 32_768,
    },
    capabilities: DEFAULT_CAPABILITIES,
    network: {
      mode: 'disabled',
      allowlist: [],
    },
    outputPolicy: {
      writableMountPath: '/output',
      maxArtifactCount: 5,
      maxArtifactBytes: 10 * 1024 * 1024,
      allowedArtifactKinds: allowedArtifactKinds.length > 0 ? allowedArtifactKinds : DEFAULT_SANDBOX_ARTIFACT_KINDS,
      expiresInSeconds: 24 * 60 * 60,
    },
  }
}

class FakeDeterministicSandboxBackend implements SandboxBackend {
  async create(manifest: SandboxManifest): Promise<SandboxSessionRef> {
    return { id: `sandbox_${shortHash(`${manifest.identity.runId}:${manifest.identity.toolCallId}`)}`, manifest }
  }

  async execute(session: SandboxSessionRef, input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
    const startedAt = Date.now()
    const codeBytes = Buffer.byteLength(input.input.code, 'utf8')
    const blocked = codeBytes > 24_000
    if (blocked) {
      return {
        status: 'blocked',
        result: {
          summary: '沙箱代码超过当前 fake backend 的大小限制，已阻断执行。',
          structured: { reason: 'code_too_large', codeBytes },
        },
        artifacts: [],
        resourceUsage: {
          wallTimeMs: Math.max(1, Date.now() - startedAt),
          stdoutBytes: 0,
          stderrBytes: 0,
        },
        errorMessage: 'code_too_large',
      }
    }
    const structured = {
      executionMode: 'fake_deterministic',
      manifestScoped: true,
      businessReadonly: true,
      purpose: input.input.purpose,
      dataScope: input.bundle.scope,
      inputBundle: {
        fields: input.bundle.fields,
        rows: input.bundle.rowCount ?? 0,
        files: input.bundle.fileCount ?? 0,
        fileKinds: input.bundle.fileKinds ?? [],
      },
      data: input.bundle.structured,
    }
    return {
      status: 'completed',
      result: {
        summary: `${input.input.purpose} 已在 manifest-scoped fake sandbox 中完成，结果已作为只读 observation 回传。`,
        structured,
        tables: input.bundle.rows ? [{ name: input.bundle.scope, rows: input.bundle.rows.slice(0, 20) }] : [],
        proposedPatches: [],
      },
      artifacts: [],
      resourceUsage: {
        wallTimeMs: Math.max(1, Date.now() - startedAt),
        cpuMs: 1,
        memoryPeakMb: 32,
        stdoutBytes: 0,
        stderrBytes: 0,
      },
    }
  }

  async collect(_session: SandboxSessionRef): Promise<SandboxObservation['artifacts']> {
    return []
  }

  async destroy(_session: SandboxSessionRef): Promise<void> {
    // Fake backend has no external resources.
  }
}

function displayPreview(observation: SandboxObservation) {
  return JSON.stringify({
    status: observation.status,
    purpose: observation.purpose,
    scope: observation.dataBundleSummary.scope,
    fields: observation.dataBundleSummary.fields,
    rows: observation.dataBundleSummary.rows ?? 0,
    files: observation.dataBundleSummary.files ?? 0,
    network: observation.manifest.network.mode,
    businessWrites: observation.manifest.capabilities.businessWrites,
    result: observation.result.summary,
  }, null, 2)
}

export async function runSandboxCode(ctx: SandboxServiceContext, step: RuntimePlannerStep): Promise<SandboxObservation> {
  const input = normalizeSandboxInput(step)
  const toolCallId = step.providerToolCallId ?? `sandbox_${shortHash(`${ctx.runId}:${input.purpose}`)}`
  const bundle = await buildSandboxDataBundle(ctx, input)
  const manifest = buildManifest(ctx, input, bundle, toolCallId)
  const backend = new FakeDeterministicSandboxBackend()
  const session = await backend.create(manifest)
  try {
    const execution = await backend.execute(session, { input, bundle })
    const artifacts = [...execution.artifacts, ...await backend.collect(session)]
    return {
      runId: ctx.runId,
      sandboxRunId: session.id,
      status: execution.status,
      purpose: input.purpose,
      language: input.language,
      manifest,
      dataBundleSummary: {
        scope: bundle.scope,
        ...(bundle.rowCount !== undefined ? { rows: bundle.rowCount } : {}),
        ...(bundle.fileCount !== undefined ? { files: bundle.fileCount } : {}),
        fields: bundle.fields,
        redactions: bundle.redactions,
      },
      result: execution.result,
      artifacts,
      resourceUsage: execution.resourceUsage,
    }
  } finally {
    await backend.destroy(session)
  }
}

export async function planSandboxRunCode(ctx: PlannerContext, step: RuntimePlannerStep): Promise<ReadDraft> {
  const observation = await runSandboxCode(ctx, step)
  const preview = displayPreview(observation)
  return {
    title: observation.status === 'completed' ? '受控沙箱执行完成' : '受控沙箱执行被阻断',
    message: preview,
    readKind: 'tool_observation',
    modelContent: JSON.stringify({
      observationType: 'sandbox_result',
      completed: observation.status === 'completed',
      businessReadonly: true,
      manifestScoped: true,
      ...observation,
    }),
    displayPreview: preview,
    status: observation.status === 'completed' ? 'executed' : 'failed',
  }
}

export const sandboxInternalsForTests = {
  normalizeSandboxInput,
  buildSandboxDataBundle,
  buildManifest,
  FakeDeterministicSandboxBackend,
}
