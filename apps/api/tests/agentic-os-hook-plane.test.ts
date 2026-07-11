import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentHookRegistrationManifest, AgentScope } from '@agentic-os/contracts'
import {
  AgentServerHookProvider,
  AgentServerInMemoryHookStore,
} from '@agentic-os/server'
import type { Settings } from '../src/core/settings.js'
import { createDatabase } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { executeXoxAgentRun } from '../src/agent/host-profile/xox-host-profile.js'

describe('Agentic OS hook plane downstream boundary', () => {
  it('plugs hook peripherals into the real xox host profile without owning dispatch', async () => {
    const providerServer = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end([
        `data: ${JSON.stringify({
          id: 'chatcmpl_hook_pilot',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Hook pilot completed.' } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl_hook_pilot',
          choices: [{ index: 0, finish_reason: 'stop', delta: {} }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''))
    })
    await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve))
    const providerPort = (providerServer.address() as AddressInfo).port
    const databasePath = join(mkdtempSync(join(tmpdir(), 'xox-hook-plane-')), 'pilot.db')
    const settings = testSettings(databasePath, `http://127.0.0.1:${providerPort}/v1`)
    const db = createDatabase(settings)

    try {
      await runMigrations(db)
      const now = new Date().toISOString()
      const userId = 'xox-user-pilot'
      const workspaceId = 'xox-workspace-pilot'
      const threadId = 'xox-thread-pilot'
      const runId = 'xox-run-pilot'
      await db.insertInto('users').values({
        id: userId,
        email: 'hook-pilot@example.test',
        display_name: 'Hook Pilot',
        status: 'active',
        cancelled_at: null,
        created_at: now,
        updated_at: now,
      }).execute()
      await db.insertInto('workspaces').values({
        id: workspaceId,
        owner_id: userId,
        name: 'Hook Pilot Workspace',
        schema_version: 1,
        active_version_id: null,
        created_at: now,
        updated_at: now,
      }).execute()
      await db.insertInto('workspace_drafts').values({
        workspace_id: workspaceId,
        revision: 1,
        config_json: '{}',
        result_json: null,
        last_autosaved_at: null,
        updated_by: userId,
        created_at: now,
        updated_at: now,
      }).execute()
      await db.insertInto('agent_threads').values({
        id: threadId,
        workspace_id: workspaceId,
        user_id: userId,
        title: 'Hook pilot',
        created_at: now,
        updated_at: now,
      }).execute()
      await db.insertInto('agent_runs').values({
        id: runId,
        thread_id: threadId,
        user_id: userId,
        status: 'running',
        input_message_id: null,
        input_message: 'Reply with a short completion.',
        planner_source: null,
        automation_level: 'manual',
        goal_status: 'interpreting',
        worker_id: null,
        lease_expires_at: null,
        heartbeat_at: null,
        created_at: now,
        completed_at: null,
      }).execute()

      const scope: AgentScope = { tenantId: userId, workspaceId, userId }
      const registrations = hookRegistrations(scope)
      const store = new AgentServerInMemoryHookStore()
      const providerCalls: string[] = []
      const provider = new AgentServerHookProvider({
        providers: [{
          providerId: 'xox-pilot-provider',
          trustMode: 'isolated_rpc',
          source: 'host_rpc',
          registrations,
          invoke: async ({ token, registration }) => {
            expect(token.tenantId).toBe(scope.tenantId)
            expect(token.workspaceId).toBe(scope.workspaceId)
            providerCalls.push(registration.hookName)
            if (registration.hookName === 'before_agent_run') return { outcome: 'pass' }
            return undefined
          },
        }],
        healthStore: store,
      })
      const [user, workspace, thread] = await Promise.all([
        db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow(),
        db.selectFrom('workspaces').selectAll().where('id', '=', workspaceId).executeTakeFirstOrThrow(),
        db.selectFrom('agent_threads').selectAll().where('id', '=', threadId).executeTakeFirstOrThrow(),
      ])

      const result = await executeXoxAgentRun({
        db,
        settings,
        user,
        workspace,
        thread,
        threadId,
        runId,
        message: 'Reply with a short completion.',
        automationLevel: 'manual',
      }, {
        beforeStateWrite: async () => true,
        hooks: { provider, store, outputStore: store },
      })

      expect(result?.agenticOsResult.status).toBe('completed')
      expect(providerCalls).toEqual(['before_agent_run'])
      expect(store.inspect().snapshots).toHaveLength(1)
      expect(store.inspect().outbox.map((item) => item.event.hookName)).toEqual(['agent_end'])
    } finally {
      await db.destroy()
      await new Promise<void>((resolve, reject) => providerServer.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })
})

function hookRegistrations(scope: AgentScope): AgentHookRegistrationManifest[] {
  return [
    {
      hookId: 'xox-pilot-policy',
      providerId: 'xox-pilot-provider',
      hookName: 'before_agent_run',
      version: '1.0.0',
      enabled: true,
      priority: 100,
      timeoutMs: 1_000,
      trustMode: 'isolated_rpc',
      criticality: 'required',
      source: 'host_rpc',
      scope,
      capabilities: ['observe', 'block'],
    },
    {
      hookId: 'xox-pilot-terminal-observer',
      providerId: 'xox-pilot-provider',
      hookName: 'agent_end',
      version: '1.0.0',
      enabled: true,
      priority: 10,
      timeoutMs: 1_000,
      trustMode: 'isolated_rpc',
      criticality: 'optional',
      source: 'host_rpc',
      scope,
      capabilities: ['observe'],
    },
  ]
}

function testSettings(databasePath: string, baseUrl: string): Settings {
  return {
    databaseUrl: `sqlite:///${databasePath.replaceAll('\\', '/')}`,
    sessionCookieName: 'xox_session',
    sessionTtlDays: 14,
    corsOrigin: 'http://127.0.0.1:5173',
    llmProvider: 'openai-compatible',
    openaiBaseUrl: baseUrl,
    openaiModel: 'test-model',
    openaiApiKey: null,
    openaiCompatibleProvider: 'test-compatible',
    openaiCompatibleBaseUrl: baseUrl,
    openaiCompatibleModel: 'test-model',
    openaiCompatibleApiKey: 'test-key',
    agentProviderKeyEncryptionSecret: null,
    agentWorkerId: 'hook-pilot-worker',
    agentRunLeaseTtlMs: 10_000,
    agentRunWorkerPollMs: 10_000,
    agentProviderRequestTimeoutMs: 10_000,
  }
}
