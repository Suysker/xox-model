import { describe, expect, it } from 'vitest'
import type { SandboxManifest, SandboxRunCodeInput } from '@xox/contracts'
import { buildRuntimeToolCatalogProjection } from '../src/agent/tool-gateway.js'
import { AGENT_TOOL_CATALOG, toolCallToPlannerStep } from '../src/agent/tool-catalog.js'
import {
  inspectSandboxUploadedFile,
  normalizeSandboxArtifactKinds,
  normalizeSandboxFileKinds,
  sandboxFileAdapters,
} from '../src/agent/sandbox-file-adapters.js'
import { sandboxInternalsForTests } from '../src/agent/sandbox-service.js'

function bytes(value: string) {
  return Buffer.from(value, 'utf8')
}

describe('manifest-scoped sandbox tool', () => {
  it('registers sandbox_run_code as a provider-native sandbox capability tool', () => {
    expect(AGENT_TOOL_CATALOG.some((tool) => tool.function.name === 'sandbox_run_code')).toBe(true)
    expect(toolCallToPlannerStep('sandbox_run_code', {
      purpose: '校验表格',
      language: 'python',
      code: 'print("ok")',
      dataRequest: { scope: 'uploaded_file', fileIds: ['file_1'], fileKinds: ['xlsx'] },
    })).toMatchObject({
      intent: 'sandbox.run_code',
      purpose: '校验表格',
    })

    const projection = buildRuntimeToolCatalogProjection({ selectedCapabilities: ['sandbox'] })
    expect(projection.toolNames).toContain('sandbox_run_code')
    expect(projection.toolCapabilities.find((tool) => tool.name === 'sandbox_run_code')).toMatchObject({
      capability: 'sandbox',
      riskLevel: 'read',
      confirmationMode: 'never',
    })
  })

  it('normalizes the common file and artifact formats from ADR 0016', () => {
    expect(normalizeSandboxFileKinds([
      'xlsx',
      '.xls',
      'csv',
      'json',
      'png',
      'jpg',
      'jpeg',
      'html',
      'txt',
      'md',
      'pdf',
      'docx',
      'doc',
      'unknown',
    ])).toEqual(['xlsx', 'xls', 'csv', 'json', 'png', 'jpg', 'jpeg', 'html', 'txt', 'md', 'pdf', 'docx', 'doc'])

    expect(normalizeSandboxArtifactKinds(['xlsx', 'doc', 'docx', 'pdf', 'png', 'json'])).toEqual(['xlsx', 'docx', 'pdf', 'png', 'json'])
    expect(sandboxFileAdapters().map((adapter) => adapter.kind)).toEqual(expect.arrayContaining([
      'xlsx',
      'xls',
      'csv',
      'json',
      'html',
      'png',
      'jpg',
      'jpeg',
      'pdf',
      'docx',
      'doc',
    ]))
  })

  it('accepts safe text-like files and produces normalized previews', () => {
    const csv = inspectSandboxUploadedFile({
      name: 'members.csv',
      mimeType: 'text/csv',
      sizeBytes: 18,
      bytes: bytes('name,amount\nA,100\n'),
    })
    expect(csv.status).toBe('accepted')
    expect(csv.normalized.rows).toEqual([['name', 'amount'], ['A', '100']])

    const json = inspectSandboxUploadedFile({
      name: 'payload.json',
      mimeType: 'application/json',
      sizeBytes: 12,
      bytes: bytes('{"ok":true}'),
    })
    expect(json.status).toBe('accepted')
    expect(json.normalized.textPreview).toContain('"ok": true')
  })

  it('blocks unsafe active content and mismatched file identity', () => {
    expect(inspectSandboxUploadedFile({
      name: 'x.html',
      mimeType: 'text/html',
      sizeBytes: 40,
      bytes: bytes('<script>alert(1)</script><div>ok</div>'),
    })).toMatchObject({ status: 'blocked', reason: 'html_active_content' })

    expect(inspectSandboxUploadedFile({
      name: 'x.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 40,
      bytes: bytes('%PDF-1.7\n/JavaScript true'),
    })).toMatchObject({ status: 'blocked', reason: 'pdf_active_content' })

    expect(inspectSandboxUploadedFile({
      name: 'x.png',
      mimeType: 'image/png',
      sizeBytes: 8,
      bytes: bytes('not-png'),
    })).toMatchObject({ status: 'blocked', reason: 'magic_mismatch' })
  })

  it('keeps the server-owned manifest business-readonly regardless of requested outputs', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '对当前数据做临时校验',
      language: 'python',
      code: 'print("ok")',
      dataRequest: {
        scope: 'uploaded_file',
        fileIds: ['file_a'],
        fileKinds: ['xlsx'],
      },
      expectedOutputs: ['spreadsheet', 'document', 'image'],
    }
    const bundle = {
      bundleId: 'bundle_test',
      scope: 'uploaded_file' as const,
      fields: ['name', 'amount'],
      structured: { files: [{ fileId: 'file_a', kind: 'xlsx' }] },
      fileCount: 1,
      fileKinds: ['xlsx' as const],
      redactions: 0,
      contentHash: 'hash',
    }
    const manifest = sandboxInternalsForTests.buildManifest({
      workspace: { id: 'workspace_1', owner_id: 'tenant_1' },
      user: { id: 'user_1' },
      threadId: 'thread_1',
      runId: 'run_1',
    } as any, input, bundle, 'tool_call_1') as SandboxManifest

    expect(manifest.inputBundle.readonly).toBe(true)
    expect(manifest.network).toEqual({ mode: 'disabled', allowlist: [] })
    expect(manifest.capabilities).toMatchObject({
      shell: false,
      packageInstall: false,
      internalApi: false,
      productionDatabase: false,
      providerSecrets: false,
      userSessionTokens: false,
      businessWrites: false,
      memoryWrites: false,
      accountActions: false,
    })
    expect(manifest.outputPolicy.allowedArtifactKinds).toEqual(expect.arrayContaining(['xlsx', 'pdf', 'docx', 'png']))
  })

  it('fake backend returns observation data without executing code in the API process', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '生成校验摘要',
      language: 'python',
      code: 'open("/etc/passwd").read()',
      dataRequest: { scope: 'workspace_summary' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_summary',
      scope: 'workspace_summary' as const,
      fields: ['grossSales', 'totalCost'],
      rows: [{ grossSales: 100, totalCost: 80 }],
      structured: { grossSales: 100, totalCost: 80, totalProfit: 20 },
      rowCount: 1,
      redactions: 0,
      contentHash: 'hash',
    }
    const manifest = sandboxInternalsForTests.buildManifest({
      workspace: { id: 'workspace_1', owner_id: 'tenant_1' },
      user: { id: 'user_1' },
      threadId: 'thread_1',
      runId: 'run_1',
    } as any, input, bundle, 'tool_call_1') as SandboxManifest
    const backend = new sandboxInternalsForTests.FakeDeterministicSandboxBackend()
    const session = await backend.create(manifest)
    const result = await backend.execute(session, { input, bundle })

    expect(result.status).toBe('completed')
    expect(result.result.structured).toMatchObject({
      executionMode: 'fake_deterministic',
      manifestScoped: true,
      businessReadonly: true,
      dataScope: 'workspace_summary',
    })
  })
})
