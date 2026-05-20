// OpenClaw-inspired bounded JSON extraction boundary.
// Portions derived from OpenClaw design (MIT License):
// Source: https://github.com/openclaw/openclaw
// Original reference: src/shared/balanced-json.ts
// Copyright (c) 2025 Peter Steinberger

export type BalancedJsonResult = {
  jsonText: string
  startOffset: number
  endOffset: number
  leadingText: string
  trailingText: string
  complete: boolean
}

const OPEN_TO_CLOSE: Record<string, string> = {
  '{': '}',
  '[': ']',
}

function isOpener(value: string) {
  return value === '{' || value === '['
}

function isCloser(value: string) {
  return value === '}' || value === ']'
}

export function extractBalancedJson(raw: string): BalancedJsonResult | null {
  const stack: string[] = []
  let startOffset = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? ''

    if (startOffset < 0) {
      if (!isOpener(char)) continue
      startOffset = index
      stack.push(OPEN_TO_CLOSE[char] ?? '')
      continue
    }

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

    if (isOpener(char)) {
      stack.push(OPEN_TO_CLOSE[char] ?? '')
      continue
    }

    if (!isCloser(char)) continue
    const expected = stack.pop()
    if (expected !== char) return null
    if (stack.length === 0) {
      const endOffset = index + 1
      return {
        jsonText: raw.slice(startOffset, endOffset),
        startOffset,
        endOffset,
        leadingText: raw.slice(0, startOffset),
        trailingText: raw.slice(endOffset),
        complete: true,
      }
    }
  }

  if (startOffset < 0) return null
  return {
    jsonText: raw.slice(startOffset),
    startOffset,
    endOffset: raw.length,
    leadingText: raw.slice(0, startOffset),
    trailingText: '',
    complete: false,
  }
}
