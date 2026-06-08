import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { Settings } from '../core/settings.js'
import type { CurrentUser } from '../modules/auth.js'
import { redactSecretLikeContent } from './memory.js'
import { addRunEvent } from './run-events.js'
import { planWithRuntimeAdapter } from './runtime/adapter-router.js'
import type { AgentEvidenceItem, AgentEvidenceSubject, AgentFinalAnswerClaim } from './evidence-ledger.js'
import { evidenceForModel } from './evidence-ledger.js'
import type { ChatTool } from './tool-catalog.js'

type ClaimExtractionContext = {
  db: Kysely<Database>
  settings: Settings
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  message: string
  abortSignal?: AbortSignal
}

export type FinalAnswerClaimExtractionResult =
  | { status: 'completed'; claims: AgentFinalAnswerClaim[] }
  | { status: 'skipped'; reason: 'empty_final_answer' | 'rules_provider' | 'deterministic_evidence_satisfied' }
  | { status: 'unavailable'; reason: string }

const CLAIM_SUBJECT_TYPES = new Set<AgentEvidenceSubject['type']>([
  'workspace',
  'shareholder',
  'member',
  'ledger_entry',
  'forecast',
  'calculation',
  'action',
])

const CLAIM_KINDS = new Set<AgentFinalAnswerClaim['kind']>([
  'domain_fact',
  'derived_calculation',
  'entity_specific',
  'action_status',
  'refusal',
  'clarification',
])

const FINAL_ANSWER_CLAIM_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'final_answer_extract_claims',
    description: [
      'Extract evidence-relevant claims from the assistant final answer.',
      'Do not judge correctness and do not answer the user.',
      'Return only claims that would need domain facts, entity facts, calculations, action status, refusal policy, or clarification state to be accepted.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['claims'],
      properties: {
        claims: {
          type: 'array',
          description: 'Structured claims made by the final answer. Return [] only when the final answer contains no evidence-relevant claim.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'reason'],
            properties: {
              claimId: { type: 'string', description: 'Stable short id such as claim_1.' },
              kind: {
                type: 'string',
                enum: ['domain_fact', 'derived_calculation', 'entity_specific', 'action_status', 'refusal', 'clarification'],
                description: 'Claim category.',
              },
              subject: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  type: {
                    type: 'string',
                    enum: ['workspace', 'shareholder', 'member', 'ledger_entry', 'forecast', 'calculation', 'action'],
                  },
                  id: { type: ['string', 'null'] },
                  label: { type: ['string', 'null'] },
                },
              },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: 'Evidence ids or broad dependencies if visible in the provided evidence list.',
              },
              text: { type: 'string', description: 'Concise excerpt or paraphrase of the claim.' },
              reason: { type: 'string', description: 'Why this claim requires evidence.' },
            },
          },
        },
      },
    },
  },
}

function systemPrompt() {
  return [
    'You are the claim extraction stage of xox-model AgentRunEngine.',
    'You only convert an assistant final answer into structured evidence-relevant claims.',
    'Use final_answer_extract_claims when the provider supports tool calls for this review turn.',
    'Do not decide whether the final answer is correct.',
    'Do not infer domain facts that are not present in the final answer.',
    'A claim is evidence-relevant when it mentions workspace data, a specific shareholder/member/ledger item, a computed result, an action execution state, a refusal, or a clarification need.',
    'Entity-specific claims include ordinal or named shareholders/members, such as "the second shareholder", "shareholder B", "member 1", or equivalent expressions in any language.',
    'Derived calculation claims include ROI, payback, inflation adjustment, loan-rate adjustment, profit, cash, projections, allocations, or scenario computations.',
  ].join('\n')
}

function normalizeSubject(value: unknown): AgentEvidenceSubject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string' || !CLAIM_SUBJECT_TYPES.has(record.type as AgentEvidenceSubject['type'])) return undefined
  return {
    type: record.type as AgentEvidenceSubject['type'],
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.label === 'string' ? { label: record.label } : {}),
  }
}

