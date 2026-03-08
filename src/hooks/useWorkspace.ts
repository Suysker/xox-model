import { useEffect, useState } from 'react'
import { createProductDefaultModel } from '../lib/defaults'
import {
  SCHEMA_VERSION,
  cloneConfig,
  createSnapshot,
  loadWorkspaceBundle,
  saveWorkspaceBundle,
} from '../lib/storage'
import type { ModelConfig, WorkspaceBundle, WorkspaceSnapshotKind } from '../types'

const defaultWorkspaceName = '地下偶像 ROI 工作区'

function formatTimestamp(date = new Date()) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  const hours = `${date.getHours()}`.padStart(2, '0')
  const minutes = `${date.getMinutes()}`.padStart(2, '0')

  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function createDefaultBundle(): WorkspaceBundle {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceName: defaultWorkspaceName,
    currentConfig: createProductDefaultModel(),
    snapshots: [],
    lastSavedAt: null,
  }
}

export function useWorkspace() {
  const [bundle, setBundle] = useState<WorkspaceBundle>(() => loadWorkspaceBundle() ?? createDefaultBundle())

  useEffect(() => {
    saveWorkspaceBundle(bundle)
  }, [bundle])

  function setWorkspaceName(workspaceName: string) {
    setBundle((current) => ({
      ...current,
      workspaceName,
    }))
  }

  function setConfig(nextConfig: ModelConfig | ((current: ModelConfig) => ModelConfig)) {
    setBundle((current) => ({
      ...current,
      currentConfig:
        typeof nextConfig === 'function'
          ? cloneConfig(nextConfig(current.currentConfig))
          : cloneConfig(nextConfig),
    }))
  }

  function saveCurrentSnapshot(kind: WorkspaceSnapshotKind) {
    setBundle((current) => {
      const suffix = kind === 'release' ? '发布版' : '快照'
      const snapshot = createSnapshot(
        current.currentConfig,
        `${current.workspaceName} ${suffix} ${formatTimestamp()}`,
        kind,
      )

      return {
        ...current,
        snapshots: [snapshot, ...current.snapshots],
        lastSavedAt: snapshot.createdAt,
      }
    })
  }

  function loadSnapshot(id: string) {
    setBundle((current) => {
      const snapshot = current.snapshots.find((item) => item.id === id)

      if (!snapshot) {
        return current
      }

      return {
        ...current,
        currentConfig: cloneConfig(snapshot.config),
      }
    })
  }

  function deleteSnapshot(id: string) {
    setBundle((current) => ({
      ...current,
      snapshots: current.snapshots.filter((snapshot) => snapshot.id !== id),
    }))
  }

  function promoteSnapshotToRelease(id: string) {
    setBundle((current) => {
      const snapshot = current.snapshots.find((item) => item.id === id)

      if (!snapshot) {
        return current
      }

      const release = createSnapshot(
        snapshot.config,
        `${snapshot.name} 发布版 ${formatTimestamp()}`,
        'release',
      )

      return {
        ...current,
        snapshots: [release, ...current.snapshots],
        lastSavedAt: release.createdAt,
      }
    })
  }

  function importBundle(nextBundle: WorkspaceBundle) {
    setBundle({
      ...nextBundle,
      currentConfig: cloneConfig(nextBundle.currentConfig),
      snapshots: nextBundle.snapshots.map((snapshot) => ({
        ...snapshot,
        config: cloneConfig(snapshot.config),
      })),
    })
  }

  function resetWorkspace() {
    setBundle(createDefaultBundle())
  }

  return {
    bundle,
    workspaceName: bundle.workspaceName,
    config: bundle.currentConfig,
    snapshots: bundle.snapshots,
    lastSavedAt: bundle.lastSavedAt,
    setWorkspaceName,
    setConfig,
    saveSnapshot: () => saveCurrentSnapshot('snapshot'),
    publishRelease: () => saveCurrentSnapshot('release'),
    loadSnapshot,
    deleteSnapshot,
    promoteSnapshotToRelease,
    importBundle,
    resetWorkspace,
  }
}
