import { createHash } from 'node:crypto'
import type { SandboxManifest } from '@xox/contracts'
import type { SandboxDataBundle, SandboxExecutionResult } from './backend.js'
import { createDefaultSandboxBackendRegistry, type SandboxBackendRegistry } from './backend-registry.js'
import { validateSandboxPolicy } from './sandbox-policy.js'
import type { SandboxRunCodeInput } from '@xox/contracts'

function hashJson(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function blockedResult(input: {
  manifest: SandboxManifest
  toolInput: SandboxRunCodeInput
  bundle: SandboxDataBundle
  reason: string
  details?: Record<string, unknown>
}): SandboxExecutionResult {
  const summary = `沙箱执行被策略阻断：${input.reason}`
  return {
    status: 'blocked',
    executionMode: 'not_executed',
    backendId: 'policy',
    sessionId: `blocked_${input.manifest.identity.toolCallId}`,
    exitCode: null,
    durationMs: 1,
    stdout: '',
    stderr: '',
    outputText: summary,
    extraction: {
      extractionStatus: 'parsed',
      summary,
      parsedOutput: {
        reason: input.reason,
        ...(input.details ?? {}),
      },
    },
    artifacts: [],
    result: {
      summary,
      structured: {
        reason: input.reason,
        ...(input.details ?? {}),
      },
      proposedPatches: [],
    },
    resourceUsage: {
      wallTimeMs: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
    },
    manifestHash: hashJson(input.manifest),
    inputEvidenceIds: [`bundle:${input.bundle.bundleId}`, `content:${input.bundle.contentHash}`],
    manifestScoped: true,
    provenance: {
      manifestId: input.manifest.manifestId,
      bundleId: input.bundle.bundleId,
      bundleContentHash: input.bundle.contentHash,
      inputBundleMounted: false,
      codeHash: hashText(input.toolInput.code),
      stdoutHash: hashText(''),
      stderrHash: hashText(''),
      outputArtifactHashes: [],
      capabilityProfile: input.manifest.capabilities,
      resourceUsage: {
        stdoutBytes: 0,
        stderrBytes: 0,
      },
    },
    errorMessage: input.reason,
  }
}

export class SandboxBroker {
  constructor(private readonly registry: SandboxBackendRegistry = createDefaultSandboxBackendRegistry()) {}

  async execute(input: {
    manifest: SandboxManifest
    toolInput: SandboxRunCodeInput
    bundle: SandboxDataBundle
    toolSdk?: import('./backend.js').SandboxExecuteInput['toolSdk']
    preferredBackendId?: string
  }): Promise<SandboxExecutionResult> {
    const policy = validateSandboxPolicy({
      manifest: input.manifest,
      toolInput: input.toolInput,
    })
    if (!policy.ok) {
      return blockedResult({
        manifest: input.manifest,
        toolInput: input.toolInput,
        bundle: input.bundle,
        reason: policy.reason,
        ...(policy.details ? { details: policy.details } : {}),
      })
    }

    const backend = this.registry.resolve({
      ...(input.preferredBackendId ? { preferredBackendId: input.preferredBackendId } : {}),
      manifest: input.manifest,
    })
    const session = await backend.create(input.manifest)
    try {
      const result = await backend.execute(session, {
        input: input.toolInput,
        bundle: input.bundle,
        ...(input.toolSdk ? { toolSdk: input.toolSdk } : {}),
      })
      const collected = await backend.collect(session)
      return {
        ...result,
        artifacts: [...result.artifacts, ...collected],
      }
    } finally {
      await backend.destroy(session)
    }
  }
}
