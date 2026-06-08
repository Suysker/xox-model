import type { AgentToolObservationOutcome } from '@xox/contracts'

export type ToolObservationStatus = 'completed' | 'failed' | 'cancelled' | 'not_executed' | 'invalid'

export type ToolObservationLike = {
  toolName: string
  status: ToolObservationStatus
  modelContent?: string | null
  synthetic?: boolean
  outcome?: AgentToolObservationOutcome
}

const REPAIRABLE_PROVIDER_BOUNDARY_CODES = new Set([
  'tool_call_arguments_truncated',
  'tool_call_arguments_invalid',
  'tool_call_stream_interrupted',
  'tool_call_registered_but_deferred',
])

function parseModelFacts(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function stringFact(facts: Record<string, unknown> | null, key: string) {
  const value = facts?.[key]
  return typeof value === 'string' ? value : null
}

function booleanFact(facts: Record<string, unknown> | null, key: string) {
  const value = facts?.[key]
  return typeof value === 'boolean' ? value : null
}

function numberFact(facts: Record<string, unknown> | null, key: string) {
  const value = facts?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function arrayFact(facts: Record<string, unknown> | null, key: string) {
  const value = facts?.[key]
  return Array.isArray(value) ? value : []
}

function textFact(facts: Record<string, unknown> | null, key: string) {
  const value = facts?.[key]
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const preview = (value as Record<string, unknown>).preview
    return typeof preview === 'string' ? preview : ''
  }
  return ''
}

function hasReadableSandboxOutput(facts: Record<string, unknown> | null) {
  const extraction = facts?.extraction && typeof facts.extraction === 'object'
    ? facts.extraction as Record<string, unknown>
    : null
  const result = facts?.result && typeof facts.result === 'object'
    ? facts.result as Record<string, unknown>
    : null
  const resultSummary = result?.summary
  return Boolean(
    textFact(facts, 'outputText').trim() ||
    textFact(facts, 'stdout').trim() ||
    textFact(facts, 'stderr').trim() ||
    (typeof resultSummary === 'string' ? resultSummary.trim() : '') ||
    (resultSummary && typeof resultSummary === 'object' && typeof (resultSummary as Record<string, unknown>).preview === 'string'
      ? String((resultSummary as Record<string, unknown>).preview).trim()
      : '') ||
    extraction?.extractionStatus === 'parsed' ||
    arrayFact(facts, 'artifacts').length > 0,
  )
}

function classifyProviderBoundary(facts: Record<string, unknown> | null): AgentToolObservationOutcome {
  const code = stringFact(facts, 'boundaryCode')
  return code && isRepairableProviderBoundaryCode(code) ? 'failed_repairable' : 'failed_terminal'
}

function classifySandbox(facts: Record<string, unknown> | null, status: ToolObservationStatus): AgentToolObservationOutcome {
  const executionMode = stringFact(facts, 'executionMode')
  const sandboxStatus = stringFact(facts, 'status') ?? status
  const exitCode = numberFact(facts, 'exitCode')
  const manifestScoped = booleanFact(facts, 'manifestScoped')

  if (executionMode === 'not_executed' || sandboxStatus === 'blocked') return 'policy_blocked'
  if (status === 'cancelled') return 'failed_terminal'

  if (executionMode === 'executed') {
    if (sandboxStatus === 'completed' && exitCode === 0 && manifestScoped === true) {
      return hasReadableSandboxOutput(facts) ? 'completed_valid' : 'completed_invalid'
    }
    return 'failed_repairable'
  }

  if (status === 'failed' || status === 'invalid') return 'failed_repairable'
  return status === 'completed' ? 'completed_invalid' : 'failed_terminal'
}

export function classifyToolObservation(input: ToolObservationLike): AgentToolObservationOutcome {
  if (input.outcome) return input.outcome

  const facts = parseModelFacts(input.modelContent)
  const observationType = stringFact(facts, 'observationType')

  if (observationType === 'provider_tool_call_boundary') return classifyProviderBoundary(facts)
  if (observationType === 'sandbox_execution' || input.toolName === 'sandbox_run_code') {
    return classifySandbox(facts, input.status)
  }
  if (observationType === 'action_preview') return 'pending_human'
  if (observationType === 'action_result') {
    if (input.status === 'completed' && booleanFact(facts, 'completed') === true) return 'completed_valid'
    return input.status === 'failed' ? 'failed_terminal' : 'pending_human'
  }

  if (input.status === 'completed') return 'completed_valid'
  if (input.status === 'invalid' && input.synthetic) return 'failed_repairable'
  return 'failed_terminal'
}

export function isRepairableToolObservation(input: ToolObservationLike) {
  const outcome = classifyToolObservation(input)
  return outcome === 'failed_repairable' || outcome === 'completed_invalid'
}

export function isTerminalToolObservation(input: ToolObservationLike) {
  const outcome = classifyToolObservation(input)
  return outcome === 'failed_terminal' || outcome === 'policy_blocked'
}

export function isRepairableProviderBoundaryCode(code: string) {
  return REPAIRABLE_PROVIDER_BOUNDARY_CODES.has(code)
}