function normalizeClaims(value: unknown): AgentFinalAnswerClaim[] {
  const claims = Array.isArray(value) ? value : []
  return claims.flatMap((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    if (typeof record.kind !== 'string' || !CLAIM_KINDS.has(record.kind as AgentFinalAnswerClaim['kind'])) return []
    const reason = typeof record.reason === 'string' && record.reason.trim()
      ? record.reason.trim()
      : 'Final answer made an evidence-relevant claim.'
    const subject = normalizeSubject(record.subject)
    const claim: AgentFinalAnswerClaim = {
      claimId: typeof record.claimId === 'string' && record.claimId.trim() ? record.claimId.trim() : `claim_${index + 1}`,
      kind: record.kind as AgentFinalAnswerClaim['kind'],
      ...(subject ? { subject } : {}),
      ...(Array.isArray(record.dependsOn) ? { dependsOn: record.dependsOn.filter((entry): entry is string => typeof entry === 'string') } : {}),
      ...(typeof record.text === 'string' && record.text.trim() ? { text: record.text.trim() } : {}),
      reason,
    }
    return [claim]
  })
}

function claimsFromResult(result: Awaited<ReturnType<typeof planWithRuntimeAdapter>>) {
  const claimStep = result?.steps.find((step) => step.intent === 'final_answer.extract_claims')
  return {
    hasClaimStep: Boolean(claimStep),
    claims: normalizeClaims((claimStep as { claims?: unknown } | undefined)?.claims),
  }
}

export async function extractFinalAnswerClaims(
  ctx: ClaimExtractionContext,
  input: {
    finalAssistantText: string | null
    evidence: AgentEvidenceItem[]
  },
): Promise<FinalAnswerClaimExtractionResult> {
  const finalText = input.finalAssistantText?.trim() ?? ''
  if (!finalText) return { status: 'skipped', reason: 'empty_final_answer' }
  if (ctx.settings.llmProvider === 'rules') return { status: 'skipped', reason: 'rules_provider' }

  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'final_answer_claim_extraction_started',
    title: '最终回答 claim review',
    message: '正在尝试把模型最终回答转成结构化 claim，以便和 run-scoped observation evidence 对齐。',
    status: 'running',
    data: {
      evidenceCount: input.evidence.length,
      contentLength: finalText.length,
    },
  })

  const result = await planWithRuntimeAdapter({
    settings: ctx.settings,
    message: redactSecretLikeContent(ctx.message),
    context: {
      mode: 'final_answer_claim_extraction',
      workspace: { id: ctx.workspace.id, name: ctx.workspace.name },
      user: { id: ctx.user.id },
      evidence: evidenceForModel(input.evidence),
      finalAssistantText: redactSecretLikeContent(finalText),
    },
    tools: [FINAL_ANSWER_CLAIM_TOOL],
    messages: [
      { role: 'system', content: systemPrompt() },
      {
        role: 'user',
        content: JSON.stringify({
          objective: redactSecretLikeContent(ctx.message),
          finalAssistantText: redactSecretLikeContent(finalText),
          evidence: evidenceForModel(input.evidence),
        }),
      },
    ],
    stream: false,
    maxTokens: 500,
    requestTimeoutMs: ctx.settings.agentProviderRequestTimeoutMs,
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
  })

  const extraction = claimsFromResult(result)
  if (result?.error || !result || !extraction.hasClaimStep) {
    const reason = result?.error?.message ?? 'Provider did not return final_answer_extract_claims for optional claim review.'
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'final_answer_claim_extraction_unavailable',
      title: '最终回答 claim review 不可用',
      message: reason,
      status: 'info',
      data: {
        errorKind: result?.error?.kind ?? null,
        toolNames: result?.error?.toolNames ?? [],
      },
    })
    return { status: 'unavailable', reason }
  }

  const claims = extraction.claims
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'final_answer_claims_extracted',
    title: '最终回答 claim 已提取',
    message: `已提取 ${claims.length} 个最终回答 claim。`,
    status: 'completed',
    data: {
      claimCount: claims.length,
      claims,
    },
  })

  return { status: 'completed', claims }
}
