/**
 * OpenClaw-derived pre-compaction memory flush plan.
 *
 * Source inspiration: C:\Github\openclaw\extensions\memory-core\src\flush-plan.ts
 * The xox-model variant writes to SaaS daily/session notes instead of files.
 */

export const SILENT_MEMORY_FLUSH_REPLY = '<SILENT_MEMORY_FLUSH>'
export const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000
export const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024

const DAILY_NOTE_TARGET_HINT = 'Store durable context only as tenant-scoped daily/session memory notes.'
const DAILY_NOTE_APPEND_HINT = 'Append new note content; do not overwrite existing notes.'
const DAILY_NOTE_REVIEW_HINT = 'Do not promote directly to durable memory; dreaming/promotion review will decide later.'

export type MemoryFlushPlan = {
  softThresholdTokens: number
  forceFlushTranscriptBytes: number
  reserveTokensFloor: number
  prompt: string
  systemPrompt: string
  noteDate: string
}

function formatDateStamp(nowMs: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs))
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  return year && month && day ? `${year}-${month}-${day}` : new Date(nowMs).toISOString().slice(0, 10)
}

function ensureSilentHint(text: string) {
  return text.includes(SILENT_MEMORY_FLUSH_REPLY)
    ? text
    : `${text}\n\nIf no memory-worthy context exists, reply with ${SILENT_MEMORY_FLUSH_REPLY}.`
}

export function buildMemoryFlushPlan(input: {
  nowMs?: number
  timezone?: string
  softThresholdTokens?: number
  forceFlushTranscriptBytes?: number
  reserveTokensFloor?: number
  prompt?: string
  systemPrompt?: string
} = {}): MemoryFlushPlan {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs! : Date.now()
  const timezone = input.timezone ?? 'UTC'
  const noteDate = formatDateStamp(nowMs, timezone)
  const basePrompt = input.prompt?.trim() || [
    'Pre-compaction memory flush.',
    DAILY_NOTE_TARGET_HINT,
    DAILY_NOTE_APPEND_HINT,
    DAILY_NOTE_REVIEW_HINT,
    `Current note date: ${noteDate}.`,
  ].join(' ')
  const baseSystemPrompt = input.systemPrompt?.trim() || [
    'Pre-compaction memory flush turn.',
    'The session may be summarized soon; capture only useful context.',
    DAILY_NOTE_TARGET_HINT,
    DAILY_NOTE_REVIEW_HINT,
  ].join(' ')
  return {
    softThresholdTokens: input.softThresholdTokens ?? DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
    forceFlushTranscriptBytes: input.forceFlushTranscriptBytes ?? DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
    reserveTokensFloor: input.reserveTokensFloor ?? 1024,
    prompt: ensureSilentHint(basePrompt),
    systemPrompt: ensureSilentHint(baseSystemPrompt),
    noteDate,
  }
}
