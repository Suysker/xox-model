import { describe, expect, it } from 'vitest'
import { createProductDefaultModel, projectModel } from '@xox/domain'
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
import { SandboxBroker } from '../src/agent/sandbox/sandbox-broker.js'

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
      scope: 'forecast_months',
      workspaceName: 'Sandbox Forecast',
      config,
      baseScenario,
      monthLabels: new Set<string>(),
      rowLimit: 500,
    }) as any

    expect(structured.scope).toBe('forecast_months')
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

  it('runs code through the real local sandbox backend and parses structured output', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '生成校验摘要',
      language: 'python',
      code: [
        'import os',
        'import xox_sandbox',
        'payload = xox_sandbox.data_query_workspace(scope="workspace_summary", metrics=["roi"])',
        'rows = payload["rows"]',
        'xox_sandbox.emit({',
        '  "summary": "计算完成",',
        '  "structured": {',
        '    "profit": payload["totalProfit"],',
        '    "rowCount": len(rows),',
        '    "secretVisible": "XOX_SANDBOX_SECRET_FOR_TEST" in os.environ',
        '  }',
        '})',
      ].join('\n'),
      dataRequest: { scope: 'workspace_summary' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_summary',
      scope: 'workspace_summary' as const,
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
      const result = await new SandboxBroker().execute({
        manifest,
        toolInput: input,
        bundle,
        toolSdk: sandboxInternalsForTests.buildSandboxToolSdk(),
      })
      expect(result.status).toBe('completed')
      expect(result.executionMode).toBe('executed')
      expect(result.exitCode).toBe(0)
      expect(result.backendId).toBe('local-script')
      expect(result.manifestScoped).toBe(true)
      expect(result.provenance).toMatchObject({
        manifestId: manifest.manifestId,
        bundleId: bundle.bundleId,
        bundleContentHash: bundle.contentHash,
        inputBundleMounted: true,
      })
      expect(result.extraction).toMatchObject({
        extractionStatus: 'parsed',
        parsedOutput: {
          schemaVersion: 'xox.sandbox.result.v1',
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
        'import json, os, pathlib',
        'result = {',
        '  "schemaVersion": "xox.sandbox.result.v1",',
        '  "summary": "完成结构化结果输出",',
        '  "structured": {"profit": 20}',
        '}',
        'pathlib.Path(os.environ["XOX_SANDBOX_OUTPUT_DIR"], "result.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")',
      ].join('\n'),
      dataRequest: { scope: 'workspace_summary' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_unconsumed',
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
    } as any, input, bundle, 'tool_call_unconsumed') as SandboxManifest
    const result = await new SandboxBroker().execute({ manifest, toolInput: input, bundle })

    expect(result.status).toBe('completed')
    expect(result.executionMode).toBe('executed')
    expect(result.exitCode).toBe(0)
    expect(result.manifestScoped).toBe(true)
    expect(result.provenance).toMatchObject({
      manifestId: manifest.manifestId,
      bundleId: bundle.bundleId,
      bundleContentHash: bundle.contentHash,
      inputBundleMounted: true,
    })
    expect(result.extraction).toMatchObject({
      extractionStatus: 'parsed',
      parsedOutput: {
        schemaVersion: 'xox.sandbox.result.v1',
        structured: { profit: 20 },
      },
    })
  })

  it('generates same-name sandbox SDK tools from the provider registry and scopes rg to tool docs', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '同名工具 SDK 校验',
      language: 'python',
      code: [
        'import xox_sandbox',
        'summary = xox_sandbox.data_query_workspace(scope="workspace_summary", metrics=["roi", "payback"])',
        'matches = xox_sandbox.rg(pattern="data_query_workspace", paths=["tools/agent-tool-manifest.md"], max_matches=3)',
        'xox_sandbox.emit({',
        '  "summary": "SDK ok",',
        '  "structured": {',
        '    "roi": summary["roi"],',
        '    "paybackMonthLabel": summary["paybackMonthLabel"],',
        '    "matchCount": len(matches["matches"])',
        '  }',
        '})',
      ].join('\n'),
      dataRequest: { scope: 'workspace_summary' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_sdk',
      scope: 'workspace_summary' as const,
      fields: ['grossSales', 'totalCost', 'roi', 'paybackMonthLabel'],
      rows: [{ grossSales: 100, totalCost: 80, totalProfit: 20 }],
      structured: { scope: 'workspace_summary', grossSales: 100, totalCost: 80, totalProfit: 20, roi: 0.2, paybackMonthLabel: '4月', rows: [{ grossSales: 100 }] },
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
    const result = await new SandboxBroker().execute({
      manifest,
      toolInput: input,
      bundle,
      toolSdk: sandboxInternalsForTests.buildSandboxToolSdk(),
    })

    expect(result.status).toBe('completed')
    expect(result.exitCode).toBe(0)
    expect(result.extraction).toMatchObject({
      extractionStatus: 'parsed',
      parsedOutput: {
        schemaVersion: 'xox.sandbox.result.v1',
        structured: {
          roi: 0.2,
          paybackMonthLabel: '4月',
          matchCount: expect.any(Number),
        },
      },
    })
    expect((result.extraction.parsedOutput as any).structured.matchCount).toBeGreaterThan(0)
  })

  it('records sandbox write-capable SDK calls for aggregate Tool Runtime approval', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '沙箱写入桥接校验',
      language: 'python',
      code: [
        'import xox_sandbox',
        'request = xox_sandbox.workspace_patch_config(patches=[',
        '  {"path": "shareholders[0].investmentAmount", "value": 123456, "label": "股东 1 投资额"}',
        '])',
        'xox_sandbox.emit({"summary": "write requested", "structured": {"request": request}})',
      ].join('\n'),
      dataRequest: { scope: 'workspace_summary' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_write_sdk',
      scope: 'workspace_summary' as const,
      fields: ['grossSales'],
      rows: [{ grossSales: 100 }],
      structured: { scope: 'workspace_summary', grossSales: 100 },
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
    const result = await new SandboxBroker().execute({
      manifest,
      toolInput: input,
      bundle,
      toolSdk: sandboxInternalsForTests.buildSandboxToolSdk(),
    })

    expect(result.status).toBe('completed')
    expect(result.exitCode).toBe(0)
    expect(result.artifacts.map((artifact) => artifact.name)).not.toContain('tool_calls.jsonl')
    expect(result.extraction.parsedOutput).toMatchObject({
      schemaVersion: 'xox.sandbox.result.v1',
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
      dataRequest: { scope: 'workspace_summary' },
      expectedOutputs: ['markdown'],
    }
    const bundle = {
      bundleId: 'bundle_text',
      scope: 'workspace_summary' as const,
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
    const result = await new SandboxBroker().execute({ manifest, toolInput: input, bundle })

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
    const preview = JSON.parse(sandboxInternalsForTests.displayPreview({
      status: 'completed',
      executionMode: 'executed',
      backendId: 'local-script',
      exitCode: 0,
      purpose: '长输出预览校验',
      dataBundleSummary: { scope: 'workspace_summary', fields: ['totalProfit'], rows: 1, redactions: 0 },
      manifest: {
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
      sandboxRunId: 'sandbox_long_output',
    } as any))

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
      dataRequest: { scope: 'workspace_summary' },
      expectedOutputs: ['markdown'],
    }
    const bundle = {
      bundleId: 'bundle_empty',
      scope: 'workspace_summary' as const,
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
    const result = await new SandboxBroker().execute({ manifest, toolInput: input, bundle })

    expect(result.status).toBe('completed')
    expect(result.executionMode).toBe('executed')
    expect(result.exitCode).toBe(0)
    expect(result.outputText).toBe('')
    expect(result.extraction.extractionStatus).toBe('empty')
  })

  it('reports a real timeout instead of fabricating sandbox success', async () => {
    const input: SandboxRunCodeInput = {
      purpose: '超时校验',
      language: 'python',
      code: 'import time\ntime.sleep(2)',
      dataRequest: { scope: 'workspace_summary' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_timeout',
      scope: 'workspace_summary' as const,
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
    const result = await new SandboxBroker().execute({ manifest, toolInput: input, bundle })

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
      dataRequest: { scope: 'workspace_summary' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_failure',
      scope: 'workspace_summary' as const,
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
    const result = await new SandboxBroker().execute({ manifest, toolInput: input, bundle })

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
      dataRequest: { scope: 'workspace_summary' },
      expectedOutputs: ['json'],
    }
    const bundle = {
      bundleId: 'bundle_blocked',
      scope: 'workspace_summary' as const,
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
    const result = await new SandboxBroker().execute({ manifest, toolInput: input, bundle })

    expect(result.status).toBe('blocked')
    expect(result.executionMode).toBe('not_executed')
    expect(result.exitCode).toBeNull()
    expect(result.result.structured).toMatchObject({
      reason: 'business_writes_forbidden',
    })
    expect(result.provenance.inputBundleMounted).toBe(false)
  })
})
