import type { ModelConfig, WorkspaceBundle, WorkspaceSnapshot, WorkspaceSnapshotKind } from '../types'

export const STORAGE_KEY = 'xox-model-workspace-v1'
export const SCHEMA_VERSION = 1

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function cloneConfig(config: ModelConfig): ModelConfig {
  return JSON.parse(JSON.stringify(config)) as ModelConfig
}

export function createSnapshot(
  config: ModelConfig,
  name: string,
  kind: WorkspaceSnapshotKind,
): WorkspaceSnapshot {
  return {
    id: createId(kind),
    name,
    createdAt: new Date().toISOString(),
    kind,
    config: cloneConfig(config),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isValidModelConfig(value: unknown): value is ModelConfig {
  if (!isObject(value)) {
    return false
  }

  return Array.isArray(value.teamMembers) && Array.isArray(value.months) && isObject(value.operating)
}

function isValidSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!isObject(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.kind === 'snapshot' || value.kind === 'release') &&
    isValidModelConfig(value.config)
  )
}

export function parseWorkspaceBundle(raw: string): WorkspaceBundle | null {
  try {
    const data: unknown = JSON.parse(raw)

    if (!isObject(data)) {
      return null
    }

    if (
      typeof data.schemaVersion !== 'number' ||
      typeof data.workspaceName !== 'string' ||
      !isValidModelConfig(data.currentConfig) ||
      !Array.isArray(data.snapshots) ||
      !data.snapshots.every(isValidSnapshot)
    ) {
      return null
    }

    return {
      schemaVersion: data.schemaVersion,
      workspaceName: data.workspaceName,
      currentConfig: cloneConfig(data.currentConfig),
      snapshots: data.snapshots.map((snapshot) => ({
        ...snapshot,
        config: cloneConfig(snapshot.config),
      })),
      lastSavedAt: typeof data.lastSavedAt === 'string' ? data.lastSavedAt : null,
    }
  } catch {
    return null
  }
}

export function loadWorkspaceBundle(): WorkspaceBundle | null {
  if (typeof window === 'undefined') {
    return null
  }

  const raw = window.localStorage.getItem(STORAGE_KEY)

  if (!raw) {
    return null
  }

  return parseWorkspaceBundle(raw)
}

export function saveWorkspaceBundle(bundle: WorkspaceBundle) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bundle))
}

export function serializeWorkspaceBundle(bundle: WorkspaceBundle) {
  return JSON.stringify(bundle, null, 2)
}
