import type { RuntimePlanError } from './runtime-adapter.js'

export function safeProviderErrorMessage(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer ***')
    .slice(0, 500)
}

export function providerRejectsToolChoice(statusCode: number, providerMessage: string) {
  const normalized = providerMessage.toLowerCase()
  return statusCode === 400 &&
    normalized.includes('tool_choice') &&
    (normalized.includes('does not support') || normalized.includes('not support') || normalized.includes('unsupported'))
}

export function classifyProviderHttpError(statusCode: number, providerMessage: string): RuntimePlanError {
  const message = safeProviderErrorMessage(providerMessage)
  const normalized = message.toLowerCase()
  const classification =
    providerRejectsToolChoice(statusCode, message)
      ? 'unsupported_parameter'
      : statusCode === 401 || statusCode === 403 || normalized.includes('invalid api key') || normalized.includes('unauthorized')
        ? 'auth'
        : statusCode === 402 || normalized.includes('insufficient') || normalized.includes('billing') || normalized.includes('credit')
          ? 'billing'
          : statusCode === 429 || normalized.includes('rate limit') || normalized.includes('quota') || normalized.includes('too many')
            ? 'rate_limit'
            : normalized.includes('context') && normalized.includes('length')
              ? 'context_overflow'
              : statusCode >= 500
                ? 'server'
                : 'http'
  return {
    kind: 'provider_http_error',
    statusCode,
    message,
    classification,
  }
}
