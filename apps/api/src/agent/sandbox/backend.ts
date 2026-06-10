import type {
  SandboxArtifactKind,
  SandboxDataScope,
  SandboxFileKind,
  SandboxManifest,
  SandboxObservation,
  SandboxRunCodeInput,
} from '@xox/contracts'

export type SandboxDataBundle = {
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

export type SandboxToolSdkEntry = {
  name: string
  capability: string
  riskLevel: string
  confirmationMode: string
  navigationTarget: string | null
  parameterNames: string[]
  summary: string
}

export type SandboxToolDocument = {
  path: string
  text: string
}

export type SandboxSessionRef = {
  id: string
  manifest: SandboxManifest
  workDir?: string
}

export type SandboxExecuteInput = {
  input: SandboxRunCodeInput
  bundle: SandboxDataBundle
  toolSdk?: {
    tools: SandboxToolSdkEntry[]
    documents: SandboxToolDocument[]
  }
  toolRuntimeHandler?: SandboxToolRuntimeHandler
}

export type SandboxToolRuntimeRequest = {
  id: string
  toolName: string
  arguments: Record<string, unknown>
}

export type SandboxToolRuntimeResponse = {
  ok: boolean
  toolName: string
  observationId?: string
  output?: unknown
  status?: 'completed' | 'failed' | 'pending_approval'
  error?: {
    code: string
    message: string
    repairable: boolean
  }
}

export type SandboxToolRuntimeHandler = (
  request: SandboxToolRuntimeRequest,
) => Promise<SandboxToolRuntimeResponse>

export type SandboxExecutionStatus = SandboxObservation['status']

export type SandboxExecutionResult = {
  status: SandboxExecutionStatus
  executionMode: SandboxObservation['executionMode']
  backendId: string
  sessionId: string
  exitCode: number | null
  durationMs: number
  stdout: string
  stderr: string
  outputText: string
  extraction: SandboxObservation['extraction']
  provenance: SandboxObservation['provenance']
  artifacts: SandboxObservation['artifacts']
  result: SandboxObservation['result']
  resourceUsage: SandboxObservation['resourceUsage']
  manifestHash: string
  inputEvidenceIds: string[]
  manifestScoped: true
  inputBundleConsumed?: boolean
  errorMessage?: string
}

export type SandboxBackendRuntime = 'python' | 'javascript'

export interface SandboxBackend {
  id: string
  supportedLanguages: readonly SandboxBackendRuntime[]
  create(manifest: SandboxManifest): Promise<SandboxSessionRef>
  execute(session: SandboxSessionRef, input: SandboxExecuteInput): Promise<SandboxExecutionResult>
  collect(session: SandboxSessionRef): Promise<SandboxObservation['artifacts']>
  destroy(session: SandboxSessionRef): Promise<void>
}

export type SandboxArtifactDescriptor = {
  artifactId: string
  kind: SandboxArtifactKind
  name: string
  sizeBytes: number
}
