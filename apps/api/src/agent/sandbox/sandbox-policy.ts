import type { SandboxManifest, SandboxRunCodeInput } from '@xox/contracts'

export type SandboxPolicyResult =
  | { ok: true }
  | { ok: false; status: 'blocked'; reason: string; details?: Record<string, unknown> }

const MAX_CODE_BYTES = 64_000
const MAX_TIMEOUT_MS = 60_000

export function validateSandboxPolicy(input: {
  manifest: SandboxManifest
  toolInput: SandboxRunCodeInput
}): SandboxPolicyResult {
  const codeBytes = Buffer.byteLength(input.toolInput.code, 'utf8')
  if (codeBytes === 0) return { ok: false, status: 'blocked', reason: 'empty_code' }
  if (codeBytes > MAX_CODE_BYTES) {
    return { ok: false, status: 'blocked', reason: 'code_too_large', details: { codeBytes, maxCodeBytes: MAX_CODE_BYTES } }
  }
  if (input.manifest.runtime.timeoutMs > MAX_TIMEOUT_MS) {
    return { ok: false, status: 'blocked', reason: 'timeout_too_large', details: { timeoutMs: input.manifest.runtime.timeoutMs, maxTimeoutMs: MAX_TIMEOUT_MS } }
  }
  if (input.manifest.capabilities.businessWrites) return { ok: false, status: 'blocked', reason: 'business_writes_forbidden' }
  if (input.manifest.capabilities.productionDatabase) return { ok: false, status: 'blocked', reason: 'production_database_forbidden' }
  if (input.manifest.capabilities.providerSecrets) return { ok: false, status: 'blocked', reason: 'provider_secrets_forbidden' }
  if (input.manifest.capabilities.userSessionTokens) return { ok: false, status: 'blocked', reason: 'session_tokens_forbidden' }
  if (input.manifest.capabilities.memoryWrites) return { ok: false, status: 'blocked', reason: 'memory_writes_forbidden' }
  if (input.manifest.network.mode !== 'disabled') return { ok: false, status: 'blocked', reason: 'network_must_be_disabled' }
  return { ok: true }
}
