import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxManifest } from '@xox/contracts'
import {
  type SandboxBackend,
  type SandboxExecuteInput,
  type SandboxExecutionResult,
  type SandboxSessionRef,
} from '../backend.js'
import { parseSandboxOutput } from '../result-parser.js'
import { runSandboxProcess } from './process-runner.js'
import { stageSandboxIo } from './staged-sandbox-io.js'
import { prepareSandboxToolRpcDirectories, sandboxToolRpcPoller } from './tool-rpc-files.js'

function hashJson(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function dockerHostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

function dockerSpec(language: SandboxManifest['runtime']['language']) {
  if (language === 'javascript') {
    return {
      image: process.env.XOX_SANDBOX_DOCKER_NODE_IMAGE || 'node:22-alpine',
      command: ['node', 'script.js'],
      scriptName: 'script.js',
    }
  }
  return {
    image: process.env.XOX_SANDBOX_DOCKER_PYTHON_IMAGE || 'python:3.12-alpine',
    command: ['python', 'script.py'],
    scriptName: 'script.py',
  }
}

async function inputBundleConsumed(outputDir: string) {
  const text = await readFile(join(outputDir, 'manifest_consumed.json'), 'utf8').catch(() => null)
  return Boolean(text)
}

export class DockerSandboxBackend implements SandboxBackend {
  id = 'docker'
  supportedLanguages = ['python', 'javascript'] as const

  async create(manifest: SandboxManifest): Promise<SandboxSessionRef> {
    const workDir = await mkdtemp(join(tmpdir(), 'xox-sandbox-docker-'))
    await mkdir(join(workDir, 'input'), { recursive: true })
    await mkdir(join(workDir, 'output'), { recursive: true })
    return {
      id: `sandbox_${shortHash(`${manifest.identity.runId}:${manifest.identity.toolCallId}:${workDir}`)}`,
      manifest,
      workDir,
    }
  }

  async execute(session: SandboxSessionRef, input: SandboxExecuteInput): Promise<SandboxExecutionResult> {
    const workDir = session.workDir
    if (!workDir) throw new Error('sandbox session has no workDir')
    const outputDir = join(workDir, 'output')
    const inputJsonPath = join(workDir, 'input.json')
    const mountedInputJsonPath = join(workDir, 'input', 'input.json')
    await stageSandboxIo({
      workDir,
      inputJsonPath,
      mountedInputJsonPath,
      manifest: session.manifest,
      bundle: input.bundle,
      ...(input.toolSdk ? { toolSdk: input.toolSdk } : {}),
    })

    const handler = input.toolRuntimeHandler
    let rpc: Awaited<ReturnType<typeof prepareSandboxToolRpcDirectories>> | null = null
    let poll: (() => Promise<void>) | undefined
    if (handler) {
      rpc = await prepareSandboxToolRpcDirectories(workDir)
      poll = sandboxToolRpcPoller({
        requestsDir: rpc.requestsDir,
        responsesDir: rpc.responsesDir,
        handler,
      })
    }
    const spec = dockerSpec(session.manifest.runtime.language)
    await writeFile(join(workDir, spec.scriptName), input.input.code, 'utf8')
    const dockerArgs = [
      'run',
      '--rm',
      '--network',
      'none',
      '--memory',
      `${session.manifest.runtime.memoryMb}m`,
      '--cpus',
      '1',
      '--pids-limit',
      String(Math.max(16, session.manifest.runtime.processLimit)),
      '-v',
      `${workDir}:/workspace`,
      '-w',
      '/workspace',
      '-e',
      'XOX_SANDBOX_INPUT_JSON=/workspace/input.json',
      '-e',
      'XOX_SANDBOX_OUTPUT_DIR=/workspace/output',
      ...(rpc ? ['-e', 'XOX_SANDBOX_TOOL_RPC_DIR=/workspace/tool-rpc', '-e', 'XOX_SANDBOX_TOOL_RPC_TIMEOUT_SECONDS=8'] : []),
      '-e',
      'PYTHONIOENCODING=utf-8',
      '-e',
      'PYTHONUTF8=1',
      spec.image,
      ...spec.command,
    ]
    const processResult = await runSandboxProcess({
      command: process.env.XOX_SANDBOX_DOCKER_BIN || 'docker',
      args: dockerArgs,
      cwd: workDir,
      env: dockerHostEnv(),
      timeoutMs: session.manifest.runtime.timeoutMs,
      stdoutLimitBytes: session.manifest.runtime.stdoutLimitBytes,
      stderrLimitBytes: session.manifest.runtime.stderrLimitBytes,
      ...(poll ? { poll } : {}),
    })
    if (poll) await poll()
    const parsed = await parseSandboxOutput({
      outputDir,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      status: processResult.status,
      purpose: input.input.purpose,
      allowedKinds: session.manifest.outputPolicy.allowedArtifactKinds,
      maxArtifactCount: session.manifest.outputPolicy.maxArtifactCount,
      maxArtifactBytes: session.manifest.outputPolicy.maxArtifactBytes,
      sessionId: session.id,
    })
    const consumed = await inputBundleConsumed(outputDir)
    return {
      status: processResult.status,
      executionMode: 'executed',
      backendId: this.id,
      sessionId: session.id,
      exitCode: processResult.exitCode,
      durationMs: processResult.durationMs,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      outputText: parsed.outputText,
      extraction: parsed.extraction,
      artifacts: parsed.artifacts,
      result: parsed.result,
      resourceUsage: {
        wallTimeMs: processResult.durationMs,
        stdoutBytes: Buffer.byteLength(processResult.stdout, 'utf8'),
        stderrBytes: Buffer.byteLength(processResult.stderr, 'utf8'),
      },
      manifestHash: hashJson(session.manifest),
      inputEvidenceIds: [`bundle:${input.bundle.bundleId}`, `content:${input.bundle.contentHash}`],
      manifestScoped: true,
      inputBundleConsumed: consumed,
      provenance: {
        manifestId: session.manifest.manifestId,
        bundleId: input.bundle.bundleId,
        bundleContentHash: input.bundle.contentHash,
        inputBundleMounted: true,
        inputBundleConsumed: consumed,
        codeHash: hashText(input.input.code),
        stdoutHash: hashText(processResult.stdout),
        stderrHash: hashText(processResult.stderr),
        outputArtifactHashes: parsed.artifacts.map((artifact) => hashText(`${artifact.name}:${artifact.sizeBytes}:${artifact.artifactId}`)),
        capabilityProfile: session.manifest.capabilities,
        resourceUsage: {
          stdoutBytes: Buffer.byteLength(processResult.stdout, 'utf8'),
          stderrBytes: Buffer.byteLength(processResult.stderr, 'utf8'),
        },
      },
      ...(processResult.status === 'failed' ? { errorMessage: processResult.stderr.slice(0, 500) || 'docker_sandbox_failed' } : {}),
      ...(processResult.status === 'timeout' ? { errorMessage: 'docker_sandbox_timeout' } : {}),
    }
  }

  async collect(_session: SandboxSessionRef) {
    return []
  }

  async destroy(session: SandboxSessionRef): Promise<void> {
    if (session.workDir) await rm(session.workDir, { recursive: true, force: true })
  }
}
