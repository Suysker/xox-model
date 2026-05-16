export function utcNow() {
  return new Date().toISOString()
}

export function addDays(value: Date, days: number) {
  const next = new Date(value)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}
