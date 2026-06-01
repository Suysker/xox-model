import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const promptCache = new Map<string, string>()

function readPrompt(relativePath: string) {
  const cached = promptCache.get(relativePath)
  if (cached) return cached
  const path = fileURLToPath(new URL(relativePath, import.meta.url))
  const prompt = readFileSync(path, 'utf8').trim()
  promptCache.set(relativePath, prompt)
  return prompt
}

export function plannerSystemPrompt() {
  return readPrompt('./prompts/planner.system.md')
}

export function memorySystemPrompt() {
  return readPrompt('./prompts/memory.system.md')
}

export function toolObservationFinalizerSystemPrompt() {
  return readPrompt('./prompts/tool-observation-finalizer.system.md')
}

export function directAnswerSystemPrompt() {
  return readPrompt('./prompts/direct-answer.system.md')
}

export function turnLaneSystemPrompt() {
  return readPrompt('./prompts/turn-lane.system.md')
}
