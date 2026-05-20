const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /((?:api\s*key|apikey|token|secret|密码|验证码)\s*[:：=]?\s*)[^\s,，。；;]{4,}/gi,
]

export function redactSecretLikeContent(value: string) {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, (match, label?: string) => (typeof label === 'string' ? `${label}[redacted-secret]` : '[redacted-api-key]')),
    value,
  )
}

export function containsSecretLikeContent(value: string) {
  return redactSecretLikeContent(value) !== value || /(api\s*key|apikey|token|密码|验证码|secret)/i.test(value)
}

export function normalizeMemoryText(value: string, limit: number) {
  return redactSecretLikeContent(value).replace(/\s+/g, ' ').trim().slice(0, limit)
}
