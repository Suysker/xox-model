import { createHash, randomBytes } from 'node:crypto'
import { classifyToolObservationOutcome, type ToolObservationStatus } from '@agentic-os/core'
import { projectModel, type ModelConfig, type ScenarioResult } from '@xox/domain'
import type {
  SandboxArtifactKind,
  SandboxCapabilityProfile,
  SandboxDataScope,
  SandboxEvidenceProof,
  SandboxFileKind,
  SandboxManifest,
  SandboxNestedToolObservation,
  SandboxObservation,
  SandboxRunCodeInput,
} from '@xox/contracts'
import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import { draftContext, getWorkspaceDraft } from '../modules/workspace.js'
import { listEntries, listPeriods } from '../modules/ledger.js'
import type { CurrentUser } from '../modules/auth.js'
import { normalizeSandboxArtifactKinds, normalizeSandboxFileKinds } from './sandbox-file-adapters.js'
import {
  buildPlannedItemFromRuntimeStep,
  isActionDraft,
  type ActionDraftBuilderHandlers,
  type PlannedItem,
  type ReadDraft,
  type RuntimePlannerStep,
} from './action-draft-builder.js'
import type { AgentActionDraft } from './action-draft-builder.js'
import type { PlannerContext } from './action-draft-builder.js'
import type {
  SandboxDataBundle,
  SandboxToolDocument,
  SandboxToolRuntimeRequest,
  SandboxToolRuntimeResponse,
  SandboxToolSdkEntry,
} from '@agentic-os/sandbox'
import { SandboxBroker } from '@agentic-os/sandbox'
import { AGENT_TOOL_REGISTRY, toolCallToPlannerStep, type AgentToolRiskLevel } from './tool-catalog.js'
import { buildToolManifests } from './tool-surface-manifest.js'

type SandboxExpectedOutput = NonNullable<SandboxRunCodeInput['expectedOutputs']>[number]

type SandboxServiceContext = {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
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

const DISPLAY_TEXT_PREVIEW_LIMIT = 500
const riskRank: Record<'low' | 'medium' | 'high', number> = { low: 1, medium: 2, high: 3 }

function hashJson(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : { value: parsed }
  } catch {
    return { text: value }
  }
}

function serializeToolManifestDocument(input: { title: string; tools: SandboxToolSdkEntry[] }) {
  return [
    `# ${input.title}`,
    '',
    'These tools are scoped to this sandbox session. Function names, arguments and result contracts mirror the provider tool registry.',
    '',
    ...input.tools.map((tool) => [
      `## ${tool.name}`,
      '',
      `- capability: ${tool.capability}`,
      `- riskLevel: ${tool.riskLevel}`,
      `- confirmationMode: ${tool.confirmationMode}`,
      `- navigationTarget: ${tool.navigationTarget ?? 'none'}`,
      `- parameters: ${tool.parameterNames.length > 0 ? tool.parameterNames.join(', ') : 'none'}`,
      `- summary: ${tool.summary}`,
      '',
    ].join('\n')),
  ].join('\n')
}

