import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import DatabaseDriver from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import type { Database } from './schema.js'
import { sqlitePathFromUrl, type Settings } from '../core/settings.js'

export function createDatabase(settings: Settings) {
  const databasePath = sqlitePathFromUrl(settings.databaseUrl)
  mkdirSync(dirname(databasePath), { recursive: true })

  const sqlite = new DatabaseDriver(databasePath)
  sqlite.pragma('foreign_keys = ON')

  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
  })
}

export function jsonString(value: unknown) {
  return JSON.stringify(value)
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback
  }

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
