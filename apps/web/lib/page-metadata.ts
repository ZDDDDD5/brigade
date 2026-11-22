import type { Metadata } from 'next'

export const SITE_URL = 'https://www.brigade.lol'

// app/opengraph-image.png, named again on each page: a page that sets its own `openGraph`
// replaces the root's, image included (Next merges metadata shallowly).
const image = {
  url: '/opengraph-image.png',
  width: 1200,
  height: 630,
  alt: 'Brigade: AI teammates that run your whole company',
}

/** Past this length, search results cut a description off mid-sentence. */
export const DESCRIPTION_MAX = 160

/**
 * A description that fits a search result: its whole sentences up to DESCRIPTION_MAX, or
 * the first sentence cut at a word with an ellipsis when that one alone is too long.
 */
export function fitDescription(text: string, max = DESCRIPTION_MAX): string {
  if (text.length <= max) return text
  const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)/g) ?? [text]
  let fit = ''
  for (const s of sentences) {
    if ((fit + s).trimEnd().length > max) break
    fit += s
  }
  if (fit) return fit.trimEnd()
  const cut = text.slice(0, max - 1)
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:]+$/, '')}…`
}

/** A public page's title, description, canonical address and link preview. */
export function pageMetadata(path: string, title: string, full: string): Metadata {
  const url = path === '/' ? `${SITE_URL}/` : `${SITE_URL}${path}`
  const description = fitDescription(full)
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', url, siteName: 'Brigade', title, description, images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  }
}

/** Pages behind a sign-in, or with nothing to find: kept out of search results. */
export const PRIVATE_PAGE: Metadata = { robots: { index: false, follow: false } }

/** Public pages with nothing to find (sign-in, sign-up): out of results, but their links count. */
export const UNLISTED_PAGE: Metadata = { robots: { index: false, follow: true } }
