import Link from 'next/link'
import { CompareClose, ComparePage } from '@/components/landing/compare'
import { c, Icon } from '@/components/landing/parts'
import { guideDate, GUIDES, readingMinutes } from '@/lib/guides'
import { pageMetadata, SITE_URL } from '@/lib/page-metadata'

export const dynamic = 'force-static'
export const revalidate = false

const title = 'Guides to AI agents'
const description =
  'Honest, up-to-date guides to AI agents: Hermes Agent vs OpenClaw, OpenClaw alternatives, Claude Code agent teams, self-hosted AI agents and more.'

export const metadata = pageMetadata('/guides', `${title} · Brigade`, description)

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: title,
  itemListElement: GUIDES.map((g, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name: g.title,
    url: `${SITE_URL}/guides/${g.slug}`,
  })),
}

export default function Guides() {
  return (
    <ComparePage>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <header className={c('vs-hero')}>
        <p className={c('vs-eyebrow')}>
          <span className={c('vs-chip')}>Guides</span>
        </p>
        <h1>Guides to AI agents</h1>
        <p className={c('lead vs-answer')}>
          What we learned building <strong>Brigade</strong>, an open-source team of AI teammates:
          how the agents people compare really differ, what they cost, and when to pick which. Every
          fact about another product links to its source.
        </p>
      </header>

      <ul className={c('gd-list')}>
        {GUIDES.map((g) => (
          <li key={g.slug}>
            <Link className={c('gd-card')} href={`/guides/${g.slug}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a static file in public/ */}
              <img src={g.image.src} alt="" width={1600} height={893} loading="lazy" />
              <span className={c('gd-card-text')}>
                <strong>{g.title}</strong>
                <span>{g.description}</span>
                <span className={c('gd-card-meta')}>
                  {guideDate(g.updated)} · {readingMinutes(g)} min read
                  <Icon name="arrow" />
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <CompareClose title="See it for yourself" />
    </ComparePage>
  )
}
