import type { AgentToolLoopGuardrailFinding } from '@xox/contracts'
import type { Row } from '../../db/schema.js'
import type { AgentToolObservation } from '../tool-observation-continuation.js'

// Inspired by Hermes Agent's tool-loop guardrails. This module is deliberately
// pure: it detects runtime loop patterns and never guesses business intent.

export type ToolLoopGuardrailInput = {
  iteration: number
  priorObservations: AgentToolObservation[]
  newObservations: AgentToolObservation[]
  planRows: Row<'agent_plan_steps'>[]
  actionRows: Row<'agent_action_requests'>[]
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function observationSignature(observation: AgentToolObservation) {
  return [
    observation.toolName,
    observation.status,
    stableJson(observation.toolArguments),
  ].join('|')
}

function last<T>(values: T[]) {
  return values.length > 0 ? values[values.length - 1] : undefined
}

function repeatedFailure(input: ToolLoopGuardrailInput): AgentToolLoopGuardrailFinding | null {
  const previous = last(input.priorObservations)
  const current = last(input.newObservations)
  if (!previous || !current) return null
  if (previous.status !== 'failed' || current.status !== 'failed') return null
  if (observationSignature(previous) !== observationSignature(current)) return null
  return {
    severity: 'block',
    pattern: 'repeated_failure',
    toolName: current.toolName,
    evidence: [
      `Previous failed tool: ${previous.toolName}`,
      `Repeated failed tool: ${current.toolName}`,
      `Arguments: ${stableJson(current.toolArguments).slice(0, 500)}`,
    ],
    repairBrief: `工具 ${current.toolName} 用相同参数连续失败。不要继续重复调用；请换用已有观察结果、改用其他工具，或明确向用户说明阻断原因。`,
  }
}

function noProgress(input: ToolLoopGuardrailInput): AgentToolLoopGuardrailFinding | null {
  if (input.iteration <= 1) return null
  if (input.newObservations.length > 0 || input.planRows.length > 0 || input.actionRows.length > 0) return null
  return {
    severity: 'warn',
    pattern: 'no_progress',
    evidence: [
      `Iteration ${input.iteration} produced no observations, plan rows, or action rows.`,
    ],
    repairBrief: '上一轮没有产生新的工具观察、业务步骤或确认卡。下一轮必须基于已有上下文选择一个可验证动作；如果无法推进，应明确阻断而不是继续空转。',
  }
}

function executedWriteReapplied(input: ToolLoopGuardrailInput): AgentToolLoopGuardrailFinding | null {
  const executedKinds = new Set(
    input.priorObservations
      .map((observation) => {
        try {
          const parsed = JSON.parse(observation.modelContent) as Record<string, unknown>
          return parsed.observationType === 'action_result' && parsed.completed === true
            ? String(parsed.actionKind ?? '')
            : ''
        } catch {
          return ''
        }
      })
      .filter(Boolean),
  )
  if (executedKinds.size === 0) return null
  const repeated = input.actionRows.find((row) => executedKinds.has(row.kind))
  if (!repeated) return null
  return {
    severity: 'warn',
    pattern: 'executed_write_reapplied',
    toolName: repeated.kind,
    evidence: [
      `Action kind was already executed in prior observations: ${repeated.kind}`,
      `New action request id: ${repeated.id}`,
    ],
    repairBrief: `动作 ${repeated.kind} 已经有已执行观察。最终回复应总结已执行变化；除非用户明确要求再次执行，不要重复生成同类写入。`,
  }
}

export function evaluateToolLoopGuardrails(input: ToolLoopGuardrailInput): AgentToolLoopGuardrailFinding[] {
  return [
    repeatedFailure(input),
    noProgress(input),
    executedWriteReapplied(input),
  ].filter((finding): finding is AgentToolLoopGuardrailFinding => Boolean(finding))
}
