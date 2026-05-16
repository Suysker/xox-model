import { sql, type Kysely } from 'kysely'
import type { Database } from './schema.js'

async function exec(db: Kysely<Database>, statement: string) {
  await sql.raw(statement).execute(db)
}

async function tableColumns(db: Kysely<Database>, tableName: string) {
  const rows = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(tableName)})`.execute(db)
  return new Set(rows.rows.map((row) => row.name))
}

async function addColumnIfMissing(db: Kysely<Database>, tableName: string, columnName: string, definition: string) {
  const columns = await tableColumns(db, tableName)
  if (!columns.has(columnName)) {
    await exec(db, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
  }
}

export async function runMigrations(db: Kysely<Database>) {
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      display_name VARCHAR(120) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      cancelled_at DATETIME,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS user_credentials (
      user_id VARCHAR(36) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS user_sessions (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      user_agent VARCHAR(255),
      ip_address VARCHAR(64),
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS workspaces (
      id VARCHAR(36) PRIMARY KEY,
      owner_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(160) NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      active_version_id VARCHAR(36),
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS workspace_members (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(32) NOT NULL DEFAULT 'owner',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE(workspace_id, user_id)
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS workspace_drafts (
      workspace_id VARCHAR(36) PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1,
      config_json JSON NOT NULL,
      result_json JSON,
      last_autosaved_at DATETIME,
      updated_by VARCHAR(36),
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS workspace_events (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_id VARCHAR(36) NOT NULL REFERENCES users(id),
      event_type VARCHAR(48) NOT NULL,
      meta_json JSON,
      created_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS workspace_versions (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL,
      name VARCHAR(180) NOT NULL,
      kind VARCHAR(32) NOT NULL,
      note TEXT,
      baseline_scenario VARCHAR(16) NOT NULL DEFAULT 'base',
      source_draft_revision INTEGER NOT NULL,
      source_version_id VARCHAR(36),
      payload_json JSON NOT NULL,
      result_json JSON NOT NULL,
      created_by VARCHAR(36) NOT NULL REFERENCES users(id),
      created_at DATETIME NOT NULL,
      UNIQUE(workspace_id, version_no)
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS workspace_version_shares (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      version_id VARCHAR(36) NOT NULL REFERENCES workspace_versions(id) ON DELETE CASCADE UNIQUE,
      share_token VARCHAR(96) NOT NULL UNIQUE,
      created_by VARCHAR(36) NOT NULL REFERENCES users(id),
      revoked_at DATETIME,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS forecast_month_facts (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      version_id VARCHAR(36) NOT NULL REFERENCES workspace_versions(id) ON DELETE CASCADE,
      scenario_key VARCHAR(16) NOT NULL,
      month_index INTEGER NOT NULL,
      month_label VARCHAR(32) NOT NULL,
      planned_revenue FLOAT NOT NULL DEFAULT 0,
      planned_cost FLOAT NOT NULL DEFAULT 0,
      planned_profit FLOAT NOT NULL DEFAULT 0,
      UNIQUE(version_id, scenario_key, month_index)
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS forecast_line_item_facts (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      version_id VARCHAR(36) NOT NULL REFERENCES workspace_versions(id) ON DELETE CASCADE,
      scenario_key VARCHAR(16) NOT NULL,
      month_index INTEGER NOT NULL,
      month_label VARCHAR(32) NOT NULL,
      subject_key VARCHAR(255) NOT NULL,
      subject_name VARCHAR(180) NOT NULL,
      subject_type VARCHAR(32) NOT NULL,
      subject_group VARCHAR(64) NOT NULL,
      entity_type VARCHAR(64),
      entity_id VARCHAR(128),
      planned_amount FLOAT NOT NULL DEFAULT 0
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS ledger_periods (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      baseline_version_id VARCHAR(36),
      month_index INTEGER NOT NULL,
      month_label VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'open',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE(workspace_id, month_index)
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS actual_entries (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      ledger_period_id VARCHAR(36) NOT NULL REFERENCES ledger_periods(id) ON DELETE CASCADE,
      direction VARCHAR(16) NOT NULL,
      amount FLOAT NOT NULL,
      occurred_at DATETIME NOT NULL,
      counterparty VARCHAR(180),
      description TEXT,
      related_entity_type VARCHAR(32),
      related_entity_id VARCHAR(128),
      related_entity_name VARCHAR(180),
      source_entry_id VARCHAR(36),
      entry_origin VARCHAR(32) NOT NULL DEFAULT 'manual',
      derived_kind VARCHAR(32),
      status VARCHAR(16) NOT NULL DEFAULT 'posted',
      created_by VARCHAR(36) NOT NULL REFERENCES users(id),
      posted_at DATETIME,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS actual_entry_allocations (
      id VARCHAR(36) PRIMARY KEY,
      actual_entry_id VARCHAR(36) NOT NULL REFERENCES actual_entries(id) ON DELETE CASCADE,
      subject_key VARCHAR(255) NOT NULL,
      subject_name VARCHAR(180) NOT NULL,
      subject_type VARCHAR(32) NOT NULL,
      amount FLOAT NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36),
      actor_id VARCHAR(36),
      action VARCHAR(96) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'success',
      entity_type VARCHAR(64),
      entity_id VARCHAR(64),
      meta_json JSON,
      created_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_threads (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(180) NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_messages (
      id VARCHAR(36) PRIMARY KEY,
      thread_id VARCHAR(36) NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      role VARCHAR(16) NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_runs (
      id VARCHAR(36) PRIMARY KEY,
      thread_id VARCHAR(36) NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(32) NOT NULL,
      input_message_id VARCHAR(36),
      input_message TEXT,
      planner_source VARCHAR(64),
      created_at DATETIME NOT NULL,
      completed_at DATETIME
    )`,
  )
  await addColumnIfMissing(db, 'agent_runs', 'input_message_id', 'VARCHAR(36)')
  await addColumnIfMissing(db, 'agent_runs', 'input_message', 'TEXT')
  await addColumnIfMissing(db, 'agent_runs', 'planner_source', 'VARCHAR(64)')
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_action_requests (
      id VARCHAR(36) PRIMARY KEY,
      thread_id VARCHAR(36) NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      run_id VARCHAR(36) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind VARCHAR(96) NOT NULL,
      status VARCHAR(32) NOT NULL,
      title VARCHAR(180) NOT NULL,
      summary TEXT NOT NULL,
      target_label VARCHAR(180) NOT NULL,
      risk_level VARCHAR(16) NOT NULL,
      details_json JSON NOT NULL,
      navigation_json JSON NOT NULL,
      payload_json JSON NOT NULL,
      created_at DATETIME NOT NULL,
      executed_at DATETIME,
      error_message TEXT
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_plan_steps (
      id VARCHAR(36) PRIMARY KEY,
      thread_id VARCHAR(36) NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      run_id VARCHAR(36) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      action_request_id VARCHAR(36) REFERENCES agent_action_requests(id) ON DELETE SET NULL,
      sequence_no INTEGER NOT NULL,
      title VARCHAR(180) NOT NULL,
      description TEXT NOT NULL,
      status VARCHAR(32) NOT NULL,
      navigation_json JSON,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_memories (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id VARCHAR(36) REFERENCES agent_threads(id) ON DELETE SET NULL,
      kind VARCHAR(64) NOT NULL,
      key VARCHAR(128) NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL,
      source_message_id VARCHAR(36),
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      archived_at DATETIME
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_context_snapshots (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id VARCHAR(36) NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      created_at DATETIME NOT NULL
    )`,
  )

  await addColumnIfMissing(db, 'actual_entries', 'related_entity_type', 'VARCHAR(32)')
  await addColumnIfMissing(db, 'actual_entries', 'related_entity_id', 'VARCHAR(128)')
  await addColumnIfMissing(db, 'actual_entries', 'related_entity_name', 'VARCHAR(180)')
  await addColumnIfMissing(db, 'actual_entries', 'source_entry_id', 'VARCHAR(36)')
  await addColumnIfMissing(db, 'actual_entries', 'entry_origin', "VARCHAR(32) DEFAULT 'manual'")
  await addColumnIfMissing(db, 'actual_entries', 'derived_kind', 'VARCHAR(32)')
}