function buildSandboxToolSdk(): { tools: SandboxToolSdkEntry[]; documents: SandboxToolDocument[] } {
  const manifests = buildToolManifests(AGENT_TOOL_REGISTRY)
  const tools = manifests.map((manifest): SandboxToolSdkEntry => ({
    name: manifest.name,
    capability: manifest.capability,
    riskLevel: manifest.riskLevel,
    confirmationMode: manifest.confirmationMode,
    navigationTarget: manifest.navigationTarget,
    parameterNames: manifest.parameterNames,
    summary: manifest.summary,
  }))
  const manifestText = serializeToolManifestDocument({ title: 'xox-model Agent Tool Manifest', tools })
  return {
    tools,
    documents: [
      { path: 'tools/agent-tool-manifest.md', text: manifestText },
      { path: 'tools/effective-tool-manifest.md', text: manifestText },
      {
        path: 'tools/sandbox-sdk.md',
        text: [
          '# xox_sandbox SDK',
          '',
          'Use Python functions as xox_sandbox.<tool_name>(**args).',
          'Use JavaScript functions as either snake_case or camelCase exports from ./xox_sandbox.mjs.',
          'Read tools return model-readable observations. Write tools record nested Tool Runtime requests and may produce one aggregate approval.',
        ].join('\n'),
      },
    ],
  }
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

function sandboxMonthRows(baseScenario: ScenarioResult | null, monthLabels: Set<string>, rowLimit: number) {
  return (baseScenario?.months ?? [])
    .filter((month) => monthLabels.size === 0 || monthLabels.has(month.label))
    .slice(0, rowLimit)
    .map((month) => ({
      monthIndex: month.monthIndex,
      monthLabel: month.label,
      grossSales: month.grossSales,
      plannedRevenue: month.grossSales,
      totalCost: month.totalCost,
      plannedCost: month.totalCost,
      monthlyProfit: month.monthlyProfit,
      plannedProfit: month.monthlyProfit,
      cumulativeCash: month.cumulativeCash,
      cash: month.cumulativeCash,
    }))
}

function sandboxShareholderRows(config: ModelConfig) {
  return config.shareholders.map((shareholder, index) => ({
    index: index + 1,
    id: shareholder.id,
    name: shareholder.name,
    investmentAmount: shareholder.investmentAmount,
    dividendRate: shareholder.dividendRate,
  }))
}

function buildProjectionStructuredBundle(args: {
  scope: SandboxDataScope
  workspaceName: string
  config: ModelConfig
  baseScenario: ScenarioResult | null
  monthLabels?: Set<string>
  rowLimit?: number
}) {
  const monthLabels = args.monthLabels ?? new Set<string>()
  const rowLimit = args.rowLimit ?? 500
  const months = sandboxMonthRows(args.baseScenario, monthLabels, rowLimit)
  const shareholders = sandboxShareholderRows(args.config)
  const grossSales = months.reduce((sum, month) => sum + month.grossSales, 0)
  const totalCost = months.reduce((sum, month) => sum + month.totalCost, 0)
  const totalProfit = grossSales - totalCost
  const totalInvestment = shareholders.reduce((sum, shareholder) => sum + shareholder.investmentAmount, 0)
  const fullProjection = monthLabels.size === 0
  const endingCash = months.at(-1)?.cumulativeCash ?? 0
  const netCashAfterInvestment = fullProjection
    ? args.baseScenario?.netCashAfterInvestment ?? endingCash
    : endingCash
  return {
    scope: args.scope,
    workspaceName: args.workspaceName,
    monthCount: months.length,
    grossSales,
    totalCost,
    totalProfit,
    totalInvestment: args.baseScenario?.totalInvestment ?? totalInvestment,
    netCashAfterInvestment,
    roi: fullProjection && args.baseScenario ? args.baseScenario.roi : totalInvestment > 0 ? netCashAfterInvestment / totalInvestment : 0,
    endingCash,
    paybackMonthLabel: fullProjection ? args.baseScenario?.paybackMonthLabel ?? null : null,
    months,
    rows: months,
    shareholders,
    firstShareholder: shareholders[0] ?? null,
  }
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
    structured = buildProjectionStructuredBundle({
      scope,
      workspaceName: ctx.workspace.name,
      config,
      baseScenario,
      monthLabels,
      rowLimit,
    })
    rows = (structured as { rows: unknown[] }).rows
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
      note: '文件内容由 File Adapter Registry 解析后进入 manifest-scoped 沙箱。',
    }
  } else {
    structured = buildProjectionStructuredBundle({
      scope,
      workspaceName: ctx.workspace.name,
      config,
      baseScenario,
      monthLabels: new Set(),
      rowLimit,
    })
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
    fields: fields.length > 0 ? fields : Object.keys((structured ?? rows?.[0] ?? {}) as Record<string, unknown>).slice(0, 20),
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
  const manifestSeed = `${ctx.workspace.id}:${ctx.runId}:${toolCallId}:${bundle.bundleId}:${bundle.contentHash}`
  return {
    schemaVersion: 1,
    manifestId: `manifest_${shortHash(manifestSeed)}`,
    nonce: randomBytes(16).toString('hex'),
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

function displayTextReference(value: string) {
  const bytes = Buffer.byteLength(value, 'utf8')
  const truncatedForDisplay = bytes > DISPLAY_TEXT_PREVIEW_LIMIT
  return {
    preview: truncatedForDisplay ? value.slice(0, DISPLAY_TEXT_PREVIEW_LIMIT) : value,
    truncatedForDisplay,
    truncatedForModel: false,
    sha256: hashText(value),
    bytes,
  }
}

function displayStructuredReference(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') {
    return value.length > DISPLAY_TEXT_PREVIEW_LIMIT
      ? {
          preview: value.slice(0, DISPLAY_TEXT_PREVIEW_LIMIT),
          truncatedForDisplay: true,
          sha256: hashText(value),
          bytes: Buffer.byteLength(value, 'utf8'),
        }
      : value
  }
  if (typeof value !== 'object') return value
  if (depth >= 4) return '[nested structure truncated]'
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => displayStructuredReference(item, depth + 1))
    return value.length > items.length
      ? [...items, { truncatedItems: value.length - items.length }]
      : items
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const compact: Record<string, unknown> = {}
  for (const [key, entryValue] of entries.slice(0, 40)) {
    compact[key] = displayStructuredReference(entryValue, depth + 1)
  }
  if (entries.length > 40) compact.truncatedKeys = entries.length - 40
  return compact
}

