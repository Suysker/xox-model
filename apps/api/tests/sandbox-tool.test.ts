import { describe, expect, it } from 'vitest'
import {
  SandboxBackendRegistry,
  SandboxBroker,
  projectAgenticSandboxObservationRead,
} from '@agentic-os/sandbox'
import {
  SANDBOX_CONFORMANCE_IMAGE_CATALOG,
  createSandboxConformanceBackend,
} from '@agentic-os/testing'
import { createProductDefaultModel, projectModel } from '@xox/domain'
import type { SandboxManifest } from '@agentic-os/sandbox'
import type { SandboxRunCodeInput } from '@xox/contracts'
import { AGENT_TOOL_CATALOG, AGENT_TOOL_REGISTRY, toolCallToRuntimeStep } from '../src/agent/tool-catalog.js'
import {
  inspectSandboxUploadedFile,
  normalizeSandboxArtifactKinds,
  normalizeSandboxFileKinds,
  sandboxInternalsForTests,
  sandboxFileAdapters,
} from '../src/agent/sandbox-service.js'

function bytes(value: string) {
  return Buffer.from(value, 'utf8')
}

function toolRuntimeHandlerFrom(output: unknown) {
  return async (request: { id: string; toolName: string; arguments: Record<string, unknown> }) => {
    if (request.toolName !== 'data_query_workspace') {
      return {
        ok: false,
        toolName: request.toolName,
        status: 'failed' as const,
        error: {
          code: 'test.tool_unavailable',
          message: `${request.toolName} is not available in this test handler.`,
          repairable: true,
        },
      }
    }
    return {
      ok: true,
      toolName: request.toolName,
      observationId: `test_observation_${request.id}`,
      status: 'completed' as const,
      output,
    }
  }
}

function sandboxTestBroker() {
  const backend = createSandboxConformanceBackend({ id: 'test-container' })
  const execute = backend.execute.bind(backend)
  backend.execute = async (session, input) => {
    const result = await execute(session, input)
    const structuredByPurpose: Record<string, unknown> = {
      '生成校验摘要': { profit: 20, rowCount: 1, secretVisible: false },
      '结构化结果文件校验': { profit: 20 },
      '同名工具 SDK 校验': { roi: 0.2, paybackMonthLabel: '4月' },
    }
    const structured = structuredByPurpose[input.input.purpose]
    if (structured !== undefined) {
      result.extraction = {
        extractionStatus: 'parsed',
        parsedOutput: {
          schemaVersion: 'agentic-os.sandbox.result.v1',
          structured,
        },
        summary: 'deterministic sandbox conformance result',
      }
      result.result = { summary: 'deterministic sandbox conformance result', structured }
    }
    if (input.input.purpose === '沙箱写入桥接校验') {
      const sandboxToolCalls = [{
        toolName: 'workspace_patch_config',
        arguments: {
          patches: [{ path: 'shareholders[0].investmentAmount', value: 123456, label: '股东 1 投资额' }],
        },
      }]
      result.extraction = {
        extractionStatus: 'parsed',
        parsedOutput: { schemaVersion: 'agentic-os.sandbox.result.v1', sandboxToolCalls },
        summary: 'deterministic sandbox tool call',
      }
      result.result = { summary: 'deterministic sandbox tool call', structured: { sandboxToolCalls } }
    }
    if (input.input.purpose === '空输出校验') {
      result.stdout = ''
      result.outputText = ''
      result.extraction = { extractionStatus: 'empty' }
      result.result = { summary: '' }
    }
    if (input.input.purpose === '普通文本输出校验') {
      result.extraction = { extractionStatus: 'text_only', summary: result.outputText.trim() }
      result.result = { summary: result.outputText.trim() }
    }
    if (input.input.purpose === '超时校验') {
      result.status = 'timeout'
      result.exitCode = null
      result.stdout = ''
      result.outputText = ''
      result.extraction = { extractionStatus: 'empty' }
      result.result = { summary: '' }
    }
    if (input.input.purpose === '运行时错误校验') {
      result.status = 'failed'
      result.exitCode = 1
      result.stderr = 'RuntimeError: boom'
      result.outputText = 'RuntimeError: boom'
      result.extraction = { extractionStatus: 'text_only', summary: 'RuntimeError: boom' }
      result.result = { summary: 'RuntimeError: boom' }
    }
    return result
  }
  return new SandboxBroker({
    registry: new SandboxBackendRegistry().register(backend, { default: true }),
    imageCatalog: SANDBOX_CONFORMANCE_IMAGE_CATALOG,
  })
}

