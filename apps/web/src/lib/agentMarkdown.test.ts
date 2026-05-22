// @vitest-environment jsdom
import { clearAgentMarkdownCache, splitStableMarkdownStreamSource, toSanitizedAgentMarkdownHtml } from './agentMarkdown'

describe('agentMarkdown', () => {
  beforeEach(() => {
    clearAgentMarkdownCache()
  })

  it('renders assistant markdown into compact transcript HTML', () => {
    const html = toSanitizedAgentMarkdownHtml([
      '我是 **xox-model Agent OS**',
      '',
      '---',
      '',
      '### 数据问答',
      '- 查询任意月份',
      '- 查看 `workspace_rename`',
    ].join('\n'))

    expect(html).toContain('<strong>xox-model Agent OS</strong>')
    expect(html).toContain('<hr')
    expect(html).toContain('<h3>数据问答</h3>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<code>workspace_rename</code>')
    expect(html).not.toContain('**xox-model Agent OS**')
  })

  it('renders code fences and tables without turning them into plain text', () => {
    const html = toSanitizedAgentMarkdownHtml([
      '| 月份 | 利润 |',
      '| --- | ---: |',
      '| 3月 | 100 |',
      '',
      '```ts',
      'const profit = 100',
      '```',
    ].join('\n'))

    expect(html).toContain('<table>')
    expect(html).toContain('<th>月份</th>')
    expect(html).toContain('agent-code-block')
    expect(html).toContain('language-typescript')
    expect(html).toContain('const')
  })

  it('sanitizes dangerous raw html attributes', () => {
    const html = toSanitizedAgentMarkdownHtml([
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
    ].join('\n'))

    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('sanitizes dangerous markdown links and remote images', () => {
    const html = toSanitizedAgentMarkdownHtml([
      '[危险](javascript:alert(1))',
      '![远程图](https://example.com/a.png)',
    ].join('\n'))

    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('<img')
    expect(html).toContain('远程图')
  })

  it('hardens safe links and avoids swallowing adjacent Chinese text', () => {
    const html = toSanitizedAgentMarkdownHtml('参考 https://example.com/path中文 后续')

    expect(html).toContain('href="https://example.com/path"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('</a>中文')
  })

  it('falls back to escaped plain text for oversized content', () => {
    const html = toSanitizedAgentMarkdownHtml(`**${'a'.repeat(40_050)}**`)

    expect(html).toContain('agent-markdown-plain-fallback')
    expect(html).toContain('**')
    expect(html).not.toContain('<strong>')
  })

  it('splits streaming markdown at stable boundaries', () => {
    expect(splitStableMarkdownStreamSource('正在思考')).toEqual({
      stableSource: '',
      volatileTail: '正在思考',
    })

    expect(splitStableMarkdownStreamSource('完成一行\n下一行')).toEqual({
      stableSource: '完成一行\n',
      volatileTail: '下一行',
    })

    expect(splitStableMarkdownStreamSource('前文\n```ts\nconst x = 1')).toEqual({
      stableSource: '前文\n',
      volatileTail: '```ts\nconst x = 1',
    })
  })
})
