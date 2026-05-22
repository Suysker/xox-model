// Portions adapted from OpenClaw (MIT License)
// Source: https://github.com/openclaw/openclaw/blob/main/ui/src/ui/markdown.ts
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import MarkdownIt from 'markdown-it'
import markdownItTaskLists from 'markdown-it-task-lists'

const ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'button',
  'code',
  'del',
  'details',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
  'i',
  'input',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'summary',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]

const ALLOWED_ATTR = [
  'aria-label',
  'checked',
  'class',
  'disabled',
  'href',
  'rel',
  'start',
  'target',
  'title',
  'type',
]

const MARKDOWN_CHAR_LIMIT = 140_000
const MARKDOWN_PARSE_LIMIT = 40_000
const MARKDOWN_CACHE_LIMIT = 200
const MARKDOWN_CACHE_MAX_CHARS = 50_000
const CJK_RE = /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60]/

const markdownCache = new Map<string, string>()

let hooksInstalled = false

for (const [language, definition, aliases] of [
  ['bash', bash, ['sh', 'shell']],
  ['css', css, []],
  ['diff', diff, ['patch']],
  ['javascript', javascript, ['js', 'jsx']],
  ['json', json, []],
  ['markdown', markdown, ['md']],
  ['python', python, ['py']],
  ['typescript', typescript, ['ts', 'tsx']],
  ['xml', xml, ['html', 'svg']],
  ['yaml', yaml, ['yml']],
] as const) {
  hljs.registerLanguage(language, definition)
  if (aliases.length > 0) {
    hljs.registerAliases([...aliases], { languageName: language })
  }
}

const autoHighlightLanguages = [
  'bash',
  'css',
  'diff',
  'javascript',
  'json',
  'markdown',
  'python',
  'typescript',
  'xml',
  'yaml',
]

export const agentMarkdown = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
})

agentMarkdown.enable('strikethrough')
agentMarkdown.linkify.set({ fuzzyLink: false })
agentMarkdown.linkify.add('www', {
  validate(text, pos) {
    const tail = text.slice(pos)
    const match = tail.match(/^\.(?:[a-zA-Z0-9-]+\.?)+[^\s<\u2E80-\u2FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60]*/)
    if (!match) return 0
    let len = match[0].length
    const balancePairs: Record<string, string> = {
      ')': '(',
      ']': '[',
      '}': '{',
      '"': '"',
      "'": "'",
    }
    const balance: Record<string, number> = {}
    for (const [close, open] of Object.entries(balancePairs)) {
      balance[close] = 0
      for (let i = 0; i < len; i += 1) {
        const char = tail[i]
        if (open === close) {
          if (char === open) balance[close] = balance[close] === 0 ? 1 : 0
        } else if (char === open) {
          balance[close] += 1
        } else if (char === close) {
          balance[close] -= 1
        }
      }
    }

    while (len > 0) {
      const char = tail[len - 1]
      if (/[?!.,:*_~]/.test(char ?? '')) {
        len -= 1
        continue
      }
      if (char === ';') {
        let cursor = len - 2
        while (cursor >= 0 && /[a-zA-Z0-9]/.test(tail[cursor] ?? '')) cursor -= 1
        if (cursor >= 0 && tail[cursor] === '&' && cursor < len - 2) {
          len = cursor
          continue
        }
        break
      }
      const close = char ?? ''
      const open = balancePairs[close]
      if (open !== undefined) {
        if (open === close) {
          if (balance[close] !== 0) {
            balance[close] = 0
            len -= 1
            continue
          }
        } else if ((balance[close] ?? 0) < 0) {
          balance[close] = (balance[close] ?? 0) + 1
          len -= 1
          continue
        }
      }
      break
    }
    return len
  },
  normalize(match) {
    match.url = `http://${match.url}`
  },
})

agentMarkdown.validateLink = () => true

