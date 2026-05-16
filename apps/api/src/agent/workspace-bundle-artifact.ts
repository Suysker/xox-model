type RecordValue = Record<string, unknown>

export type ParsedWorkspaceBundleArtifact = {
  bundle: {
    schemaVersion?: unknown
    workspaceName: string
    currentConfig: unknown
    snapshots?: unknown
    lastSavedAt?: unknown
  }
  messageForModel: string
  summary: {
    workspaceName: string
    snapshotsCount: number
  }
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function maybeWorkspaceBundle(value: unknown): ParsedWorkspaceBundleArtifact['bundle'] | null {
  if (!isRecord(value) || typeof value.workspaceName !== 'string' || !('currentConfig' in value)) return null
  return {
    schemaVersion: value.schemaVersion,
    workspaceName: value.workspaceName,
    currentConfig: value.currentConfig,
    snapshots: value.snapshots,
    lastSavedAt: value.lastSavedAt,
  }
}

function jsonObjectSpans(input: string) {
  const spans: Array<{ start: number; end: number }> = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        spans.push({ start, end: index + 1 })
        start = -1
      }
    }
  }

  return spans
}

export function extractWorkspaceBundleArtifact(message: string): ParsedWorkspaceBundleArtifact | null {
  for (const span of jsonObjectSpans(message)) {
    const raw = message.slice(span.start, span.end)
    try {
      const bundle = maybeWorkspaceBundle(JSON.parse(raw))
      if (!bundle) continue
      const snapshotsCount = Array.isArray(bundle.snapshots) ? bundle.snapshots.length : 0
      const placeholder = `[WorkspaceBundle JSON artifact parsed by server: workspaceName="${bundle.workspaceName}", snapshots=${snapshotsCount}. Use workspace_import_bundle with useProvidedBundle=true; do not copy the JSON.]`
      return {
        bundle,
        messageForModel: `${message.slice(0, span.start)}${placeholder}${message.slice(span.end)}`,
        summary: {
          workspaceName: bundle.workspaceName,
          snapshotsCount,
        },
      }
    } catch {
      continue
    }
  }
  return null
}
