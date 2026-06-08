import type { RuntimeChatMessage } from './runtime-adapter.js'

// Adapted from OpenClaw's MIT-licensed provider transport/tool-call repair
// approach: recover only provider protocol artifacts, never user semantics.
export type ProviderPlainTextToolCallArtifact = {
  format: 'deepseek_dsml' | 'harmony' | 'xmlish'
  toolNames: string[]
  preview: string
}

export type ProviderPlainTextToolCallRecovery = {
  artifact: ProviderPlainTextToolCallArtifact
  toolCalls: NonNullable<Extract<RuntimeChatMessage, { role: 'assistant' }>['tool_calls']>
  visibleText: string
}

type ParsedPlainTextToolCall = {
  name: string
  arguments: Record<string, unknown>
}

const MAX_PREVIEW = 240

function preview(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_PREVIEW)
}

function decodeXmlText(value: string) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function parseXmlAttribute(attributes: string, name: string) {
  const pattern = new RegExp(`\\b${name}=("([^"]*)"|'([^']*)'|([^\\s>]+))`)
  const match = pattern.exec(attributes)
  const value = match?.[2] ?? match?.[3] ?? match?.[4]
  return value ? decodeXmlText(value) : null
}

const dsmlToolBlockRegex =
  /<[|｜]{1,2}DSML[|｜]{1,2}(?:tool_calls|tool_call|function_calls)>([\s\S]*?)<\/[|｜]{1,2}DSML[|｜]{1,2}(?:tool_calls|tool_call|function_calls)>/gi
const dsmlInvokeRegex =
  /<[|｜]{1,2}DSML[|｜]{1,2}invoke\b([^>]*)>([\s\S]*?)<\/[|｜]{1,2}DSML[|｜]{1,2}invoke>/gi
const dsmlParameterRegex =
  /<[|｜]{1,2}DSML[|｜]{1,2}parameter\b([^>]*)>([\s\S]*?)<\/[|｜]{1,2}DSML[|｜]{1,2}parameter>/gi
const dsmlMarkerRegex =
  /<[|｜]{1,2}DSML[|｜]{1,2}(?:tool_calls|tool_call|function_calls|invoke|parameter)\b/i

function parseJsonRecord(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function parseDsmlInvokeArguments(body: string) {
  const args: Record<string, unknown> = {}
  dsmlParameterRegex.lastIndex = 0
  let parameterMatch: RegExpExecArray | null
  while ((parameterMatch = dsmlParameterRegex.exec(body)) !== null) {
    const name = parseXmlAttribute(parameterMatch[1] ?? '', 'name')
    if (!name) continue
    args[name] = decodeXmlText(parameterMatch[2] ?? '')
  }
  if (Object.keys(args).length > 0) return args
  return parseJsonRecord(body.trim())
}

function parseDeepSeekDsml(text: string): {
  calls: ParsedPlainTextToolCall[]
  visibleText: string
  foundArtifact: boolean
} {
  const calls: ParsedPlainTextToolCall[] = []
  let visibleText = ''
  let cursor = 0
  let foundArtifact = false
  dsmlToolBlockRegex.lastIndex = 0
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = dsmlToolBlockRegex.exec(text)) !== null) {
    foundArtifact = true
    visibleText += text.slice(cursor, blockMatch.index)
    cursor = blockMatch.index + blockMatch[0].length
    const body = blockMatch[1] ?? ''
    dsmlInvokeRegex.lastIndex = 0
    let invokeMatch: RegExpExecArray | null
    while ((invokeMatch = dsmlInvokeRegex.exec(body)) !== null) {
      const name = parseXmlAttribute(invokeMatch[1] ?? '', 'name')
      const args = parseDsmlInvokeArguments(invokeMatch[2] ?? '')
      if (name && args) calls.push({ name, arguments: args })
    }
  }
  visibleText += text.slice(cursor)
  return { calls, visibleText: visibleText.trim(), foundArtifact }
}

