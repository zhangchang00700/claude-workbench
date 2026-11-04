import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

/**
 * 助手正文渲染：GFM Markdown + 代码高亮。
 * 代码块语言名通过 data-lang 写到 <pre> 上，由 CSS 显示在右上角。
 * memo：流式期间每个 delta 都会重渲染整棵消息树，跳过已完成消息的重复解析。
 */
const MarkdownBlock = memo(
  function MarkdownBlock({ text }: { text: string }): React.JSX.Element {
    const rehypePlugins = useMemo(() => [rehypeHighlight], [])
    const remarkPlugins = useMemo(() => [remarkGfm], [])
    return (
      <div className="md">
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={{
            // 外链不允许在应用窗口内导航（无 openExternal 通道前，悬浮可见 URL）
            a({ children, href, ...props }) {
              return (
                <a
                  href={href}
                  title={href}
                  onClick={(e) => {
                    e.preventDefault()
                  }}
                  {...props}
                >
                  {children}
                </a>
              )
            },
            pre({ children, ...props }) {
              const child = Array.isArray(children) ? children[0] : children
              const lang =
                child && typeof child === 'object' && 'props' in child
                  ? String((child.props as { className?: string }).className ?? '')
                      .replace('hljs', '')
                      .replace('language-', '')
                      .trim()
                  : ''
              return (
                <pre data-lang={lang || undefined} {...props}>
                  {children}
                </pre>
              )
            }
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    )
  },
  (a, b) => a.text === b.text
)

export default MarkdownBlock