agentMarkdown.core.ruler.after('linkify', 'xox-linkify-cjk-trim', (state) => {
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline' || !blockToken.children) continue
    const children = blockToken.children
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const token = children[index]
      if (token?.type !== 'link_open' || token.markup !== 'linkify') continue
      const textToken = children[index + 1]
      if (!textToken || textToken.type !== 'text') continue
      const displayText = textToken.content
      let cjkIndex = displayText.length
      while (cjkIndex > 0 && CJK_RE.test(displayText[cjkIndex - 1] ?? '')) cjkIndex -= 1
      if (cjkIndex <= 0 || cjkIndex === displayText.length) continue
      const trimmedDisplay = displayText.slice(0, cjkIndex)
      const cjkTail = displayText.slice(cjkIndex)
      const href = token.attrGet('href') ?? ''
      const prefixIndex = href.indexOf(displayText)
      token.attrSet('href', `${prefixIndex > 0 ? href.slice(0, prefixIndex) : ''}${trimmedDisplay}`)
      textToken.content = trimmedDisplay
      for (let closeIndex = index + 1; closeIndex < children.length; closeIndex += 1) {
        if (children[closeIndex]?.type !== 'link_close') continue
        const tailToken = new state.Token('text', '', 0)
        tailToken.content = cjkTail
        children.splice(closeIndex + 1, 0, tailToken)
        break
      }
    }
  }
})

agentMarkdown.use(markdownItTaskLists, { enabled: false, label: false })

agentMarkdown.core.ruler.after('github-task-lists', 'xox-task-list-allowlist', (state) => {
  const tokens = state.tokens
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token?.type !== 'inline' || !token.children) continue
    if (tokens[index - 1]?.type !== 'paragraph_open') continue
    const listItem = tokens[index - 2]
    if (listItem?.type !== 'list_item_open') continue
    const className = listItem.attrGet('class') ?? ''
    if (!className.includes('task-list-item')) continue
    for (const child of token.children) {
      if (child.type === 'html_inline' && /^<input\s/i.test(child.content)) {
        child.meta = { ...(child.meta ?? {}), xoxTaskListPlugin: true }
        break
      }
    }
  }
})

agentMarkdown.renderer.rules.html_block = (tokens, index) => `${escapeRawHtmlToken(tokens[index]?.content ?? '')}\n`
agentMarkdown.renderer.rules.html_inline = (tokens, index) => {
  const token = tokens[index]
  if (token?.meta?.xoxTaskListPlugin === true) return token.content
  return escapeRawHtmlToken(token?.content ?? '')
}

agentMarkdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]
  return escapeHtml(normalizeMarkdownImageLabel(token?.content))
}

agentMarkdown.renderer.rules.fence = (tokens, index) => renderCodeBlock(tokens[index]?.content ?? '', tokens[index]?.info ?? '')
agentMarkdown.renderer.rules.code_block = (tokens, index) => renderCodeBlock(tokens[index]?.content ?? '', '')

export function toSanitizedAgentMarkdownHtml(markdown: string): string {
  const input = markdown.trim()
  if (!input) return ''
  if (!DOMPurify.isSupported) {
    return renderEscapedPlainTextHtml(input)
  }
  installHooks()
  const cacheKey = input
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
    const cached = getCachedMarkdown(cacheKey)
    if (cached !== null) return cached
  }

  const truncated = truncateText(input, MARKDOWN_CHAR_LIMIT)
  const source = `${truncated.text}${truncated.truncated ? `\n\n... truncated (${truncated.total} chars, showing first ${truncated.text.length}).` : ''}`
  if (source.length > MARKDOWN_PARSE_LIMIT) {
    return cacheMarkdown(cacheKey, renderEscapedPlainTextHtml(source), input.length)
  }

  let rendered: string
  try {
    rendered = agentMarkdown.render(source)
  } catch {
    rendered = renderEscapedPlainTextHtml(source)
  }
  const sanitized = DOMPurify.sanitize(rendered, {
    ALLOWED_ATTR,
    ALLOWED_TAGS,
  })
  return cacheMarkdown(cacheKey, sanitized, input.length)
}