function parseStandaloneXmlish(text: string): ParsedPlainTextToolCall[] | null {
  const trimmed = text.trim()
  const open = /^<function=([A-Za-z0-9_.:-]{1,120})>\s*/i.exec(trimmed)
  if (!open?.[1]) return null
  const closeMatch = /<\/function>\s*$/i.exec(trimmed)
  const bodyEnd = closeMatch ? closeMatch.index : trimmed.length
  const body = trimmed.slice(open[0].length, bodyEnd)
  const parameterRegex = /<parameter=([A-Za-z0-9_.:-]{1,120})>([\s\S]*?)<\/parameter>/gi
  const args: Record<string, unknown> = {}
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = parameterRegex.exec(body)) !== null) {
    const name = match[1]
    if (!name) return null
    if (body.slice(cursor, match.index).trim()) return null
    args[name] = decodeXmlText(match[2] ?? '')
    cursor = match.index + match[0].length
  }
  if (body.slice(cursor).trim()) return null
  return Object.keys(args).length > 0 ? [{ name: open[1], arguments: args }] : null
}

function parseStandaloneHarmony(text: string): ParsedPlainTextToolCall[] | null {
  const trimmed = text.trim()
  const open = /^(?:<\|channel\|>)?(?:commentary|analysis|final)\s+to=(?:functions\.)?([A-Za-z0-9_.:-]{1,120})\s+code\s*/.exec(trimmed)
  if (!open?.[1]) return null
  const payload = parseJsonRecord(trimmed.slice(open[0].length).replace(/<\|call\|>\s*$/i, '').trim())
  return payload ? [{ name: open[1], arguments: payload }] : null
}

function uniqueNames(calls: ParsedPlainTextToolCall[]) {
  return [...new Set(calls.map((call) => call.name))]
}

function artifact(format: ProviderPlainTextToolCallArtifact['format'], text: string, calls: ParsedPlainTextToolCall[]) {
  return {
    format,
    toolNames: uniqueNames(calls),
    preview: preview(text),
  }
}

function toProviderToolCalls(calls: ParsedPlainTextToolCall[]) {
  return calls.map((call, index) => ({
    id: `call_plaintext_${index}_${call.name.replace(/[^A-Za-z0-9_-]/g, '_')}`,
    type: 'function' as const,
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  }))
}

export function detectProviderPlainTextToolCallArtifact(text: string | null | undefined): ProviderPlainTextToolCallArtifact | null {
  const source = text?.trim() ?? ''
  if (!source) return null
  const dsml = parseDeepSeekDsml(source)
  if (dsml.foundArtifact) return artifact('deepseek_dsml', source, dsml.calls)
  if (dsmlMarkerRegex.test(source)) return artifact('deepseek_dsml', source, dsml.calls)
  const harmony = parseStandaloneHarmony(source)
  if (harmony) return artifact('harmony', source, harmony)
  const xmlish = parseStandaloneXmlish(source)
  if (xmlish) return artifact('xmlish', source, xmlish)
  return null
}

export function recoverProviderPlainTextToolCalls(input: {
  text: string
  allowedToolNames: readonly string[]
}): ProviderPlainTextToolCallRecovery | null {
  const source = input.text.trim()
  if (!source || input.allowedToolNames.length === 0) return null
  const allowed = new Set(input.allowedToolNames)

  const dsml = parseDeepSeekDsml(source)
  if (dsml.calls.length > 0 && dsml.calls.every((call) => allowed.has(call.name))) {
    return {
      artifact: artifact('deepseek_dsml', source, dsml.calls),
      toolCalls: toProviderToolCalls(dsml.calls),
      visibleText: dsml.visibleText,
    }
  }

  const standalone = parseStandaloneHarmony(source) ?? parseStandaloneXmlish(source)
  if (standalone && standalone.every((call) => allowed.has(call.name))) {
    return {
      artifact: artifact(parseStandaloneHarmony(source) ? 'harmony' : 'xmlish', source, standalone),
      toolCalls: toProviderToolCalls(standalone),
      visibleText: '',
    }
  }

  return null
}
