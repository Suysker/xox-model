export function objectHasKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false
  if (Object.hasOwn(value, key)) return true
  if (Array.isArray(value)) return value.some((item) => objectHasKey(item, key))
  return Object.values(value as Record<string, unknown>).some((item) => objectHasKey(item, key))
}