function displayPreview(observation: SandboxObservation) {
  const outputText = displayTextReference(observation.outputText)
  const resultSummary = displayTextReference(observation.result.summary)
  const parsedOutput = observation.extraction.parsedOutput === undefined
    ? undefined
    : displayStructuredReference(observation.extraction.parsedOutput)
  return JSON.stringify({
    status: observation.status,
    executionMode: observation.executionMode,
    backendId: observation.backendId,
    exitCode: observation.exitCode,
    purpose: observation.purpose,
    scope: observation.dataBundleSummary.scope,
    fields: observation.dataBundleSummary.fields,
    rows: observation.dataBundleSummary.rows ?? 0,
    files: observation.dataBundleSummary.files ?? 0,
    network: observation.manifest.network.mode,
    directBusinessWrites: observation.manifest.capabilities.businessWrites,
    extractionStatus: observation.extraction.extractionStatus,
    extraction: {
      status: observation.extraction.extractionStatus,
      ...(parsedOutput !== undefined ? { parsedOutput } : {}),
      ...(observation.extraction.summary ? { summary: displayTextReference(observation.extraction.summary) } : {}),
      ...(observation.extraction.warnings?.length ? { warnings: observation.extraction.warnings } : {}),
    },
    outputText,
    result: {
      summary: resultSummary,
    },
    rawOutputRef: {
      storage: 'sandbox_observation',
      id: observation.sandboxRunId,
      sha256: outputText.sha256,
      bytes: outputText.bytes,
      truncatedForDisplay: outputText.truncatedForDisplay,
      truncatedForModel: false,
    },
  }, null, 2)
}

function hasModelReadableSandboxOutput(observation: SandboxObservation) {
  return Boolean(
    observation.outputText.trim() ||
    observation.stdout.trim() ||
    observation.stderr.trim() ||
    observation.extraction.extractionStatus === 'parsed' ||
    observation.artifacts.length > 0,
  )
}

function sandboxOutputHash(observation: SandboxObservation) {
  return hashJson({
    stdout: observation.stdout,
    stderr: observation.stderr,
    outputText: observation.outputText,
    extraction: observation.extraction.parsedOutput ?? observation.extraction.summary ?? null,
    artifacts: observation.artifacts.map((artifact) => ({
      id: artifact.artifactId,
      name: artifact.name,
      sizeBytes: artifact.sizeBytes,
    })),
  })
}

function buildSandboxEvidenceProof(observation: SandboxObservation): SandboxEvidenceProof | undefined {
  if (
    observation.status !== 'completed' ||
    observation.executionMode !== 'executed' ||
    observation.exitCode !== 0
  ) {
    return undefined
  }
  const nested = observation.nestedToolObservations ?? []
  const sourceObservationRefs = [
    ...(observation.provenance.inputBundleConsumed ? observation.inputEvidenceIds : []),
    ...nested.flatMap((item) => item.status === 'completed' ? [item.observationId] : []),
  ]
  return {
    executionMode: 'executed',
    status: 'completed',
    exitCode: 0,
    backendId: observation.backendId,
    codeHash: observation.provenance.codeHash,
    outputHash: sandboxOutputHash(observation),
    manifest: {
      manifestId: observation.manifest.manifestId,
      bundleId: observation.manifest.inputBundle.bundleId,
      contentHash: observation.manifest.inputBundle.contentHash,
      nonce: observation.manifest.nonce,
      consumed: Boolean(observation.provenance.inputBundleConsumed),
    },
    sdkCalls: nested.map((item) => ({
      name: item.name,
      argumentsHash: item.argumentsHash,
      observationId: item.observationId,
      status: item.status,
    })),
    sourceObservationRefs,
  }
}

