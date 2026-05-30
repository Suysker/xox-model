/**
 * OpenClaw-derived memory budget helpers.
 *
 * Source inspiration: C:\Github\openclaw\extensions\memory-core\src\memory-budget.ts
 * OpenClaw is MIT licensed. This local module keeps only pure budgeting logic
 * and adapts it from filesystem MEMORY.md sections to SaaS memory blocks.
 */

const PROMOTION_SECTION_HEADING_RE = /^## Promoted From Short-Term Memory \(([^)]+)\)\s*$/
export const DEFAULT_DURABLE_MEMORY_MAX_CHARS = 10_000
const WRITE_OVERHEAD_RESERVE = 21

type MemoryBlock =
  | { kind: 'preserved'; text: string }
  | { kind: 'promotion'; date: string; text: string }

function parseMemoryBlocks(content: string): MemoryBlock[] {
  if (content.length === 0) return []
  const lines = content.split(/\r?\n/)
  const blocks: MemoryBlock[] = []
  let currentLines: string[] = []
  let currentKind: 'preserved' | 'promotion' = 'preserved'
  let currentDate: string | undefined

  const flush = () => {
    if (currentLines.length === 0) return
    const text = currentLines.join('\n')
    if (currentKind === 'promotion' && currentDate) {
      blocks.push({ kind: 'promotion', date: currentDate, text })
    } else {
      blocks.push({ kind: 'preserved', text })
    }
    currentLines = []
    currentKind = 'preserved'
    currentDate = undefined
  }

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush()
      const match = PROMOTION_SECTION_HEADING_RE.exec(line)
      if (match?.[1]) {
        currentKind = 'promotion'
        currentDate = match[1]
      } else {
        currentKind = 'preserved'
      }
      currentLines = [line]
    } else {
      currentLines.push(line)
    }
  }
  flush()
  return blocks
}

function joinBlocks(blocks: MemoryBlock[]) {
  return blocks.map((block) => block.text).join('\n')
}

export type CompactMemoryParams = {
  existingMemory: string
  newSection: string
  budgetChars: number
}

export type CompactMemoryResult = {
  compacted: string
  droppedDates: string[]
}

export function compactMemoryForBudget(params: CompactMemoryParams): CompactMemoryResult {
  const { existingMemory, newSection, budgetChars } = params
  if (budgetChars <= 0) return { compacted: existingMemory, droppedDates: [] }

  const effectiveBudget = Math.max(0, budgetChars - WRITE_OVERHEAD_RESERVE)
  if (existingMemory.length + newSection.length <= effectiveBudget) {
    return { compacted: existingMemory, droppedDates: [] }
  }

  const blocks = parseMemoryBlocks(existingMemory)
  const promotionEntries = blocks
    .map((block, index) => (block.kind === 'promotion' ? { index, date: block.date, length: block.text.length } : null))
    .filter((entry): entry is { index: number; date: string; length: number } => entry !== null)
    .toSorted((left, right) => left.date.localeCompare(right.date))

  if (promotionEntries.length === 0) return { compacted: existingMemory, droppedDates: [] }

  const droppedIndices = new Set<number>()
  const droppedDates: string[] = []
  let projectedExistingSize = existingMemory.length
  const blockSeparatorCost = blocks.length > 1 ? 1 : 0

  for (const entry of promotionEntries) {
    if (projectedExistingSize + newSection.length <= effectiveBudget) break
    droppedIndices.add(entry.index)
    droppedDates.push(entry.date)
    projectedExistingSize = Math.max(0, projectedExistingSize - entry.length - blockSeparatorCost)
  }

  if (droppedIndices.size === 0) return { compacted: existingMemory, droppedDates: [] }
  return { compacted: joinBlocks(blocks.filter((_, index) => !droppedIndices.has(index))), droppedDates }
}

export type BudgetedMemoryItem<T> = T & {
  text: string
}

export function takeBudgetedMemoryItems<T>(items: Array<BudgetedMemoryItem<T>>, maxChars: number) {
  if (maxChars <= 0) return { items: [] as Array<BudgetedMemoryItem<T>>, usedChars: 0 }
  const selected: Array<BudgetedMemoryItem<T>> = []
  let usedChars = 0
  for (const item of items) {
    const nextChars = item.text.length
    if (selected.length > 0 && usedChars + nextChars > maxChars) continue
    if (selected.length === 0 && nextChars > maxChars) {
      selected.push({ ...item, text: item.text.slice(0, maxChars).trimEnd() })
      usedChars = selected[0]?.text.length ?? 0
      break
    }
    selected.push(item)
    usedChars += nextChars
  }
  return { items: selected, usedChars }
}
