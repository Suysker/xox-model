import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  SandboxToolRuntimeHandler,
  SandboxToolRuntimeRequest,
  SandboxToolRuntimeResponse,
} from '../backend.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeRequest(value: unknown): SandboxToolRuntimeRequest | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id : ''
  const toolName = typeof value.toolName === 'string' ? value.toolName : ''
  const args = isRecord(value.arguments) ? value.arguments : {}
  return id && toolName ? { id, toolName, arguments: args } : null
}

function errorResponse(input: {
  request: SandboxToolRuntimeRequest
  code: string
  message: string
  repairable?: boolean
}): SandboxToolRuntimeResponse {
  return {
    ok: false,
    toolName: input.request.toolName,
    status: 'failed',
    error: {
      code: input.code,
      message: input.message,
      repairable: input.repairable ?? true,
    },
  }
}

async function writeJsonAtomic(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value), 'utf8')
  await rename(tmp, path)
}

export async function prepareSandboxToolRpcDirectories(workDir: string) {
  const root = join(workDir, 'tool-rpc')
  const requestsDir = join(root, 'requests')
  const responsesDir = join(root, 'responses')
  await mkdir(requestsDir, { recursive: true })
  await mkdir(responsesDir, { recursive: true })
  return { root, requestsDir, responsesDir }
}

export function sandboxToolRpcPoller(input: {
  requestsDir: string
  responsesDir: string
  handler?: SandboxToolRuntimeHandler
}) {
  const processed = new Set<string>()
  return async () => {
    const names = await readdir(input.requestsDir).catch(() => [])
    for (const name of names) {
      if (!name.endsWith('.json') || processed.has(name)) continue
      const requestPath = join(input.requestsDir, name)
      const responsePath = join(input.responsesDir, name)
      let request: SandboxToolRuntimeRequest | null = null
      try {
        request = normalizeRequest(JSON.parse(await readFile(requestPath, 'utf8')))
      } catch {
        continue
      }
      processed.add(name)
      if (!request) {
        await writeJsonAtomic(responsePath, {
          ok: false,
          toolName: 'unknown',
          status: 'failed',
          error: {
            code: 'sandbox.tool_rpc_request_invalid',
            message: 'Sandbox tool RPC request was not a valid request object.',
              repairable: true,
            },
        })
        continue
      }
      const response = input.handler
        ? await input.handler(request).catch((error) => errorResponse({
            request,
            code: 'sandbox.tool_runtime_failed',
            message: error instanceof Error ? error.message : String(error),
          }))
        : errorResponse({
            request,
            code: 'sandbox.tool_runtime_unavailable',
            message: 'No Tool Runtime Gateway handler is attached to this sandbox session.',
          })
      await writeJsonAtomic(responsePath, response)
    }
  }
}
