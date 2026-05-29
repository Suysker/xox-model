import type { SandboxArtifactKind, SandboxFileKind } from '@xox/contracts'

export const SANDBOX_FILE_KINDS: readonly SandboxFileKind[] = [
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xlsx',
  'xls',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'html',
  'htm',
  'txt',
  'md',
  'pdf',
  'docx',
  'doc',
]

export const SANDBOX_ARTIFACT_KINDS: readonly SandboxArtifactKind[] = [
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xlsx',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'html',
  'txt',
  'md',
  'pdf',
  'docx',
]

export type SandboxFileFamily =
  | 'spreadsheet'
  | 'structured_text'
  | 'web_document'
  | 'image'
  | 'pdf'
  | 'word_document'

export type SandboxFileAdapter = {
  kind: SandboxFileKind
  family: SandboxFileFamily
  extensions: string[]
  mimeTypes: string[]
  legacyBinary?: boolean
  outputAllowed: boolean
}

export type SandboxUploadedFile = {
  name: string
  sizeBytes: number
  mimeType?: string | null
  bytes?: Uint8Array
}

export type SandboxFilePreview = {
  kind: SandboxFileKind
  family: SandboxFileFamily
  status: 'accepted' | 'blocked'
  reason?: string
  warnings: string[]
  normalized: {
    rows?: unknown[]
    textPreview?: string
    metadata?: Record<string, unknown>
  }
}

const MAX_INPUT_FILE_BYTES = 25 * 1024 * 1024
const MAX_TEXT_PREVIEW_CHARS = 4000
const MAX_PREVIEW_ROWS = 20

