import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

function hashJson(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function scrubbedChildEnv(workDir: string, inputJsonPath: string, outputDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    XOX_SANDBOX_INPUT_JSON: inputJsonPath,
    XOX_SANDBOX_OUTPUT_DIR: outputDir,
    XOX_SANDBOX_WORKDIR: workDir,
  }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

function commandForLanguage(language: SandboxManifest['runtime']['language']) {
  if (language === 'javascript') return { command: process.execPath, args: ['script.js'], scriptName: 'script.js' }
  return {
    command: process.env.XOX_SANDBOX_PYTHON_BIN || process.env.PYTHON || 'python',
    args: ['script.py'],
    scriptName: 'script.py',
  }
}

export class LocalScriptSandboxBackend implements SandboxBackend {
  id = 'local-script'
  supportedLanguages = ['python', 'javascript'] as const

  async create(manifest: SandboxManifest): Promise<SandboxSessionRef> {
    const workDir = await mkdtemp(join(tmpdir(), 'xox-sandbox-'))
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

    const command = commandForLanguage(session.manifest.runtime.language)
    await writeFile(join(workDir, command.scriptName), input.input.code, 'utf8')
    const processResult = await runSandboxProcess({
      command: command.command,
      args: command.args,
      cwd: workDir,
      env: scrubbedChildEnv(workDir, inputJsonPath, outputDir),
      timeoutMs: session.manifest.runtime.timeoutMs,
      stdoutLimitBytes: session.manifest.runtime.stdoutLimitBytes,
      stderrLimitBytes: session.manifest.runtime.stderrLimitBytes,
    })
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
      provenance: {
        manifestId: session.manifest.manifestId,
        bundleId: input.bundle.bundleId,
        bundleContentHash: input.bundle.contentHash,
        inputBundleMounted: true,
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
      ...(processResult.status === 'failed' ? { errorMessage: processResult.stderr.slice(0, 500) || 'sandbox_process_failed' } : {}),
      ...(processResult.status === 'timeout' ? { errorMessage: 'sandbox_process_timeout' } : {}),
    }
  }

  async collect(_session: SandboxSessionRef) {
    return []
  }

  async destroy(session: SandboxSessionRef): Promise<void> {
    if (session.workDir) await rm(session.workDir, { recursive: true, force: true })
  }
}
