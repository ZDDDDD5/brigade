import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CompareClose, CompareCta, ComparePage } from '@/components/landing/compare'
import { GuideBody } from '@/components/landing/guide'
import { c, Icon } from '@/components/landing/parts'
import { REPO_URL } from '@/lib/github-proof'
import { findGuide, guideDate, GUIDES, readingMinutes } from '@/lib/guides'
import { pageMetadata, SITE_URL } from '@/lib/page-metadata'

type Props = { params: Promise<{ slug: string }> }

export const dynamicParams = false

export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }))
}

export async function generateMetadata({ params }: Props) {
  const g = findGuide((await params).slug)
  if (!g) return {}
  const page = pageMetadata(`/guides/${g.slug}`, g.metaTitle, g.description)
  // The guide's own illustration in link previews, instead of the site's.
  const image = { url: g.image.src, width: 1600, height: 893, alt: g.image.alt }
  return {
    ...page,
    openGraph: { ...page.openGraph, type: 'article', images: [image] },
    twitter: { ...page.twitter, images: [image] },
  }
}

export default async function GuidePage({ params }: Props) {
  const g = findGuide((await params).slug)
  if (!g) notFound()
  const url = `${SITE_URL}/guides/${g.slug}`
  // The article and its questions, for search engines and AI answers.
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: g.title,
      description: g.description,
      image: `${SITE_URL}${g.image.src}`,
      datePublished: g.published,
      dateModified: g.updated,
      mainEntityOfPage: url,
      author: { '@type': 'Organization', name: 'Brigade', url: SITE_URL },
      publisher: { '@type': 'Organization', name: 'Brigade', url: SITE_URL },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      url,
      mainEntity: g.faq.map(({ q, a }) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Guides', item: `${SITE_URL}/guides` },
        { '@type': 'ListItem', position: 2, name: g.title, item: url },
      ],
    },
  ]
  const others = GUIDES.filter((x) => x.slug !== g.slug)
  return (
    <ComparePage>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <article className={c('gd')}>
        <header className={c('gd-hero')}>
          <p className={c('vs-eyebrow')}>
            <Link className={c('vs-chip link')} href="/guides">
              <Icon name="arrow" />
              All guides
            </Link>
            <span className={c('vs-checked')}>
              <Icon name="clock" />
              Updated <time dateTime={g.updated}>{guideDate(g.updated)}</time> · {readingMinutes(g)}{' '}
              min read
            </span>
          </p>
          <h1>{g.title}</h1>
          <p className={c('lead gd-lead')}>{g.lead}</p>
        </header>
        <figure className={c('gd-cover')}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a static file in public/ */}
          <img src={g.image.src} alt={g.image.alt} width={1600} height={893} />
        </figure>

        <GuideBody markdown={g.body} />

        <section className={c('gd-faq')} aria-labelledby="faq">
          <h2 id="faq">Questions people ask</h2>
          {g.faq.map(({ q, a }) => (
            <details key={q}>
              <summary>
                {q}
                <Icon name="plus" />
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </section>

        <details className={c('vs-sources')}>
          <summary>
            Sources, checked on {guideDate(g.updated)}
            <Icon name="arrow" />
          </summary>
          <p>
            What this guide says about other products comes from these pages. Products change: if
            something here is out of date, open an issue on <a href={REPO_URL}>GitHub</a>.
          </p>
          <ul>
            {g.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} rel="nofollow">
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </details>
      </article>

      <CompareClose title="Meet your AI teammates" />

      <section className={c('vs-sec')} aria-labelledby="more">
        <h2 id="more">More guides</h2>
        <ul className={c('vs-grid')}>
          {others.map((x) => (
            <li key={x.slug}>
              <Link className={c('vs-card')} href={`/guides/${x.slug}`}>
                <span className={c('vs-card-head')}>
                  <strong>{x.title}</strong>
                  <Icon name="arrow" />
                </span>
                <span>{x.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <CompareCta label="Start free" />
    </ComparePage>
  )
}
