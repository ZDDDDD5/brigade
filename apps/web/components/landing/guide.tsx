import type { ComponentProps } from 'react'
import Link from 'next/link'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { c } from './parts'

/** A link in a guide: the site's own pages through Next, the rest in a new tab without endorsing them. */
function Anchor({ href = '', children }: ComponentProps<'a'>) {
  if (href.startsWith('/') || href.startsWith('#'))
    return (
      <Link className={c('link')} href={href}>
        {children}
      </Link>
    )
  return (
    <a className={c('link')} href={href} target="_blank" rel="noopener nofollow">
      {children}
    </a>
  )
}

/** A picture in a guide, with its title as the caption under it. */
function Figure({ src, alt, title }: ComponentProps<'img'>) {
  if (typeof src !== 'string') return null
  return (
    <figure className={c('gd-figure')}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a static file in public/ */}
      <img src={src} alt={alt ?? ''} loading="lazy" />
      {title && <figcaption>{title}</figcaption>}
    </figure>
  )
}

const components: Components = {
  a: ({ node: _, ...props }) => <Anchor {...props} />,
  // An image sits alone in its paragraph: unwrap it, so the figure isn't inside a <p>.
  p: ({ node, ...props }) => {
    const only = node?.children.length === 1 ? node.children[0] : undefined
    return only?.type === 'element' && only.tagName === 'img' ? (
      <>{props.children}</>
    ) : (
      <p {...props} />
    )
  },
  img: ({ node: _, ...props }) => <Figure {...props} />,
  table: ({ node: _, ...props }) => (
    <div className={c('gd-table')}>
      <table {...props} />
    </div>
  ),
}

/** A guide's article, from its Markdown, in the site's look (landing.module.css, .gd-body). */
export function GuideBody({ markdown }: { markdown: string }) {
  return (
    <div className={c('gd-body')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
