import { useEffect, useState } from 'react'
import type { AgentTranscriptNode } from '../lib/api'

// OpenClaw-inspired expansion ownership: expansion state is UI/session state,
// separate from the server-owned transcript data and scoped by thread/run/node.

function nodeExpansionKey(node: AgentTranscriptNode) {
  return `${node.threadId}:${node.runId ?? 'no-run'}:${node.id}`
}

function sectionExpansionKey(node: AgentTranscriptNode, sectionId: string) {
  return `${nodeExpansionKey(node)}:${sectionId}`
}

function collectDefaultExpansion(nodes: AgentTranscriptNode[], target: Map<string, boolean>) {
  for (const node of nodes) {
    target.set(nodeExpansionKey(node), Boolean(node.defaultOpen ?? node.disclosure?.defaultOpen))
    for (const section of node.sections ?? []) {
      target.set(sectionExpansionKey(node, section.id), section.defaultOpen)
    }
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

  function isSectionExpanded(node: AgentTranscriptNode, sectionId: string) {
    const section = node.sections?.find((item) => item.id === sectionId)
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
    const section = node.sections?.find((item) => item.id === sectionId)
    setExpanded((current) => {
      const next = new Map(current)
      next.set(key, !(next.get(key) ?? Boolean(section?.defaultOpen)))
      return next
    })
  }

  return { isNodeExpanded, isSectionExpanded, toggleNode, toggleSection }
}
