import { spawn } from 'node:child_process'
import { redactSecretLikeContent } from '@agentic-os/core'
import type { SandboxExecutionResult } from '../backend.js'

export type SandboxProcessRunResult = {
  status: SandboxExecutionResult['status']
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
}

function cappedAppend(current: string, chunk: Buffer, limitBytes: number) {
  if (Buffer.byteLength(current, 'utf8') >= limitBytes) return current
  const remaining = Math.max(0, limitBytes - Buffer.byteLength(current, 'utf8'))
  return current + chunk.toString('utf8').slice(0, remaining)
}

export function runSandboxProcess(input: {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  stdoutLimitBytes: number
  stderrLimitBytes: number
  poll?: () => Promise<void>
  pollIntervalMs?: number
}): Promise<SandboxProcessRunResult> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let polling = false
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
    })
    const poll = () => {
      if (!input.poll || polling || settled) return
      polling = true
      input.poll()
        .catch((error) => {
          stderr = cappedAppend(
            stderr,
            Buffer.from(`${stderr ? '\n' : ''}sandbox_rpc_poll_failed: ${error instanceof Error ? error.message : String(error)}`),
            input.stderrLimitBytes,
          )
        })
        .finally(() => {
          polling = false
        })
    }
    const pollTimer = input.poll
      ? setInterval(poll, Math.max(10, input.pollIntervalMs ?? 25))
      : null
    const finish = (result: Omit<SandboxProcessRunResult, 'durationMs'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (pollTimer) clearInterval(pollTimer)
      resolve({
        ...result,
        stdout: redactSecretLikeContent(result.stdout),
        stderr: redactSecretLikeContent(result.stderr),
        durationMs: Math.max(1, Date.now() - startedAt),
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, input.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = cappedAppend(stdout, chunk, input.stdoutLimitBytes)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = cappedAppend(stderr, chunk, input.stderrLimitBytes)
    })
    child.on('error', (error) => {
      finish({
        status: 'failed',
        exitCode: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`,
      })
    })
    child.on('close', (code) => {
      if (timedOut) {
        finish({ status: 'timeout', exitCode: null, stdout, stderr })
        return
      }
      finish({
        status: code === 0 ? 'completed' : 'failed',
        exitCode: code,
        stdout,
        stderr,
      })
    })
  })
}