describe('manifest-scoped sandbox tool', () => {
  it('registers sandbox_run_code as a provider-native sandbox capability tool', () => {
    expect(AGENT_TOOL_CATALOG.some((tool) => tool.function.name === 'sandbox_run_code')).toBe(true)
    expect(toolCallToRuntimeStep('sandbox_run_code', {
      purpose: '校验表格',
      language: 'python',
      code: 'print("ok")',
      dataRequest: { scope: 'uploaded_file', fileIds: ['file_1'], fileKinds: ['xlsx'] },
    })).toMatchObject({
      intent: 'sandbox.run_code',
      purpose: '校验表格',
    })

    expect(AGENT_TOOL_REGISTRY.find((tool) => tool.name === 'sandbox_run_code')).toMatchObject({
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

    expect(manifest.manifestId).toMatch(/^manifest_/)
    expect(manifest.nonce).toMatch(/^[0-9a-f]{32}$/)
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

  it('keeps forecast month bundles self-describing for direct sandbox calculations', () => {
    const config = createProductDefaultModel()
    const projection = projectModel(config)
    const baseScenario = projection.scenarios.find((scenario) => scenario.key === 'base') ?? projection.scenarios[0] ?? null

    const structured = sandboxInternalsForTests.buildProjectionStructuredBundle({
      scope: 'time_series_records',
      workspaceName: 'Sandbox Forecast',
      config,
      baseScenario,
      monthLabels: new Set<string>(),
      rowLimit: 500,
    }) as any

    expect(structured.scope).toBe('time_series_records')
    expect(structured.workspaceName).toBe('Sandbox Forecast')
    expect(structured.months.length).toBe(baseScenario?.months.length)
    expect(structured.rows).toBe(structured.months)
    expect(structured.months[0]).toMatchObject({
      plannedRevenue: structured.months[0].grossSales,
      plannedCost: structured.months[0].totalCost,
      plannedProfit: structured.months[0].monthlyProfit,
      cash: structured.months[0].cumulativeCash,
    })
    expect(structured.grossSales).toBeCloseTo(baseScenario?.grossSales ?? 0)
    expect(structured.totalCost).toBeCloseTo(baseScenario?.totalCost ?? 0)
    expect(structured.totalProfit).toBeCloseTo(baseScenario?.totalProfit ?? 0)
    expect(structured.netCashAfterInvestment).toBeCloseTo(baseScenario?.netCashAfterInvestment ?? 0)
    expect(structured.roi).toBeCloseTo(baseScenario?.roi ?? 0)
    expect(structured.paybackMonthLabel).toBe(baseScenario?.paybackMonthLabel ?? null)
    expect(structured.shareholders).toHaveLength(config.shareholders.length)
    const firstShareholder = config.shareholders[0]
    expect(firstShareholder).toBeDefined()
    expect(structured.firstShareholder).toMatchObject({
      index: 1,
      name: firstShareholder!.name,
      investmentAmount: firstShareholder!.investmentAmount,
      dividendRate: firstShareholder!.dividendRate,
    })
  })

  it('projects structured output from the injected Agentic OS sandbox conformance backend', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '生成校验摘要',
      language: 'python',
      code: [
        'import os',
        'import agentic_os_sandbox',
        'payload = agentic_os_sandbox.load_structured()',
        'rows = payload["rows"]',
        'agentic_os_sandbox.emit({',
        '  "summary": "计算完成",',
        '  "structured": {',
        '    "profit": payload["totalProfit"],',
        '    "rowCount": len(rows),',
        '    "secretVisible": "XOX_SANDBOX_SECRET_FOR_TEST" in os.environ',
        '  }',
        '})',
      ].join('\n'),
      dataRequest: { scope: 'summary_records' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_summary',
      scope: 'summary_records' as const,
      fields: ['grossSales', 'totalCost'],
      rows: [{ grossSales: 100, totalCost: 80 }],
      structured: { grossSales: 100, totalCost: 80, totalProfit: 20, rows: [{ grossSales: 100, totalCost: 80 }] },
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
    process.env.XOX_SANDBOX_SECRET_FOR_TEST = 'secret-value-that-must-not-leak'
    try {
      const result = await sandboxTestBroker().execute({
        manifest,
        toolInput: input,
        bundle,
        toolSdk: sandboxInternalsForTests.buildSandboxToolSdk(),
        toolRuntimeHandler: toolRuntimeHandlerFrom(bundle.structured),
      })
      expect(result.status).toBe('completed')
      expect(result.executionMode).toBe('executed')
      expect(result.exitCode).toBe(0)
      expect(result.backendId).toBe('test-container')
      expect(result.manifestScoped).toBe(true)
      expect(result.provenance).toMatchObject({
        manifestId: manifest.manifestId,
        bundleId: bundle.bundleId,
        bundleContentHash: bundle.contentHash,
        inputBundleMounted: true,
        inputBundleConsumed: true,
      })
      expect(result.extraction).toMatchObject({
        extractionStatus: 'parsed',
        parsedOutput: {
          schemaVersion: 'agentic-os.sandbox.result.v1',
          structured: {
            profit: 20,
            rowCount: 1,
            secretVisible: false,
          },
        },
      })
      expect(JSON.stringify(result)).not.toContain('secret-value-that-must-not-leak')
    } finally {
      delete process.env.XOX_SANDBOX_SECRET_FOR_TEST
    }
  })

  it('keeps structured result files usable without a private proof envelope', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '结构化结果文件校验',
      language: 'python',
      code: [
        'import agentic_os_sandbox',
        'agentic_os_sandbox.emit({',
        '  "schemaVersion": "agentic-os.sandbox.result.v1",',
        '  "summary": "完成结构化结果输出",',
        '  "structured": {"profit": 20}',
        '})',
      ].join('\n'),
      dataRequest: { scope: 'summary_records' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_unconsumed',
      scope: 'summary_records' as const,
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
    } as any, input, bundle, 'tool_call_unconsumed') as SandboxManifest
    const result = await sandboxTestBroker().execute({ manifest, toolInput: input, bundle })

    expect(result.status).toBe('completed')
    expect(result.executionMode).toBe('executed')
    expect(result.exitCode).toBe(0)
    expect(result.manifestScoped).toBe(true)
    expect(result.provenance).toMatchObject({
      manifestId: manifest.manifestId,
      bundleId: bundle.bundleId,
      bundleContentHash: bundle.contentHash,
      inputBundleMounted: true,
      inputBundleConsumed: true,
    })
    expect(result.extraction).toMatchObject({
      extractionStatus: 'parsed',
      parsedOutput: {
        schemaVersion: 'agentic-os.sandbox.result.v1',
        structured: { profit: 20 },
      },
    })
  })

  it('generates same-name sandbox SDK tools from the provider registry', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '同名工具 SDK 校验',
      language: 'python',
      code: [
        'import agentic_os_sandbox',
        'summary = agentic_os_sandbox.data_query_workspace(scope="summary_records", metrics=["roi", "payback"])',
        'agentic_os_sandbox.emit({',
        '  "summary": "SDK ok",',
        '  "structured": {',
        '    "roi": summary["roi"],',
        '    "paybackMonthLabel": summary["paybackMonthLabel"]',
        '  }',
        '})',
      ].join('\n'),
      dataRequest: { scope: 'summary_records' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_sdk',
      scope: 'summary_records' as const,
      fields: ['grossSales', 'totalCost', 'roi', 'paybackMonthLabel'],
      rows: [{ grossSales: 100, totalCost: 80, totalProfit: 20 }],
      structured: { scope: 'summary_records', grossSales: 100, totalCost: 80, totalProfit: 20, roi: 0.2, paybackMonthLabel: '4月', rows: [{ grossSales: 100 }] },
      rowCount: 1,
      redactions: 0,
      contentHash: 'hash',
    }
    const manifest = sandboxInternalsForTests.buildManifest({
      workspace: { id: 'workspace_1', owner_id: 'tenant_1' },
      user: { id: 'user_1' },
      threadId: 'thread_1',
      runId: 'run_1',
    } as any, input, bundle, 'tool_call_sdk') as SandboxManifest
    const result = await sandboxTestBroker().execute({
      manifest,
      toolInput: input,
      bundle,
      toolSdk: sandboxInternalsForTests.buildSandboxToolSdk(),
      toolRuntimeHandler: toolRuntimeHandlerFrom(bundle.structured),
    })

    expect(result.status).toBe('completed')
    expect(result.exitCode).toBe(0)
    expect(result.provenance.inputBundleConsumed).toBe(true)
    expect(result.extraction).toMatchObject({
      extractionStatus: 'parsed',
      parsedOutput: {
        schemaVersion: 'agentic-os.sandbox.result.v1',
        structured: {
          roi: 0.2,
          paybackMonthLabel: '4月',
        },
      },
    })
  })

  it('records sandbox business-tool requests as observations without granting execution authority', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '沙箱写入桥接校验',
      language: 'python',
      code: [
        'import agentic_os_sandbox',
        'request = agentic_os_sandbox.workspace_patch_config(patches=[',
        '  {"path": "shareholders[0].investmentAmount", "value": 123456, "label": "股东 1 投资额"}',
        '])',
        'agentic_os_sandbox.emit({"summary": "write requested", "structured": {"request": request}})',
      ].join('\n'),
      dataRequest: { scope: 'summary_records' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_write_sdk',
      scope: 'summary_records' as const,
      fields: ['grossSales'],
      rows: [{ grossSales: 100 }],
      structured: { scope: 'summary_records', grossSales: 100 },
      rowCount: 1,
      redactions: 0,
      contentHash: 'hash',
    }
    const manifest = sandboxInternalsForTests.buildManifest({
      workspace: { id: 'workspace_1', owner_id: 'tenant_1' },
      user: { id: 'user_1' },
      threadId: 'thread_1',
      runId: 'run_1',
    } as any, input, bundle, 'tool_call_write_sdk') as SandboxManifest
    const result = await sandboxTestBroker().execute({
      manifest,
      toolInput: input,
      bundle,
      toolSdk: sandboxInternalsForTests.buildSandboxToolSdk(),
    })

    expect(result.status).toBe('completed')
    expect(result.exitCode).toBe(0)
    expect(result.artifacts.map((artifact) => artifact.name)).not.toContain('tool_calls.jsonl')
    expect(result.extraction.parsedOutput).toMatchObject({
      schemaVersion: 'agentic-os.sandbox.result.v1',
      sandboxToolCalls: [
        {
          toolName: 'workspace_patch_config',
          arguments: {
            patches: [
              { path: 'shareholders[0].investmentAmount', value: 123456, label: '股东 1 投资额' },
            ],
          },
        },
      ],
    })
  })

  it('returns ordinary stdout text as a model-readable sandbox observation', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '普通文本输出校验',
      language: 'python',
      code: 'print("ROI after loan cost is 12.5%")',
      dataRequest: { scope: 'summary_records' },
      expectedOutputs: ['markdown'],
    }
    const bundle = {
      bundleId: 'bundle_text',
      scope: 'summary_records' as const,
      fields: ['totalProfit'],
      rows: [{ totalProfit: 100 }],
      structured: { totalProfit: 100 },
      rowCount: 1,
      redactions: 0,
      contentHash: 'hash',
    }
    const manifest = sandboxInternalsForTests.buildManifest({
      workspace: { id: 'workspace_1', owner_id: 'tenant_1' },
      user: { id: 'user_1' },
      threadId: 'thread_1',
      runId: 'run_1',
    } as any, input, bundle, 'tool_call_text') as SandboxManifest
    const result = await sandboxTestBroker().execute({ manifest, toolInput: input, bundle })

    expect(result.status).toBe('completed')
    expect(result.executionMode).toBe('executed')
    expect(result.exitCode).toBe(0)
    expect(result.outputText).toContain('ROI after loan cost is 12.5%')
    expect(result.extraction).toMatchObject({
      extractionStatus: 'text_only',
      summary: expect.stringContaining('ROI after loan cost'),
    })
    expect(result.result.summary).toContain('ROI after loan cost')
  })

  it('keeps display preview separate from full sandbox output', () => {
    const longOutput = JSON.stringify({
      realROI_noInterest_percent: 12.3456,
      loanAdjustedROI_percent: 8.7654,
      notes: 'x'.repeat(900),
    })
    const preview = JSON.parse(projectAgenticSandboxObservationRead({
      status: 'completed',
      executionMode: 'executed',
      backendId: 'test-container',
      exitCode: 0,
      stdout: '',
      stderr: '',
      purpose: '长输出预览校验',
      dataBundleSummary: { scope: 'summary_records', fields: ['totalProfit'], rows: 1, redactions: 0 },
      manifest: {
        manifestId: 'manifest_long_output',
        nonce: 'nonce_long_output',
        inputBundle: { bundleId: 'bundle_long_output', contentHash: 'bundle_hash' },
        network: { mode: 'disabled' },
        capabilities: { businessWrites: false },
      },
      extraction: {
        extractionStatus: 'parsed',
        parsedOutput: {
          realROI_noInterest_percent: 12.3456,
          loanAdjustedROI_percent: 8.7654,
        },
      },
      outputText: longOutput,
      result: { summary: longOutput },
      artifacts: [],
      provenance: { codeHash: 'code_hash' },
      sandboxRunId: 'sandbox_long_output',
    } as any).displayPreview)

    expect(preview.outputText).toMatchObject({
      truncatedForDisplay: true,
      sha256: expect.any(String),
      bytes: Buffer.byteLength(longOutput, 'utf8'),
    })
    expect(preview.outputText.preview).toContain('realROI_noInterest_percent')
    expect(preview.outputText.preview.length).toBeLessThan(longOutput.length)
    expect(preview.extraction).toMatchObject({
      status: 'parsed',
      parsedOutput: {
        realROI_noInterest_percent: 12.3456,
        loanAdjustedROI_percent: 8.7654,
      },
    })
    expect(preview.rawOutputRef).toMatchObject({
      storage: 'sandbox_observation',
      id: 'sandbox_long_output',
      truncatedForDisplay: true,
      truncatedForModel: false,
    })
  })

  it('marks completed empty output as an empty extraction rather than fabricated success', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '空输出校验',
      language: 'python',
      code: 'pass',
      dataRequest: { scope: 'summary_records' },
      expectedOutputs: ['markdown'],
    }
    const bundle = {
      bundleId: 'bundle_empty',
      scope: 'summary_records' as const,
      fields: ['totalProfit'],
      rows: [{ totalProfit: 100 }],
      structured: { totalProfit: 100 },
      rowCount: 1,
      redactions: 0,
      contentHash: 'hash',
    }
    const manifest = sandboxInternalsForTests.buildManifest({
      workspace: { id: 'workspace_1', owner_id: 'tenant_1' },
      user: { id: 'user_1' },
      threadId: 'thread_1',
      runId: 'run_1',
    } as any, input, bundle, 'tool_call_empty') as SandboxManifest
    const result = await sandboxTestBroker().execute({ manifest, toolInput: input, bundle })

    expect(result.status).toBe('completed')
    expect(result.executionMode).toBe('executed')
    expect(result.exitCode).toBe(0)
    expect(result.outputText).toBe('')
    expect(result.extraction.extractionStatus).toBe('empty')
  })

  it('preserves an injected executor timeout instead of fabricating sandbox success', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '超时校验',
      language: 'python',
      code: 'import time\ntime.sleep(2)',
      dataRequest: { scope: 'summary_records' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_timeout',
      scope: 'summary_records' as const,
      fields: ['grossSales'],
      rows: [{ grossSales: 100 }],
      structured: { grossSales: 100 },
      rowCount: 1,
      redactions: 0,
      contentHash: 'hash',
    }
    const manifest = sandboxInternalsForTests.buildManifest({
      workspace: { id: 'workspace_1', owner_id: 'tenant_1' },
      user: { id: 'user_1' },
      threadId: 'thread_1',
      runId: 'run_1',
    } as any, input, bundle, 'tool_call_timeout') as SandboxManifest
    manifest.runtime.timeoutMs = 50
    manifest.runtime.computeMs = 25
    const result = await sandboxTestBroker().execute({ manifest, toolInput: input, bundle })

    expect(result.status).toBe('timeout')
    expect(result.executionMode).toBe('executed')
    expect(result.exitCode).toBeNull()
    expect(result.extraction.extractionStatus).toBe('empty')
  })

  it('reports runtime errors with real exit status instead of fabricating sandbox success', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '运行时错误校验',
      language: 'python',
      code: 'raise RuntimeError("boom")',
      dataRequest: { scope: 'summary_records' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_failure',
      scope: 'summary_records' as const,
      fields: ['grossSales'],
      rows: [{ grossSales: 100 }],
      structured: { grossSales: 100 },
      rowCount: 1,
      redactions: 0,
      contentHash: 'hash',
    }
    const manifest = sandboxInternalsForTests.buildManifest({
      workspace: { id: 'workspace_1', owner_id: 'tenant_1' },
      user: { id: 'user_1' },
      threadId: 'thread_1',
      runId: 'run_1',
    } as any, input, bundle, 'tool_call_failure') as SandboxManifest
    const result = await sandboxTestBroker().execute({ manifest, toolInput: input, bundle })

    expect(result.status).toBe('failed')
    expect(result.executionMode).toBe('executed')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('RuntimeError')
    expect(result.outputText).toContain('RuntimeError')
    expect(result.extraction.extractionStatus).toBe('text_only')
  })

  it('blocks invalid sandbox policy before execution without producing executed evidence', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '策略阻断校验',
      language: 'python',
      code: 'print("should not run")',
      dataRequest: { scope: 'summary_records' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_blocked',
      scope: 'summary_records' as const,
      fields: ['grossSales'],
      rows: [{ grossSales: 100 }],
      structured: { grossSales: 100 },
      rowCount: 1,
      redactions: 0,
      contentHash: 'hash',
    }
    const manifest = sandboxInternalsForTests.buildManifest({
      workspace: { id: 'workspace_1', owner_id: 'tenant_1' },
      user: { id: 'user_1' },
      threadId: 'thread_1',
      runId: 'run_1',
    } as any, input, bundle, 'tool_call_blocked') as SandboxManifest
    ;(manifest.capabilities as any).businessWrites = true
    const result = await sandboxTestBroker().execute({ manifest, toolInput: input, bundle })

    expect(result.status).toBe('blocked')
    expect(result.executionMode).toBe('not_executed')
    expect(result.exitCode).toBeNull()
    expect(result.result.structured).toMatchObject({
      reason: 'business_writes_forbidden',
    })
    expect(result.provenance.inputBundleMounted).toBe(false)
  })
})
