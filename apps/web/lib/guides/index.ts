// The guides (app/guides): long answers to what people search for around AI agents
// ("hermes vs openclaw", "claude code agent teams", "self-hosted ai agent"), written for a person
// deciding and for the search engines that rank them. Each fact about another product carries a
// source and the day it was checked; each line about Brigade must hold in the code and docs, as
// on the comparison pages (lib/compare.ts). Check the facts again before changing `updated`.
import { claudeCodeAgentTeams } from './claude-code-agent-teams'
import { openclawAlternatives } from './openclaw-alternatives'
import { openclawVsClaudeCode } from './openclaw-vs-claude-code'
import { openclawVsHermesAgent } from './openclaw-vs-hermes-agent'
import { selfHostedAiAgents } from './self-hosted-ai-agents'

export type Source = { label: string; url: string }
export type Faq = { q: string; a: string }

export type Guide = {
  slug: string
  /** The page's title, as its heading shows it. */
  title: string
  /** The title in search results and link previews, under 60 characters when it can be. */
  metaTitle: string
  /** One or two sentences for search results and the index, under 160 characters when it can be. */
  description: string
  /** The answer, first: the lead under the title. */
  lead: string
  /** The day it was first published and the day its facts were last checked (YYYY-MM-DD). */
  published: string
  updated: string
  /** Its illustration in public/guides, and what it shows. */
  image: { src: string; alt: string }
  /** The article, in Markdown (GitHub tables, images with a caption as their title). */
  body: string
  /** Questions people ask, answered in a few sentences; shown at the end and given to search engines. */
  faq: Faq[]
  sources: Source[]
}

export const GUIDES: Guide[] = [
  openclawVsHermesAgent,
  openclawAlternatives,
  openclawVsClaudeCode,
  claudeCodeAgentTeams,
  selfHostedAiAgents,
]

export const findGuide = (slug: string) => GUIDES.find((g) => g.slug === slug)

/** A day as the page shows it: "November 15, 2026". */
export const guideDate = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })

/** Minutes to read the article, at 230 words a minute. */
export const readingMinutes = (g: Guide) =>
  Math.max(1, Math.round(g.body.split(/\s+/).filter(Boolean).length / 230))
