import { describe, expect, it } from 'vitest'
import { classifyToolObservationOutcome, isRepairableToolObservation } from '@agentic-os/core'

describe('tool observation outcome', () => {
  it('classifies provider argument boundaries as repairable observations', () => {
    const modelContent = JSON.stringify({
      observationType: 'provider_tool_call_boundary',
      boundaryCode: 'tool_call_arguments_truncated',
    })

    expect(classifyToolObservationOutcome({
      toolName: 'workspace_configure_operating_model',
      status: 'not_executed',
      modelContent,
      synthetic: true,
    })).toBe('failed_repairable')
  })

  it('classifies inventory boundary violations as terminal failures', () => {
    const modelContent = JSON.stringify({
      observationType: 'provider_tool_call_boundary',
      boundaryCode: 'tool_call_not_in_effective_inventory',
    })

    expect(classifyToolObservationOutcome({
      toolName: 'workspace_delete_everything',
      status: 'not_executed',
      modelContent,
      synthetic: true,
    })).toBe('failed_terminal')
  })

  it('keeps executed sandbox failures repairable', () => {
    const modelContent = JSON.stringify({
      observationType: 'sandbox_execution',
      executionMode: 'executed',
      status: 'failed',
      exitCode: 1,
      manifestScoped: true,
      stderr: 'SyntaxError: invalid syntax',
    })

    expect(isRepairableToolObservation({
      toolName: 'sandbox_run_code',
      status: 'failed',
      modelContent,
    })).toBe(true)
  })

  it('does not treat empty sandbox output as valid completed evidence', () => {
    const modelContent = JSON.stringify({
      observationType: 'sandbox_execution',
      executionMode: 'executed',
      status: 'completed',
      exitCode: 0,
      manifestScoped: true,
      stdout: '',
      stderr: '',
      outputText: '',
      extraction: { extractionStatus: 'empty' },
      artifacts: [],
    })

    expect(classifyToolObservationOutcome({
      toolName: 'sandbox_run_code',
      status: 'completed',
      modelContent,
    })).toBe('completed_invalid')
  })
})
