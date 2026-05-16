import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Settings } from '../core/settings.js'

const ENCRYPTED_PREFIX = 'enc:v1'

function base64UrlEncode(value: Buffer) {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlDecode(value: string) {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  return Buffer.from(padded.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

function encryptionKey(settings: Settings) {
  const secret = settings.agentProviderKeyEncryptionSecret?.trim()
  if (!secret) return null
  return createHash('sha256').update(secret).digest()
}

export function isEncryptedProviderApiKey(value: string) {
  return value.startsWith(`${ENCRYPTED_PREFIX}:`)
}

export function encryptProviderApiKey(settings: Settings, apiKey: string) {
  const key = encryptionKey(settings)
  if (!key) return apiKey

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [ENCRYPTED_PREFIX, base64UrlEncode(iv), base64UrlEncode(tag), base64UrlEncode(encrypted)].join(':')
}

export function decryptProviderApiKey(settings: Settings, storedApiKey: string) {
  if (!isEncryptedProviderApiKey(storedApiKey)) return storedApiKey

  const key = encryptionKey(settings)
  if (!key) {
    throw new Error('AGENT_PROVIDER_KEY_ENCRYPTION_SECRET is required to decrypt provider settings')
  }

  const [, version, encodedIv, encodedTag, encodedCiphertext] = storedApiKey.split(':')
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error('Provider API key ciphertext is invalid')
  }

  const decipher = createDecipheriv('aes-256-gcm', key, base64UrlDecode(encodedIv))
  decipher.setAuthTag(base64UrlDecode(encodedTag))
  return Buffer.concat([
    decipher.update(base64UrlDecode(encodedCiphertext)),
    decipher.final(),
  ]).toString('utf8')
}
