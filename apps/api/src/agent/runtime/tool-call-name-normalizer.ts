function compactName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function nameCandidates(rawName: unknown, toolCallId?: unknown) {
  return [rawName, toolCallId]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .flatMap((value) => {
      const trimmed = value.trim()
      const withoutFunctionPrefix = trimmed.replace(/^(?:functions?|tools?)[./:_-]+/i, '')
      const withoutIndexSuffix = withoutFunctionPrefix.replace(/[./:_-]\d+$/u, '')
      const lastSegment = withoutIndexSuffix.split(/[./:]/u).at(-1) ?? withoutIndexSuffix
      return [trimmed, withoutFunctionPrefix, withoutIndexSuffix, lastSegment]
    })
}

export function repairToolName(rawName: unknown, allowedToolNames: readonly string[], toolCallId?: unknown) {
  const candidates = nameCandidates(rawName, toolCallId)

  for (const candidate of candidates) {
    const exact = allowedToolNames.find((name) => name === candidate)
    if (exact) return exact
  }

  const compactAllowed = new Map(allowedToolNames.map((name) => [compactName(name), name]))
  for (const candidate of candidates) {
    const match = compactAllowed.get(compactName(candidate))
    if (match) return match
  }

  for (const candidate of candidates) {
    const compactCandidate = compactName(candidate)
    const inferred = allowedToolNames.find((name) => compactCandidate.endsWith(compactName(name)))
    if (inferred) return inferred
  }

  return null
}
