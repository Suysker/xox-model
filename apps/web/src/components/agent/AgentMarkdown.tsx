import type { MouseEvent } from 'react'
import { useMemo } from 'react'
import { splitStableMarkdownStreamSource, toSanitizedAgentMarkdownHtml } from '../../lib/agentMarkdown'

export function AgentMarkdown(props: { source: string; streaming?: boolean; className?: string }) {
  const source = props.source
  const streamParts = useMemo(
    () => props.streaming ? splitStableMarkdownStreamSource(source) : { stableSource: source, volatileTail: '' },
    [props.streaming, source],
  )
  const html = useMemo(() => toSanitizedAgentMarkdownHtml(streamParts.stableSource), [streamParts.stableSource])

  async function handleClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest<HTMLButtonElement>('.agent-code-copy')
    if (!button) return
    const block = button.closest('.agent-code-block')
    const code = block?.querySelector('code')?.textContent ?? ''
    if (!code) return
    try {
      await navigator.clipboard?.writeText(code)
      const previous = button.textContent
      button.textContent = '已复制'
      window.setTimeout(() => {
        button.textContent = previous ?? '复制'
      }, 1200)
    } catch {
      // Copy is a convenience; rendering should not fail if Clipboard API is unavailable.
    }
  }

  return (
    <div
      className={['agent-markdown max-w-[92%] break-words text-sm leading-5 text-stone-800', props.className ?? ''].filter(Boolean).join(' ')}
      onClick={handleClick}
    >
      {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : null}
      {streamParts.volatileTail ? (
        <span className="agent-markdown-stream-tail whitespace-pre-wrap text-stone-600">
          {streamParts.volatileTail}
        </span>
      ) : null}
    </div>
  )
}
