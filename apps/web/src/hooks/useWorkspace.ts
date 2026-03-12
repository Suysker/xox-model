import { useEffect, useMemo, useRef, useState } from 'react'
import { createProductDefaultModel } from '../lib/defaults'
import { api, type DraftResponse, type VersionResponse, type VersionShareResponse } from '../lib/api'
import { SCHEMA_VERSION, cloneConfig } from '../lib/storage'
import type { ModelConfig, WorkspaceBundle, WorkspaceSnapshot } from '../types'

const defaultWorkspaceName = 'Forecast Workspace'

function createLocalBundle(config = createProductDefaultModel()): WorkspaceBundle {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceName: defaultWorkspaceName,
    currentConfig: config,
    snapshots: [],
    lastSavedAt: null,
  }
}

function toSnapshot(version: VersionResponse): WorkspaceSnapshot {
  return {
    id: version.id,
    name: version.name,
    createdAt: version.createdAt,
    kind: version.kind,
    config: cloneConfig(version.config),
  }
}

export function useWorkspace(enabled = true) {
  const [workspaceName, setWorkspaceNameState] = useState(defaultWorkspaceName)
  const [config, setConfigState] = useState<ModelConfig>(createProductDefaultModel())
  const [snapshots, setSnapshots] = useState<WorkspaceSnapshot[]>([])
  const [versionShares, setVersionShares] = useState<Record<string, VersionShareResponse | null>>({})
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const dirtyRef = useRef(false)
  const loadedRef = useRef(false)

  function applyVersions(versions: VersionResponse[]) {
    setSnapshots(versions.map((version) => toSnapshot(version)))
    setVersionShares(
      Object.fromEntries(versions.map((version) => [version.id, version.activeShare ?? null])) satisfies Record<
        string,
        VersionShareResponse | null
      >,
    )
  }

  async function refreshVersions() {
    const versions = await api.listVersions()
    applyVersions(versions)
  }

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }

    let active = true

    async function load() {
      setLoading(true)
      try {
        const [draft, versions] = await Promise.all([api.getDraft(), api.listVersions()])
        if (!active) {
          return
        }
        setWorkspaceNameState(draft.workspaceName)
        setConfigState(cloneConfig(draft.config))
        setLastSavedAt(draft.lastAutosavedAt)
        setRevision(draft.revision)
        applyVersions(versions)
        setError(null)
        loadedRef.current = true
        dirtyRef.current = false
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      active = false
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || !loadedRef.current || !dirtyRef.current) {
      return
    }

    const timeoutId = window.setTimeout(async () => {
      try {
        const draft = await api.saveDraft({
          revision,
          workspaceName,
          config,
        })
        setRevision(draft.revision)
        setLastSavedAt(draft.lastAutosavedAt)
        setError(null)
        dirtyRef.current = false
        await refreshVersions()
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : String(saveError))
      }
    }, 900)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [enabled, config, revision, workspaceName])

  function setWorkspaceName(nextWorkspaceName: string) {
    setWorkspaceNameState(nextWorkspaceName)
    dirtyRef.current = true
  }

  function setConfig(nextConfig: ModelConfig | ((current: ModelConfig) => ModelConfig)) {
    setConfigState((current) => {
      const resolved = typeof nextConfig === 'function' ? nextConfig(current) : nextConfig
      return cloneConfig(resolved)
    })
    dirtyRef.current = true
  }

  async function persistDraft(nextWorkspaceName: string, nextConfig: ModelConfig) {
    const draft = await api.saveDraft({
      revision,
      workspaceName: nextWorkspaceName,
      config: nextConfig,
    })
    return applyDraftResponse(draft)
  }

  async function flushDirtyDraft() {
    if (!loadedRef.current || !dirtyRef.current) {
      return null
    }

    return persistDraft(workspaceName, config)
  }

  async function applyDraftResponse(draft: DraftResponse) {
    setWorkspaceNameState(draft.workspaceName)
    setConfigState(cloneConfig(draft.config))
    setLastSavedAt(draft.lastAutosavedAt)
    setRevision(draft.revision)
    dirtyRef.current = false
    await refreshVersions()
    return draft
  }

  async function saveSnapshot() {
    await flushDirtyDraft()
    await api.createVersion({ kind: 'snapshot' })
    await refreshVersions()
  }

  async function publishRelease() {
    await flushDirtyDraft()
    await api.createVersion({ kind: 'release' })
    await refreshVersions()
  }

  async function loadSnapshot(id: string) {
    const draft = await api.rollbackVersion(id)
    return applyDraftResponse(draft)
  }

  async function deleteSnapshot(id: string) {
    await api.deleteVersion(id)
    await refreshVersions()
  }

  async function promoteSnapshotToRelease(id: string) {
    const draft = await api.rollbackVersion(id)
    await applyDraftResponse(draft)
    await api.createVersion({ kind: 'release' })
    await refreshVersions()
  }

  async function importBundle(nextBundle: WorkspaceBundle) {
    await persistDraft(nextBundle.workspaceName, cloneConfig(nextBundle.currentConfig))
  }

  async function resetWorkspace() {
    await persistDraft(defaultWorkspaceName, createProductDefaultModel())
  }

  const bundle = useMemo(
    () =>
      ({
        schemaVersion: SCHEMA_VERSION,
        workspaceName,
        currentConfig: cloneConfig(config),
        snapshots,
        lastSavedAt,
      }) satisfies WorkspaceBundle,
    [config, lastSavedAt, snapshots, workspaceName],
  )

  return {
    bundle,
    workspaceName,
    config,
    snapshots,
    versionShares,
    lastSavedAt,
    loading,
    error,
    setWorkspaceName,
    setConfig,
    saveSnapshot,
    publishRelease,
    loadSnapshot,
    deleteSnapshot,
    promoteSnapshotToRelease,
    createShareLink: async (versionId: string) => {
      await api.createVersionShare(versionId)
      await refreshVersions()
    },
    revokeShareLink: async (versionId: string) => {
      await api.revokeVersionShare(versionId)
      await refreshVersions()
    },
    importBundle,
    resetWorkspace,
  }
}
