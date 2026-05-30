import type { AgentAutomationLevel } from '@xox/contracts'

// Inspired by OpenClaw's effective approval policy composition: requested/user
// policy and host/tool policy are composed by the strictest applicable bound.

export type AgentWriteRiskLevel = 'low' | 'medium' | 'high'

export type ComposedApprovalPolicyInput = {
  automationLevel: AgentAutomationLevel
  riskLevel: AgentWriteRiskLevel
  accountImpacting?: boolean
  highRiskAutoAllowed?: boolean
}

export type ComposedApprovalPolicyDecision =
  | { mode: 'auto_execute'; reason: string }
  | { mode: 'require_confirmation'; reason: string }
  | { mode: 'forbidden'; reason: string }

const riskRank: Record<AgentWriteRiskLevel, number> = { low: 1, medium: 2, high: 3 }
const automationRank: Record<AgentAutomationLevel, number> = { manual: 0, low: 1, medium: 2, high: 3 }

export function composeAgentWriteApprovalPolicy(input: ComposedApprovalPolicyInput): ComposedApprovalPolicyDecision {
  if (input.accountImpacting) {
    return { mode: 'forbidden', reason: '账号影响类动作不能由 Agent 执行。' }
  }

  if (input.automationLevel === 'manual') {
    return { mode: 'require_confirmation', reason: '当前为手动确认模式，写入动作必须等待用户确认。' }
  }

  if (input.riskLevel === 'high' && !input.highRiskAutoAllowed) {
    return { mode: 'require_confirmation', reason: '该动作为高风险写入，高自动化也需要显式确认。' }
  }

  if (riskRank[input.riskLevel] <= automationRank[input.automationLevel]) {
    return { mode: 'auto_execute', reason: `${input.automationLevel} 自动化授权允许自动执行 ${input.riskLevel} 风险动作。` }
  }

  return {
    mode: 'require_confirmation',
    reason: `${input.automationLevel} 自动化授权不足以自动执行 ${input.riskLevel} 风险动作。`,
  }
}