function sandboxObservationStatus(observation: SandboxObservation): ToolObservationStatus {
  if (observation.status === 'completed') return 'completed'
  if (observation.status === 'cancelled') return 'cancelled'
  if (observation.status === 'blocked') return 'not_executed'
  return 'failed'
}

async function sandboxToolRuntimeHandler(input: {
  ctx: PlannerContext
  handlers?: ActionDraftBuilderHandlers<PlannerContext>
  nestedObservations: SandboxNestedToolObservation[]
  parentToolCallId: string
  request: SandboxToolRuntimeRequest
}): Promise<SandboxToolRuntimeResponse> {
  if (input.request.toolName === 'sandbox_run_code') {
    return {
      ok: false,
      toolName: input.request.toolName,
      status: 'failed' as const,
      error: {
        code: 'sandbox.tool_recursion_forbidden',
        message: 'sandbox_run_code cannot be called recursively from inside sandbox code.',
        repairable: true,
      },
    }
  }
  const step = toolCallToPlannerStep(input.request.toolName, input.request.arguments)
  if (!step || !input.handlers) {
    return {
      ok: false,
      toolName: input.request.toolName,
      status: 'failed' as const,
      error: {
        code: 'sandbox.tool_runtime_mapping_missing',
        message: `${input.request.toolName} is not mapped in the Tool Runtime Gateway.`,
        repairable: true,
      },
    }
  }
  const providerToolCallId = `${input.parentToolCallId}_${input.request.id}`
  const planned = await buildPlannedItemFromRuntimeStep(input.ctx, {
    ...step,
    providerToolName: input.request.toolName,
    providerToolCallId,
    providerToolCallIndex: 0,
    providerToolArguments: input.request.arguments,
  }, input.handlers)
  const item = Array.isArray(planned) ? planned[0] : planned
  if (!item) {
    return {
      ok: false,
      toolName: input.request.toolName,
      status: 'failed' as const,
      error: {
        code: 'sandbox.tool_runtime_no_result',
        message: `${input.request.toolName} produced no runtime observation.`,
        repairable: true,
      },
    }
  }
  if (isActionDraft(item)) {
    const observationId = `${providerToolCallId}_pending_approval`
    input.nestedObservations.push({
      observationId,
      name: input.request.toolName,
      argumentsHash: hashJson(input.request.arguments),
      status: 'pending_approval',
    })
    return {
      ok: false,
      toolName: input.request.toolName,
      observationId,
      status: 'pending_approval' as const,
      error: {
        code: 'sandbox.tool_runtime_pending_approval',
        message: `${input.request.toolName} requires aggregate approval after sandbox execution.`,
        repairable: true,
      },
    }
  }
  const modelContent = item.modelContent ?? item.displayPreview ?? item.message
  const output = parseJsonObject(modelContent) ?? { text: modelContent }
  const status: NonNullable<SandboxToolRuntimeResponse['status']> = item.observationStatus === 'failed' || item.status === 'failed'
    ? 'failed'
    : 'completed'
  const observationId = `${providerToolCallId}_observation`
  input.nestedObservations.push({
    observationId,
    name: input.request.toolName,
    argumentsHash: hashJson(input.request.arguments),
    status,
    modelContent,
    outputHash: hashJson(output),
  })
  return {
    ok: status === 'completed',
    toolName: input.request.toolName,
    observationId,
    status,
    output,
    ...(status === 'completed'
      ? {}
      : {
          error: {
            code: 'sandbox.tool_runtime_failed',
            message: `${input.request.toolName} did not complete successfully.`,
            repairable: true,
          },
        }),
  }
}

