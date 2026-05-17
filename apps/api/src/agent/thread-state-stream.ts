import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Kysely } from 'kysely'
import type { AgentThreadEvent } from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { buildThreadState } from './thread-store.js'
import { agentThreadEvents, type AgentThreadEventSignal } from './thread-events.js'
import { safeRunErrorMessage } from './run-worker.js'

type AgentThreadStateStreamInput = {
  request: IncomingMessage
  response: ServerResponse
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  heartbeatMs?: number
}

function writeSseEvent(response: ServerResponse, event: string, data: unknown) {
  if (response.destroyed || response.writableEnded) return
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

function writeSseComment(response: ServerResponse, comment: string) {
  if (response.destroyed || response.writableEnded) return
  response.write(`: ${comment}\n\n`)
}

async function writeAgentThreadStateEvent(
  input: Omit<AgentThreadStateStreamInput, 'request' | 'heartbeatMs'> & { signal: AgentThreadEventSignal },
) {
  const state = await buildThreadState(input.db, input.workspace, input.user, input.threadId)
  const event: AgentThreadEvent = {
    type: 'thread_state',
    threadId: input.threadId,
    sequence: input.signal.sequence,
    reason: input.signal.reason,
    state,
  }
  writeSseEvent(input.response, 'thread_state', event)
}

export function openAgentThreadStateStream(input: AgentThreadStateStreamInput) {
  input.response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  input.response.flushHeaders?.()

  let closed = false
  let unsubscribe: () => void = () => undefined
  let heartbeat: NodeJS.Timeout | null = null
  const close = () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    unsubscribe()
  }
  const sendState = (signal: AgentThreadEventSignal) => {
    void writeAgentThreadStateEvent({ ...input, signal }).catch((error) => {
      writeSseEvent(input.response, 'error', { message: safeRunErrorMessage(error) })
      close()
    })
  }

  unsubscribe = agentThreadEvents.subscribe(input.threadId, sendState)
  heartbeat = setInterval(() => writeSseComment(input.response, 'heartbeat'), input.heartbeatMs ?? 15_000)
  heartbeat.unref?.()

  input.request.on('close', close)
  input.request.on('aborted', close)
  sendState({ threadId: input.threadId, sequence: 0, reason: 'thread_restored' })
}
