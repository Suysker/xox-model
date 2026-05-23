import { useEffect, useState } from 'react'
import type { AgentTranscriptNode, AgentTranscriptSection } from '../lib/api'

// OpenClaw-inspired expansion ownership: expansion state is UI/session state,
// separate from the server-owned transcript data and scoped by thread/run/node.

function nodeExpansionKey(node: AgentTranscriptNode) {
  return `${node.threadId}:${node.runId ?? 'no-run'}:${node.id}`
}

function sectionExpansionKey(node: AgentTranscriptNode, sectionId: string) {
  return `${nodeExpansionKey(node)}:${sectionId}`
}

function collectSectionDefaultExpansion(node: AgentTranscriptNode, sections: AgentTranscriptSection[], target: Map<string, boolean>) {
  for (const section of sections) {
    target.set(sectionExpansionKey(node, section.id), section.defaultOpen)
    if (section.children?.length) {
      collectSectionDefaultExpansion(node, section.children, target)
    }
  }
}

function collectDefaultExpansion(nodes: AgentTranscriptNode[], target: Map<string, boolean>) {
  for (const node of nodes) {
    target.set(nodeExpansionKey(node), Boolean(node.defaultOpen ?? node.disclosure?.defaultOpen))
    collectSectionDefaultExpansion(node, node.sections ?? [], target)
    collectDefaultExpansion(node.children ?? [], target)
  }
}

export function useAgentTranscriptExpansion(nodes: AgentTranscriptNode[]) {
  const [expanded, setExpanded] = useState(() => new Map<string, boolean>())

  useEffect(() => {
    setExpanded((current) => {
      const next = new Map(current)
      const defaults = new Map<string, boolean>()
      collectDefaultExpansion(nodes, defaults)
      for (const [key, value] of defaults) {
        if (!next.has(key)) next.set(key, value)
      }
      for (const key of next.keys()) {
        if (!defaults.has(key)) next.delete(key)
      }
      return next
    })
  }, [nodes])

  function isNodeExpanded(node: AgentTranscriptNode) {
    return expanded.get(nodeExpansionKey(node)) ?? Boolean(node.defaultOpen ?? node.disclosure?.defaultOpen)
  }

  function findSection(sections: AgentTranscriptSection[], sectionId: string): AgentTranscriptSection | null {
    for (const section of sections) {
      if (section.id === sectionId) return section
      const child = findSection(section.children ?? [], sectionId)
      if (child) return child
    }
    return null
  }

  function isSectionExpanded(node: AgentTranscriptNode, sectionId: string) {
    const section = findSection(node.sections ?? [], sectionId)
    return expanded.get(sectionExpansionKey(node, sectionId)) ?? Boolean(section?.defaultOpen)
  }

  function toggleNode(node: AgentTranscriptNode) {
    const key = nodeExpansionKey(node)
    setExpanded((current) => {
      const next = new Map(current)
      next.set(key, !(next.get(key) ?? Boolean(node.defaultOpen ?? node.disclosure?.defaultOpen)))
      return next
    })
  }

  function toggleSection(node: AgentTranscriptNode, sectionId: string) {
    const key = sectionExpansionKey(node, sectionId)
    const section = findSection(node.sections ?? [], sectionId)
    setExpanded((current) => {
      const next = new Map(current)
      next.set(key, !(next.get(key) ?? Boolean(section?.defaultOpen)))
      return next
    })
  }

  return { isNodeExpanded, isSectionExpanded, toggleNode, toggleSection }
}