export async function runSandboxCode(
  ctx: SandboxServiceContext,
  step: RuntimePlannerStep,
  handlers?: ActionDraftBuilderHandlers<PlannerContext>,
): Promise<SandboxObservation> {
  const input = normalizeSandboxInput(step)
  const toolCallId = step.providerToolCallId ?? `sandbox_${shortHash(`${ctx.runId}:${input.purpose}`)}`
  const bundle = await buildSandboxDataBundle(ctx, input)
  const manifest = buildManifest(ctx, input, bundle, toolCallId)
  const broker = new SandboxBroker()
  const toolSdk = buildSandboxToolSdk()
  const nestedToolObservations: SandboxNestedToolObservation[] = []
  const execution = await broker.execute({
    manifest,
    toolInput: input,
    bundle,
    toolSdk,
    ...(handlers
      ? {
          toolRuntimeHandler: (request) => sandboxToolRuntimeHandler({
            ctx: ctx as PlannerContext,
            handlers,
            nestedObservations: nestedToolObservations,
            parentToolCallId: toolCallId,
            request,
          }),
        }
      : {}),
    ...(process.env.XOX_SANDBOX_BACKEND ? { preferredBackendId: process.env.XOX_SANDBOX_BACKEND } : {}),
  })
  const observation: SandboxObservation = {
    runId: ctx.runId,
    sandboxRunId: execution.sessionId,
    status: execution.status,
    executionMode: execution.executionMode,
    backendId: execution.backendId,
    sessionId: execution.sessionId,
    exitCode: execution.exitCode,
    durationMs: execution.durationMs,
    stdout: execution.stdout,
    stderr: execution.stderr,
    outputText: execution.outputText,
    extraction: execution.extraction,
    provenance: execution.provenance,
    manifestHash: execution.manifestHash,
    inputEvidenceIds: execution.inputEvidenceIds,
    manifestScoped: execution.manifestScoped,
    nestedToolObservations,
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
    artifacts: execution.artifacts,
    resourceUsage: execution.resourceUsage,
  }
  const proof = buildSandboxEvidenceProof(observation)
  return proof ? { ...observation, evidenceProof: proof } : observation
}

function riskLevelForTool(name: string): AgentToolRiskLevel | null {
  return AGENT_TOOL_REGISTRY.find((entry) => entry.name === name)?.riskLevel ?? null
}

function shouldBridgeSandboxToolCall(name: string) {
  const entry = AGENT_TOOL_REGISTRY.find((item) => item.name === name)
  if (!entry) return false
  return entry.riskLevel !== 'read' || entry.confirmationMode !== 'never'
}

function sandboxToolCallsFrom(value: unknown): Array<{ toolName: string; arguments: Record<string, unknown> }> {
  const item = isRecord(value) ? value : null
  if (!item) return []
  const rawCalls = Array.isArray(item.sandboxToolCalls)
    ? item.sandboxToolCalls
    : Array.isArray(item.toolCalls)
      ? item.toolCalls
      : []
  return rawCalls.flatMap((call) => {
    if (!isRecord(call)) return []
    const toolName = typeof call.toolName === 'string'
      ? call.toolName
      : typeof call.name === 'string'
        ? call.name
        : ''
    const args = isRecord(call.arguments)
      ? call.arguments
      : isRecord(call.args)
        ? call.args
        : {}
    if (!toolName || !shouldBridgeSandboxToolCall(toolName)) return []
    return [{ toolName, arguments: args }]
  })
}

function sandboxToolCalls(observation: SandboxObservation) {
  return [
    ...sandboxToolCallsFrom(observation.extraction.parsedOutput),
    ...sandboxToolCallsFrom(observation.result.structured),
  ].filter((call, index, calls) => {
    const key = `${call.toolName}:${JSON.stringify(call.arguments)}`
    return calls.findIndex((item) => `${item.toolName}:${JSON.stringify(item.arguments)}` === key) === index
  })
}

function maxRisk(actions: AgentActionDraft[]): 'low' | 'medium' | 'high' {
  return actions.reduce<'low' | 'medium' | 'high'>((max, action) => (
    riskRank[action.riskLevel] > riskRank[max] ? action.riskLevel : max
  ), 'low')
}

