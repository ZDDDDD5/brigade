import type { ReactNode } from 'react'
import { HarnessLogo } from '@/components/harness-logo'
import { c } from './parts'

/** The vendors' own marks, as the app draws them (components/harness-logo.tsx). */
export function ClaudeMark() {
  return <HarnessLogo harness="claude_code" className="size-auto" />
}

export function ChatGptMark() {
  return <HarnessLogo harness="codex" className="size-auto" />
}

/** Bring your own sub, said in one paragraph beside the panel that shows it: the plans members already pay for, the accounts in use, the relay to the next one, and a model per teammate.
 * The relay is between accounts of one provider (runner: harness/index.ts, account.switched);
 * the models are the product's own (packages/contracts/src/models.ts). */
export function Plans({
  copy,
  titleId = 'plans-title',
}: {
  /** The left column; the paragraph below by default. */
  copy?: (titleId: string) => ReactNode
  titleId?: string
} = {}) {
  return (
    <section aria-labelledby={titleId} className={c('sec')} data-anim>
      <div className={c('wrap byo')}>
        <div className={c('byo-copy')} data-reveal="stagger">
          {copy ? copy(titleId) : <PlansCopy titleId={titleId} />}
        </div>

        <div className={c('byo-panel')} aria-hidden="true" data-reveal="pop" data-reveal-delay="2">
          <div className={c('cp-head')}>
            <span className={c('cp-l')}>Connected plans</span>
            <span className={c('cp-l cp-count')} data-k="plan">
              3 accounts
            </span>
          </div>
          <div className={c('cp-body')}>
            <div className={c('cp-row')} data-k="plan stack">
              <ClaudeMark />
              <b>Claude Max · account 1</b>
              <span className={c('cp-model')}>Opus 5.5</span>
              <span className={c('acct-bar')}>
                <span className={c('acct-f a')}></span>
              </span>
            </div>
            <p className={c('cp-l warn cp-relay')} data-k="stack">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m15 10 5 5-5 5" />
                <path d="M4 4v7a4 4 0 0 0 4 4h12" />
              </svg>
              At limit: next account takes over, mid-task
            </p>
            <div className={c('cp-row')} data-k="plan stack">
              <ClaudeMark />
              <b>Claude Max · account 2</b>
              <span className={c('cp-model')}>Opus 5.5</span>
              <span className={c('acct-bar')}>
                <span className={c('acct-f b')}></span>
              </span>
            </div>
            <div className={c('cp-row')} data-k="plan">
              <ChatGptMark />
              <b>ChatGPT Pro</b>
              <span className={c('cp-model')}>GPT-6.2 Sol</span>
              <span className={c('acct-bar')}>
                <span className={c('acct-f c')}></span>
              </span>
            </div>
            <p className={c('cp-l cp-sep')} data-k="model">
              Model per teammate
            </p>
            <div className={c('cp-row')} data-k="model">
              <span className={c('av')}>R</span>
              <span className={c('cp-name')}>Riley</span>
              <span className={c('cp-model')}>Opus 5.5</span>
            </div>
            <div className={c('cp-row')} data-k="model">
              <span className={c('av sam')}>S</span>
              <span className={c('cp-name')}>Sam</span>
              <span className={c('cp-model')}>Sonnet 5.5</span>
            </div>
            <div className={c('cp-row')} data-k="model">
              <span className={c('av mark')}>M</span>
              <span className={c('cp-name')}>Mark</span>
              <span className={c('cp-model')}>GPT-6.2 Sol</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** The section's own left column: the claim, then three rows, each a short claim and the
 * fact behind it; pointing at a row brings forward the part of the panel it describes. */
function PlansCopy({ titleId }: { titleId: string }) {
  return (
    <>
      <h2 className={c('h2')} id={titleId}>
        Bring your own sub.
      </h2>
      <div className={c('byo-list')}>
        <p data-say="plan">
          <b>The plans you already pay for.</b>
          <span>The real Claude Code and Codex, signed in with your accounts.</span>
        </p>
        <p data-say="stack">
          <b>Stack accounts.</b>
          <span>When one hits its limit, the next takes over mid-task.</span>
        </p>
        <p data-say="model">
          <b>A model per teammate.</b>
          <span>Opus for your engineer, Sonnet for support, GPT for marketing.</span>
        </p>
      </div>
      <p className={c('byo-runs')}>
        <span className={c('byo-mark')}>
          <ClaudeMark />
          Claude Code
        </span>
        <span className={c('byo-mark')}>
          <ChatGptMark />
          Codex
        </span>
      </p>
    </>
  )
}