export function splitStableMarkdownStreamSource(source: string): { stableSource: string; volatileTail: string } {
  const lastNewline = source.lastIndexOf('\n')
  if (lastNewline < 0) {
    return { stableSource: '', volatileTail: source }
  }
  let stableEnd = lastNewline + 1
  const stableCandidate = source.slice(0, stableEnd)
  const fenceMatches = Array.from(stableCandidate.matchAll(/^(```|~~~)/gm))
  if (fenceMatches.length % 2 === 1) {
    stableEnd = fenceMatches[fenceMatches.length - 1]?.index ?? 0
  }
  return {
    stableSource: source.slice(0, stableEnd),
    volatileTail: source.slice(stableEnd),
  }
}

export function clearAgentMarkdownCache() {
  markdownCache.clear()
}

function installHooks() {
  if (hooksInstalled) return
  hooksInstalled = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName.toLowerCase() !== 'a') return
    const element = node as Element
    const href = element.getAttribute('href')
    if (!href) return
    if (!isSafeHref(href)) {
      element.removeAttribute('href')
      return
    }
    element.setAttribute('rel', 'noreferrer noopener')
    element.setAttribute('target', '_blank')
  })
}

function isSafeHref(href: string): boolean {
  const trimmed = href.trim()
  if (!trimmed) return false
  try {
    const baseHref = globalThis.location?.href ?? 'http://localhost/'
    const url = new URL(trimmed, baseHref)
    if (url.origin === new URL(baseHref).origin && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return true
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
  } catch {
    return !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
  }
}

function renderCodeBlock(text: string, info: string): string {
  const lang = normalizeHighlightLanguage(info.trim().split(/\s+/)[0] ?? '')
  const highlighted = highlightCode(text, lang)
  const classAttr = codeClassAttribute(lang, highlighted)
  const langLabel = lang ? `<span class="agent-code-lang">${escapeHtml(lang)}</span>` : ''
  const header = `<div class="agent-code-header">${langLabel}<button type="button" class="agent-code-copy" aria-label="复制代码">复制</button></div>`
  const codeBlock = `<pre class="agent-code-pre"><code${classAttr}>${highlighted}</code></pre>`
  return `<div class="agent-code-block">${header}${codeBlock}</div>`
}

function normalizeHighlightLanguage(lang: string): string {
  const normalized = lang.trim().toLowerCase()
  const aliases: Record<string, string> = {
    html: 'xml',
    js: 'javascript',
    jsx: 'javascript',
    md: 'markdown',
    patch: 'diff',
    py: 'python',
    sh: 'bash',
    shell: 'bash',
    ts: 'typescript',
    tsx: 'typescript',
    yml: 'yaml',
  }
  return aliases[normalized] ?? normalized
}

function highlightCode(text: string, lang: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
    }
    if (!lang && text.trim()) {
      const result = hljs.highlightAuto(text, autoHighlightLanguages)
      if (result.relevance >= 2) return result.value
    }
  } catch {
    // Invalid highlighter input falls through to escaped plaintext.
  }
  return escapeHtml(text)
}

function codeClassAttribute(lang: string, highlighted: string): string {
  const classes = [highlighted.includes('hljs-') ? 'hljs' : '', lang ? `language-${lang}` : ''].filter(Boolean)
  return classes.length > 0 ? ` class="${escapeHtml(classes.join(' '))}"` : ''
}

function normalizeMarkdownImageLabel(text?: string | null): string {
  const trimmed = text?.trim()
  return trimmed ? trimmed : 'image'
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean; total: number } {
  if (text.length <= maxChars) {
    return { text, truncated: false, total: text.length }
  }
  return { text: text.slice(0, maxChars), truncated: true, total: text.length }
}

function getCachedMarkdown(key: string): string | null {
  const cached = markdownCache.get(key)
  if (cached === undefined) return null
  markdownCache.delete(key)
  markdownCache.set(key, cached)
  return cached
}

function cacheMarkdown(key: string, value: string, inputLength: number): string {
  if (inputLength > MARKDOWN_CACHE_MAX_CHARS) return value
  markdownCache.set(key, value)
  if (markdownCache.size > MARKDOWN_CACHE_LIMIT) {
    const oldest = markdownCache.keys().next().value
    if (oldest !== undefined) markdownCache.delete(oldest)
  }
  return value
}

function renderEscapedPlainTextHtml(value: string): string {
  return `<div class="agent-markdown-plain-fallback">${escapeHtml(value.replace(/\r\n?/g, '\n'))}</div>`
}

function escapeRawHtmlToken(value: string): string {
  return escapeHtml(value.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''))
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
