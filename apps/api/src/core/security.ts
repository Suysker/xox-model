import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import { addDays } from './time.js'

export function newId() {
  return randomUUID()
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export async function hashPassword(password: string) {
  return argon2.hash(password)
}

function verifyLegacyScrypt(password: string, passwordHash: string) {
  const [prefix, salt, expected] = passwordHash.split('$')
  if (prefix !== 'scrypt' || !salt || !expected) {
    return false
  }

  const actual = scryptSync(password, salt, 64).toString('hex')
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

export async function verifyPassword(password: string, passwordHash: string) {
  try {
    if (passwordHash.startsWith('scrypt$')) {
      return verifyLegacyScrypt(password, passwordHash)
    }

    return await argon2.verify(passwordHash, password)
  } catch {
    return false
  }
}

export function issueSessionToken(ttlDays: number) {
  const token = randomBytes(48).toString('base64url')
  return {
    token,
    tokenHash: sha256(token),
    expiresAt: addDays(new Date(), ttlDays).toISOString(),
  }
}
