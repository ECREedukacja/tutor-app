'use client'

import 'katex/dist/katex.min.css'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { ReactNode } from 'react'

// Renderuje treść zadania:
//   • Markdown (akapity, listy, **bold**, *italic*, kod)
//   • Inline math: $...$ → KaTeX
//   • Block math: $$...$$ → KaTeX
//   • Bloki kodu (np. TikZ) → monospace
//
// Bloki kodu z language-tikz są renderowane jako placeholder z informacją
// — pełne TikZ → SVG zostawiamy na późniejszą iterację.
export function MathContent({
  text,
  className = '',
}: {
  text: string
  className?: string
}) {
  return (
    <div className={`math-content prose prose-sm max-w-none text-slate-800 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ children }) => (
            <p className="my-2 leading-relaxed">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="my-2 list-disc pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 list-decimal pl-5">{children}</ol>
          ),
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-slate-900">{children}</strong>
          ),
          code: ({ className, children }) => {
            const lang = /language-(\w+)/.exec(className ?? '')?.[1]
            const isInline = !className
            if (isInline) {
              return (
                <code className="rounded bg-slate-100 px-1 py-0.5 text-[0.875em] text-slate-800">
                  {children}
                </code>
              )
            }
            return (
              <CodeBlock lang={lang}>{children}</CodeBlock>
            )
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ lang, children }: { lang?: string; children: ReactNode }) {
  const isTikz = lang === 'tikz'
  return (
    <div className="my-3">
      {isTikz ? (
        <div className="mb-1 text-xs font-medium text-amber-700">
          Diagram TikZ — renderowanie graficzne pojawi się w kolejnej wersji.
        </div>
      ) : null}
      <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-800">
        <code>{children}</code>
      </pre>
    </div>
  )
}
