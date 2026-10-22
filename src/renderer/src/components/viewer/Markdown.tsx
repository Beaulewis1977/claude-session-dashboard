import { memo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

function CopyButton({ getText, className }: { getText: () => string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label="Copy"
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground',
        className
      )}
      onClick={(e) => {
        e.stopPropagation()
        void api.copyText(getText())
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

export function CodeBlock({
  language,
  children,
  className
}: {
  language?: string
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div
      className={cn(
        'code-block group/code overflow-hidden rounded-lg border border-code-border bg-code-bg',
        className
      )}
    >
      <div className="flex h-7 items-center justify-between border-b border-code-border/70 pr-1 pl-3">
        <span className="font-mono text-2xs text-subtle-foreground">{language || 'text'}</span>
        <CopyButton
          getText={() => ref.current?.innerText ?? ''}
          className="opacity-0 group-hover/code:opacity-100 focus:opacity-100"
        />
      </div>
      <pre
        ref={ref}
        className="selectable overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-[1.6]"
      >
        {children}
      </pre>
    </div>
  )
}

const components: Components = {
  pre({ children }) {
    // react-markdown renders <pre><code class="language-x">…</code></pre>
    const child = Array.isArray(children) ? children[0] : children
    const cls = (child as { props?: { className?: string } } | undefined)?.props?.className ?? ''
    const lang = /language-([\w+#.-]+)/.exec(cls)?.[1]
    return <CodeBlock language={lang}>{children}</CodeBlock>
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          if (href) void api.openExternal(href)
        }}
        title={href}
      >
        {children}
      </a>
    )
  },
  img({ alt }) {
    // Never load remote images (no network calls).
    return <span className="text-muted-foreground">[image{alt ? `: ${alt}` : ''}]</span>
  }
}

const remarkPlugins = [remarkGfm]
const remarkPluginsBreaks = [remarkGfm, remarkBreaks]
const rehypePlugins: Parameters<typeof ReactMarkdown>[0]['rehypePlugins'] = [
  [rehypeHighlight, { detect: false }]
]

export const Markdown = memo(function Markdown({
  text,
  breaks,
  className
}: {
  text: string
  /** Treat single newlines as line breaks (for user-typed text). */
  breaks?: boolean
  className?: string
}) {
  return (
    <div className={cn('prose-chat selectable', className)}>
      <ReactMarkdown
        remarkPlugins={breaks ? remarkPluginsBreaks : remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

export { CopyButton }