const adapters: SandboxFileAdapter[] = [
  { kind: 'csv', family: 'spreadsheet', extensions: ['.csv'], mimeTypes: ['text/csv', 'application/csv', 'text/plain'], outputAllowed: true },
  { kind: 'tsv', family: 'spreadsheet', extensions: ['.tsv'], mimeTypes: ['text/tab-separated-values', 'text/plain'], outputAllowed: true },
  { kind: 'xlsx', family: 'spreadsheet', extensions: ['.xlsx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], outputAllowed: true },
  { kind: 'xls', family: 'spreadsheet', extensions: ['.xls'], mimeTypes: ['application/vnd.ms-excel'], legacyBinary: true, outputAllowed: false },
  { kind: 'json', family: 'structured_text', extensions: ['.json'], mimeTypes: ['application/json', 'text/json', 'text/plain'], outputAllowed: true },
  { kind: 'jsonl', family: 'structured_text', extensions: ['.jsonl', '.ndjson'], mimeTypes: ['application/x-ndjson', 'application/jsonl', 'text/plain'], outputAllowed: true },
  { kind: 'txt', family: 'structured_text', extensions: ['.txt'], mimeTypes: ['text/plain'], outputAllowed: true },
  { kind: 'md', family: 'structured_text', extensions: ['.md', '.markdown'], mimeTypes: ['text/markdown', 'text/plain'], outputAllowed: true },
  { kind: 'html', family: 'web_document', extensions: ['.html'], mimeTypes: ['text/html'], outputAllowed: true },
  { kind: 'htm', family: 'web_document', extensions: ['.htm'], mimeTypes: ['text/html'], outputAllowed: false },
  { kind: 'png', family: 'image', extensions: ['.png'], mimeTypes: ['image/png'], outputAllowed: true },
  { kind: 'jpg', family: 'image', extensions: ['.jpg'], mimeTypes: ['image/jpeg'], outputAllowed: true },
  { kind: 'jpeg', family: 'image', extensions: ['.jpeg'], mimeTypes: ['image/jpeg'], outputAllowed: true },
  { kind: 'webp', family: 'image', extensions: ['.webp'], mimeTypes: ['image/webp'], outputAllowed: true },
  { kind: 'pdf', family: 'pdf', extensions: ['.pdf'], mimeTypes: ['application/pdf'], outputAllowed: true },
  { kind: 'docx', family: 'word_document', extensions: ['.docx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], outputAllowed: true },
  { kind: 'doc', family: 'word_document', extensions: ['.doc'], mimeTypes: ['application/msword'], legacyBinary: true, outputAllowed: false },
]

export function sandboxFileAdapterForKind(kind: SandboxFileKind) {
  return adapters.find((adapter) => adapter.kind === kind) ?? null
}

export function sandboxFileAdapters() {
  return adapters.slice()
}

export function normalizeSandboxFileKind(value: unknown): SandboxFileKind | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/^\./, '').toLowerCase()
  return (SANDBOX_FILE_KINDS as readonly string[]).includes(normalized)
    ? normalized as SandboxFileKind
    : null
}

export function normalizeSandboxFileKinds(value: unknown): SandboxFileKind[] {
  const rawValues = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const kinds: SandboxFileKind[] = []
  for (const raw of rawValues) {
    const kind = normalizeSandboxFileKind(raw)
    if (kind && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

export function normalizeSandboxArtifactKinds(value: unknown): SandboxArtifactKind[] {
  const rawValues = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const kinds: SandboxArtifactKind[] = []
  for (const raw of rawValues) {
    if (typeof raw !== 'string') continue
    const normalized = raw.trim().replace(/^\./, '').toLowerCase()
    if ((SANDBOX_ARTIFACT_KINDS as readonly string[]).includes(normalized) && !kinds.includes(normalized as SandboxArtifactKind)) {
      kinds.push(normalized as SandboxArtifactKind)
    }
  }
  return kinds
}

function extensionOf(fileName: string) {
  const normalized = fileName.trim().toLowerCase()
  const index = normalized.lastIndexOf('.')
  return index >= 0 ? normalized.slice(index) : ''
}

function bytesPrefix(bytes: Uint8Array, length: number) {
  return Array.from(bytes.slice(0, length)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function asciiPreview(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('latin1').slice(0, 12000)
}

function magicMatchesKind(kind: SandboxFileKind, bytes?: Uint8Array) {
  if (!bytes || bytes.length === 0) return true
  const prefix4 = bytesPrefix(bytes, 4)
  const prefix8 = bytesPrefix(bytes, 8)
  if (kind === 'png') return prefix8 === '89504e470d0a1a0a'
  if (kind === 'jpg' || kind === 'jpeg') return prefix4.startsWith('ffd8ff')
  if (kind === 'webp') return asciiPreview(bytes).startsWith('RIFF') && asciiPreview(bytes).slice(8, 12) === 'WEBP'
  if (kind === 'pdf') return Buffer.from(bytes.slice(0, 5)).toString('ascii') === '%PDF-'
  if (kind === 'xlsx' || kind === 'docx') return prefix4 === '504b0304' || prefix4 === '504b0506' || prefix4 === '504b0708'
  if (kind === 'xls' || kind === 'doc') return prefix8.startsWith('d0cf11e0a1b11ae1')
  return true
}

function mimeMatches(adapter: SandboxFileAdapter, mimeType?: string | null) {
  if (!mimeType) return true
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return normalized.length === 0 || adapter.mimeTypes.includes(normalized)
}

function decodeText(bytes?: Uint8Array) {
  if (!bytes) return ''
  return Buffer.from(bytes).toString('utf8').replace(/\u0000/g, '')
}

function parseDelimitedRows(text: string, delimiter: string) {
  return text.split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, MAX_PREVIEW_ROWS)
    .map((line) => line.split(delimiter).map((cell) => cell.trim()))
}

function sanitizeHtml(text: string) {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
    .slice(0, MAX_TEXT_PREVIEW_CHARS)
}

function activeContentReason(kind: SandboxFileKind, text: string) {
  if ((kind === 'html' || kind === 'htm') && (/<script\b/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /javascript:/i.test(text))) {
    return 'html_active_content'
  }
  if (kind === 'pdf' && (/\/JavaScript\b/i.test(text) || /\/Launch\b/i.test(text) || /\/EmbeddedFile\b/i.test(text))) {
    return 'pdf_active_content'
  }
  if ((kind === 'docx' || kind === 'xlsx' || kind === 'doc' || kind === 'xls') && /vbaProject/i.test(text)) {
    return 'office_macro'
  }
  return null
}

function normalizedPreview(kind: SandboxFileKind, text: string) {
  if (kind === 'csv') return { rows: parseDelimitedRows(text, ',') }
  if (kind === 'tsv') return { rows: parseDelimitedRows(text, '\t') }
  if (kind === 'json') {
    try {
      const parsed = JSON.parse(text)
      return { metadata: { rootType: Array.isArray(parsed) ? 'array' : typeof parsed }, textPreview: JSON.stringify(parsed, null, 2).slice(0, MAX_TEXT_PREVIEW_CHARS) }
    } catch {
      return { textPreview: text.slice(0, MAX_TEXT_PREVIEW_CHARS) }
    }
  }
  if (kind === 'jsonl') return { rows: text.split(/\r?\n/).filter(Boolean).slice(0, MAX_PREVIEW_ROWS).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return line
    }
  }) }
  if (kind === 'html' || kind === 'htm') return { textPreview: sanitizeHtml(text) }
  if (kind === 'txt' || kind === 'md') return { textPreview: text.slice(0, MAX_TEXT_PREVIEW_CHARS) }
  return { metadata: { binaryPreview: true } }
}

export function inspectSandboxUploadedFile(file: SandboxUploadedFile): SandboxFilePreview {
  const kind = normalizeSandboxFileKind(extensionOf(file.name))
  if (!kind) {
    return {
      kind: 'txt',
      family: 'structured_text',
      status: 'blocked',
      reason: 'unsupported_extension',
      warnings: [],
      normalized: { metadata: { fileName: file.name } },
    }
  }
  const adapter = sandboxFileAdapterForKind(kind)
  if (!adapter) {
    return {
      kind,
      family: 'structured_text',
      status: 'blocked',
      reason: 'missing_adapter',
      warnings: [],
      normalized: { metadata: { fileName: file.name } },
    }
  }
  const warnings = adapter.legacyBinary ? ['legacy_binary_requires_hardened_conversion'] : []
  const extension = extensionOf(file.name)
  const text = file.bytes ? (adapter.family === 'image' ? '' : decodeText(file.bytes) || asciiPreview(file.bytes)) : ''
  const activeReason = activeContentReason(kind, text || (file.bytes ? asciiPreview(file.bytes) : ''))
  const blockedReason = file.sizeBytes > MAX_INPUT_FILE_BYTES
    ? 'file_too_large'
    : !adapter.extensions.includes(extension)
      ? 'extension_mismatch'
      : !mimeMatches(adapter, file.mimeType)
        ? 'mime_mismatch'
        : !magicMatchesKind(kind, file.bytes)
          ? 'magic_mismatch'
          : activeReason

  return {
    kind,
    family: adapter.family,
    status: blockedReason ? 'blocked' : 'accepted',
    ...(blockedReason ? { reason: blockedReason } : {}),
    warnings,
    normalized: {
      ...normalizedPreview(kind, text),
      metadata: {
        ...(normalizedPreview(kind, text).metadata ?? {}),
        fileName: file.name,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType ?? null,
        legacyBinary: Boolean(adapter.legacyBinary),
      },
    },
  }
}
