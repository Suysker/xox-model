import type { SandboxManifest } from '@xox/contracts'
import type { SandboxBackend } from './backend.js'
import { LocalScriptSandboxBackend } from './backends/local-script-backend.js'
import { DockerSandboxBackend } from './backends/docker-backend.js'

export class SandboxBackendRegistry {
  private readonly backends = new Map<string, SandboxBackend>()

  register(backend: SandboxBackend) {
    this.backends.set(backend.id, backend)
    return this
  }

  get(id: string) {
    return this.backends.get(id) ?? null
  }

  resolve(input: { preferredBackendId?: string; manifest: SandboxManifest }): SandboxBackend {
    if (input.preferredBackendId) {
      const backend = this.get(input.preferredBackendId)
      if (!backend) throw new Error(`Sandbox backend is not registered: ${input.preferredBackendId}`)
      if (!backend.supportedLanguages.includes(input.manifest.runtime.language)) {
        throw new Error(`Sandbox backend ${backend.id} does not support ${input.manifest.runtime.language}`)
      }
      return backend
    }
    const backend = [...this.backends.values()].find((candidate) =>
      candidate.supportedLanguages.includes(input.manifest.runtime.language))
    if (!backend) throw new Error(`No real sandbox backend supports ${input.manifest.runtime.language}`)
    return backend
  }
}

export function createDefaultSandboxBackendRegistry() {
  return new SandboxBackendRegistry()
    .register(new LocalScriptSandboxBackend())
    .register(new DockerSandboxBackend())
}
