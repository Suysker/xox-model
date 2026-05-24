import type { RuntimeChatMessage } from './runtime/runtime-adapter.js'

export type ThreadConversationLog = {
  messages?: Array<{
    role?: string
    createdAt?: string
    content?: string
  }>
}

function contextRecord(context: unknown): Record<string, unknown> | null {
  return context && typeof context === 'object' && !Array.isArray(context)
    ? context as Record<string, unknown>
    : null
}

export function threadConversationLogFromContext(context: unknown) {
  return contextRecord(context)?.threadConversationLog as ThreadConversationLog | undefined
}

export function runtimeMessagesFromThreadConversationLog(log: ThreadConversationLog | undefined): RuntimeChatMessage[] {
  const messages = Array.isArray(log?.messages) ? log.messages : []
  return messages.flatMap((message): RuntimeChatMessage[] => {
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : null
    const content = typeof message.content === 'string' ? message.content.trim() : ''
    if (!role || !content) return []
    const prefix = message.createdAt ? `[same-thread ${message.createdAt}] ` : '[same-thread] '
    return [{ role, content: `${prefix}${content}` }]
  })
}

export function contextWithoutThreadConversationLog(context: unknown) {
  const record = contextRecord(context)
  if (!record || !('threadConversationLog' in record)) return context
  const { threadConversationLog: _threadConversationLog, ...rest } = record
  return rest
}
