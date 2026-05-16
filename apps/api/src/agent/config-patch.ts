import { hydrateModelConfig, type ModelConfig } from '@xox/domain'
import { unprocessable } from '../core/http.js'

export function cloneModelConfig(config: ModelConfig) {
  return hydrateModelConfig(JSON.parse(JSON.stringify(config)) as unknown)
}

export function configPathSegments(path: string) {
  return path
    .replace(/^config\./, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
}

export function getConfigPath(root: unknown, path: string) {
  let current = root as any
  for (const segment of configPathSegments(path)) {
    if (current == null) return undefined
    current = current[segment]
  }
  return current
}

export function setConfigPath(root: unknown, path: string, value: unknown) {
  const segments = configPathSegments(path)
  if (segments.length === 0) throw unprocessable('Patch path is required')
  let current = root as any
  for (const segment of segments.slice(0, -1)) {
    if (current == null || !(segment in current)) throw unprocessable(`Patch path not found: ${path}`)
    current = current[segment]
  }
  const last = segments.at(-1)!
  if (current == null || !(last in current)) throw unprocessable(`Patch path not found: ${path}`)
  current[last] = value
}
