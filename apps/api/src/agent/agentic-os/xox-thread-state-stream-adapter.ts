import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Kysely } from 'kysely'
import { openAgentServerSignalStateStream } from '@agentic-os/server'
import type { AgentThreadEvent, AgentThreadState } from '@xox/contracts'
import type { Database, Row } from '../../db/schema.js'
import type { CurrentUser } from '../../modules/auth.js'
import { buildThreadState } from './xox-thread-store-adapter.js'
import { safeRunErrorMessage } from './xox-run-worker-adapter.js'
import { agentThreadEvents, type AgentThreadEventSignal } from './xox-thread-signal-adapter.js'

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

export function openAgentThreadStateStream(input: AgentThreadStateStreamInput) {
  input.response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  input.response.flushHeaders?.()

  let heartbeat: NodeJS.Timeout | null = null

  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
  }

  const stateStream = openAgentServerSignalStateStream<AgentThreadEventSignal, AgentThreadState>({
    initialSignal: {
      threadId: input.threadId,
      sequence: 0,
      reason: 'thread_restored',
    },
    subscribe: (listener) => agentThreadEvents.subscribe(input.threadId, listener),
    loadState: () => buildThreadState(input.db, input.workspace, input.user, input.threadId),
    emitState: ({ signal, state }) => {
      const event: AgentThreadEvent = {
        type: 'thread_state',
        threadId: input.threadId,
        sequence: signal.sequence,
        reason: signal.reason,
        state,
      }
      writeSseEvent(input.response, 'thread_state', event)
    },
    emitError: ({ error }) => {
      writeSseEvent(input.response, 'error', { message: safeRunErrorMessage(error) })
      stopHeartbeat()
    },
  })

  const close = () => {
    stopHeartbeat()
    stateStream.close()
  }

  heartbeat = setInterval(() => writeSseComment(input.response, 'heartbeat'), input.heartbeatMs ?? 15_000)
  heartbeat.unref?.()

  input.request.on('close', close)
  input.request.on('aborted', close)
}
