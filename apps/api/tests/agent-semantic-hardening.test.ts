import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const agentSrcRoot = join(apiRoot, 'src', 'agent')

const forbiddenProductionMarkers = [
  'DIRECT_EXACT_MESSAGES',
  'DOMAIN_GOAL_HINTS',
  'fallbackDirectAnswer',
  'INTERNAL_LABEL_PATTERNS',
  'aliasMatchScore',
  'matchedAliases',
  'aliasScore',
]

function collectSourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) return collectSourceFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

describe('Agent semantic runtime hardening audit', () => {
  it('keeps removed keyword and alias intent shortcuts out of production agent runtime', () => {
    const offenders = collectSourceFiles(agentSrcRoot).flatMap((path) => {
      const text = readFileSync(path, 'utf8')
      return forbiddenProductionMarkers
        .filter((marker) => text.includes(marker))
        .map((marker) => `${path.replace(apiRoot, '')}: ${marker}`)
    })

    expect(offenders).toEqual([])
  })
})