function serializableNestedAction(action: AgentActionDraft) {
  return {
    kind: action.kind,
    title: action.title,
    summary: action.summary,
    targetLabel: action.targetLabel,
    riskLevel: action.riskLevel,
    details: action.details,
    navigation: action.navigation,
    payload: action.payload,
  }
}

async function aggregateSandboxActions(input: {
  ctx: PlannerContext
  observation: SandboxObservation
  handlers?: ActionDraftBuilderHandlers<PlannerContext>
}) {
  if (!input.handlers) return []
  const calls = sandboxToolCalls(input.observation)
  const actions: AgentActionDraft[] = []
  for (const [index, call] of calls.entries()) {
    const step = toolCallToPlannerStep(call.toolName, call.arguments)
    if (!step) continue
    const item = await buildPlannedItemFromRuntimeStep(input.ctx, {
      ...step,
      providerToolName: call.toolName,
      providerToolCallId: `${input.observation.sandboxRunId}_${index}_${call.toolName}`,
      providerToolCallIndex: index,
      providerToolArguments: call.arguments,
    }, input.handlers)
    const items = Array.isArray(item) ? item : item ? [item] : []
    for (const entry of items) {
      if (isActionDraft(entry)) actions.push(entry)
    }
  }
  if (actions.length === 0) return []
  const riskLevel = maxRisk(actions)
  const firstNavigation = actions[0]?.navigation
  return [{
    kind: 'sandbox.aggregate_tool_calls',
    title: '确认沙箱工具写入',
    summary: `沙箱请求执行 ${actions.length} 个写入动作。`,
    targetLabel: input.ctx.workspace.name,
    riskLevel,
    details: actions.map((action, index) => ({
      label: `${index + 1}. ${action.title}`,
      value: action.summary,
    })),
    navigation: firstNavigation ?? {
      type: 'navigation',
      route: { mainTab: 'dashboard' },
      reason: '沙箱写入聚合确认需要打开相关工作台页面核对。',
    },
    payload: {
      sandboxRunId: input.observation.sandboxRunId,
      nestedActions: actions.map(serializableNestedAction),
    },
  } satisfies AgentActionDraft]
}

export async function planSandboxRunCode(
  ctx: PlannerContext,
  step: RuntimePlannerStep,
  handlers?: ActionDraftBuilderHandlers<PlannerContext>,
): Promise<ReadDraft | PlannedItem[]> {
  const observation = await runSandboxCode(ctx, step, handlers)
  const preview = displayPreview(observation)
  const modelContent = JSON.stringify({
    observationType: 'sandbox_execution',
    completed: observation.status === 'completed' &&
      observation.executionMode === 'executed' &&
      observation.exitCode === 0 &&
      observation.manifestScoped === true &&
      hasModelReadableSandboxOutput(observation),
    directBusinessWrites: false,
    nestedToolRuntimeBridge: true,
    sandboxToolCalls: sandboxToolCalls(observation).map((call) => ({
      ...call,
      riskLevel: riskLevelForTool(call.toolName),
    })),
    ...observation,
  })
  const observationStatus = sandboxObservationStatus(observation)
  const readDraft: ReadDraft = {
    title: observation.status === 'completed' ? '受控沙箱执行完成' : '受控沙箱执行被阻断',
    message: preview,
    readKind: 'tool_observation',
    toolName: 'sandbox_run_code',
    toolCallId: step.providerToolCallId ?? observation.manifest.identity.toolCallId,
    toolArguments: step.providerToolArguments ?? {},
    modelContent,
    displayPreview: preview,
    observationStatus,
    observationOutcome: classifyToolObservationOutcome({
      toolName: 'sandbox_run_code',
      status: observationStatus,
      modelContent,
    }),
    status: observation.status === 'completed' ? 'executed' : 'failed',
  }
  const aggregateActions = await aggregateSandboxActions({
    ctx,
    observation,
    ...(handlers ? { handlers } : {}),
  })
  return aggregateActions.length > 0 ? [readDraft, ...aggregateActions] : readDraft
}

export const sandboxInternalsForTests = {
  normalizeSandboxInput,
  buildProjectionStructuredBundle,
  buildSandboxDataBundle,
  buildManifest,
  buildSandboxToolSdk,
  displayPreview,
}
