import Link from 'next/link'
import { BrigadeMark } from '@/components/brigade-mark'
import { HeroActions } from '@/components/home/hero'
import { REPO_URL } from '@/lib/github-proof'
import { AuthLink } from './auth-link'
import f from './faq.module.css'
import { FEATURED_ON } from './featured-on'
import { c, Icon, SIGN_IN, SIGN_UP } from './parts'
import { Pebble } from './pebble'
import { OPERATOR } from './operator'
import { PebbleRain } from './pebble-rain'

/**
 * The cards at the top of /pricing, as Settings › Billing offers them
 * (components/settings/billing.tsx): Free and Starter, Max in the comparison below them.
 */
const PLANS: {
  name: string
  icon: 'laptop' | 'clock'
  amount: string
  who: string
  features: string[]
  cta: string
}[] = [
  {
    name: 'Free',
    icon: 'laptop',
    amount: '$0',
    who: 'For trying it on your own computer',
    features: [
      'Unlimited teammates, threads and members',
      'Your own Claude or ChatGPT plan',
      'GitHub, Notion, Linear, Stripe and many more Apps',
      'Teammates work while your computer is on',
    ],
    cta: 'Sign up',
  },
  {
    name: 'Starter',
    icon: 'clock',
    amount: '$15',
    who: 'Always-on teammates at the lowest price',
    features: [
      'Everything in Free',
      'A cloud computer for 100 hours a month',
      'Teammates keep working with your laptop closed',
      'Schedules and triggers run on time, even at 3 a.m.',
      'An email address for each teammate',
    ],
    cta: 'Get Starter',
  },
]

/**
 * The top of /pricing, on a band in the dark theme whatever the page's theme, its title the
 * page's heading: Free and Starter, pebbles falling on Starter's button.
 */
export function Pricing() {
  const featured = 'Starter'
  return (
    <section
      aria-labelledby="pricing-title"
      className={c('pricing dark pricing-page')}
      id="pricing"
    >
      <div className={c('wrap')}>
        <div className={c('pr-head centered')}>
          <h1 className={c('h2')} id="pricing-title">
            Pricing
          </h1>
        </div>
        <div className={c('plans two')}>
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={c(plan.name === featured ? 'plan cloud' : 'plan')}
              {...(plan.name === featured ? { 'data-pebble-card': true } : {})}
            >
              <div className={c('plan-n')}>
                <Icon name={plan.icon} />
                {plan.name}
              </div>
              <div className={c('price')}>
                <span className={c('amt')}>{plan.amount}</span>
                {plan.amount !== '$0' && <span className={c('per')}>/ month</span>}
              </div>
              <p className={c('who')}>{plan.who}</p>
              <ul className={c('feat')}>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Icon name="check" />
                    {feature}
                  </li>
                ))}
              </ul>
              <AuthLink
                className={c(plan.name === featured ? 'btn pri lg' : 'btn lg')}
                href={SIGN_UP}
                {...(plan.name === featured ? { 'data-pebble-target': true } : {})}
              >
                {plan.cta}
              </AuthLink>
            </div>
          ))}
          <PebbleRain />
        </div>
        <p className={c('pr-note')}>
          Teammates run on your own Claude or ChatGPT plan: we never bill you for AI usage. Switch
          or cancel anytime.
        </p>
      </div>
    </section>
  )
}

/** The landing's questions: shown in Faq, and given to search engines as an FAQPage (app/page.tsx). */
export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Do I need to know how to code?',
    a: "No. You describe a job in a message, the way you would to a new hire. For a task in a website or an app, take over a teammate's cloud computer and show it once.",
  },
  {
    q: 'What does Brigade cost?',
    a: 'Brigade is free when teammates run on your own computer. To keep them working when yours is off, give them a cloud computer: Starter is $15 a month for 100 hours, and Max is $99 a month with no hour limit. On top of that, you bring the Claude or ChatGPT plan you already pay for: we never bill you for AI usage.',
  },
  {
    q: 'Which AI plans work?',
    a: 'Claude plans through Claude Code, and ChatGPT plans through Codex. Max or Pro gives the most room. Pick a model per teammate, and stack several accounts: when one hits its limit, the teammate carries on with the next account of the same provider, in the middle of the task.',
  },
  {
    q: 'How do I stay in control?',
    a: 'For each teammate, you choose what it does on its own and what waits for your yes in Needs you, which Apps it can reach, and daily caps on its threads, computer hours and writes to each App. Every step it takes is in its thread, for you to read.',
  },
  {
    q: 'Why several teammates rather than one agent?',
    a: 'One agent with every tool and no owner gets vague fast. Each teammate holds one job, with its own Apps, memory and rules, so you see who did what and fix the one that is off.',
  },
  {
    q: 'Where do my passwords go?',
    a: "In your workspace's vault. When a teammate signs in to a website, Brigade types the login for it: the teammate never sees the password, and it never ends up in a thread.",
  },
  {
    q: 'Is my data used to train AI models?',
    a: 'Not by us. The work runs on the AI plan you bring, so your data goes only to the provider you picked, under the terms of your plan.',
  },
  {
    q: 'Can a teammate have its own email address?',
    a: 'Yes, with Starter or Max. Turn on the Email App and each teammate gets an address of its own. It sends from it, and replies come back to the teammate that started the conversation, not to your inbox.',
  },
  {
    q: 'Can my team see the work?',
    a: "Yes. Invite them to your workspace: threads, tasks and files are shared, so nothing sits in one person's chat history.",
  },
  {
    q: 'Is it open source?',
    a: 'Yes. The whole product is on GitHub under the MIT license, so you can read every line and run it yourself.',
  },
  {
    q: 'What if I cancel?',
    a: 'Cancel from Settings whenever you want: Cloud stops at the end of the month you paid for. Your workspace stays, and your teammates can keep working for free on your own computer.',
  },
]

/**
 * Questions with their answers, the first open: the landing's FAQ by default, and the
 * billing questions on /pricing. One centred column of cards on a faint dot grid; the open
 * card gets a violet edge, its answer inside it and a minus for its plus. Native <details>,
 * so it opens without JavaScript.
 */
export function Faq({
  items = FAQ,
  title = 'Questions, answered.',
  more = true,
}: {
  items?: { q: string; a: string }[]
  title?: string
  /** The "Still wondering?" line, pointing to the docs and GitHub. */
  more?: boolean
}) {
  return (
    <section aria-labelledby="faq-title" className={`${c('sec')} ${f.faq}`}>
      <div className={c('wrap')}>
        <div className={f.head} data-reveal="stagger">
          <h2 className={c('h2')} id="faq-title">
            {title}
          </h2>
          {more && (
            <p className={f.more}>
              Still wondering? Read the <a href="/docs">docs</a> or ask on{' '}
              <a href={REPO_URL}>GitHub</a>.
            </p>
          )}
        </div>
        <div className={f.list} data-reveal="stagger" data-reveal-delay="1">
          {items.map(({ q, a }, i) => (
            <details key={q} className={f.card} open={i === 0}>
              <summary>
                <span>{q}</span>
                <span className={f.toggle} aria-hidden="true">
                  <span className={f.plus}>
                    <Icon name="plus" />
                  </span>
                  <span className={f.minus}>
                    <Icon name="minus" />
                  </span>
                </span>
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

export function FinalCall() {
  return (
    <section aria-labelledby="final-title" className={c('final')} data-anim>
      <Pebble />
      <div className={c('wrap')}>
        <div data-reveal="stagger">
          <h2 id="final-title">Meet your first teammate</h2>
          <p className={c('lead')}>He does the work. You make the calls.</p>
          <HeroActions className={c('final-cta')} menuUp />
        </div>
      </div>
    </section>
  )
}

/**
 * Directories Brigade is listed on, shown on the landing page only: There's An AI For That
 * verifies its listing by finding this exact link on www.brigade.lol/ and on no other page,
 * so keep its href as they gave it and keep it out of the shared footer. The others
 * (featured-on.ts) follow it in one quiet line of text.
 */
function Featured() {
  return (
    <div className={c('wrap foot-featured')}>
      <a
        href="https://theresanaiforthat.com/ai/brigade/?ref=featured&v=915251"
        target="_blank"
        rel="nofollow"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- TAAFT's own badge, served by them */}
        <img
          width="300"
          src="https://media.theresanaiforthat.com/featured-on-taaft.png?width=600"
          alt="Featured on There's An AI For That"
        />
      </a>
      {FEATURED_ON.length > 0 && (
        <ul className={c('foot-links')} aria-label="Also featured on">
          {FEATURED_ON.map((d) => (
            <li key={d.href}>
              {d.badge ? (
                <a className={c('foot-badge')} href={d.href} title={d.name}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- the directory's own badge, served by it */}
                  <img
                    src={d.badge.src}
                    alt={d.badge.alt}
                    width={d.badge.width}
                    height={d.badge.height}
                  />
                </a>
              ) : (
                <a href={d.href}>{d.name}</a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Pressed into the page: inside each letter, a soft shadow under its top edge and a thin
 * light along its bottom one, as on a name stamped into paper. In the footer's own colors
 * (its --foreground and --background), so it sits inside the name.
 */
function CarveFilter() {
  return (
    <svg className={c('carve-defs')} aria-hidden="true" focusable="false">
      <filter id="foot-carve" x="-2%" y="-10%" width="104%" height="120%">
        {/* Everything but the letters, to cast inward from their edges. */}
        <feComponentTransfer in="SourceAlpha" result="out">
          <feFuncA type="table" tableValues="1 0" />
        </feComponentTransfer>
        <feOffset in="out" dy="9" result="down" />
        <feGaussianBlur in="down" stdDeviation="7" result="down-soft" />
        <feFlood className={c('carve-shade')} />
        <feComposite in2="down-soft" operator="in" />
        <feComposite in2="SourceAlpha" operator="in" result="shade" />
        <feOffset in="out" dy="-4" result="up" />
        <feGaussianBlur in="up" stdDeviation="1.4" result="up-soft" />
        <feFlood className={c('carve-light')} />
        <feComposite in2="up-soft" operator="in" />
        <feComposite in2="SourceAlpha" operator="in" result="light" />
        <feMerge>
          <feMergeNode in="SourceGraphic" />
          <feMergeNode in="shade" />
          <feMergeNode in="light" />
        </feMerge>
      </filter>
    </svg>
  )
}

/** The page's footer; `featured` adds the directory badges, on the landing page only;
 * `carved` presses the large name into the page (the home page's tinted footer). */
export function Footer({
  featured = false,
  carved = false,
}: {
  featured?: boolean
  carved?: boolean
}) {
  return (
    <footer className={c('foot')}>
      <div className={c('wrap')}>
        <span className={c('word')}>
          <BrigadeMark className={c('word-mark')} />
          Brigade
        </span>
        <nav aria-label="Footer">
          <a href={REPO_URL}>GitHub</a>
          <a href="https://status.brigade.lol">Status</a>
          <a href="/docs">Docs</a>
          <Link href="/changelog">Changelog</Link>
          <Link href="/compare">Compare</Link>
          <Link href="/guides">Guides</Link>
          <AuthLink href={SIGN_IN}>Sign in</AuthLink>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          {OPERATOR.company && <Link href="/legal">Legal</Link>}
          <span>© 2026</span>
        </nav>
      </div>
      {featured && <Featured />}
      {/* The name, as large as the page is wide, cut by the bottom edge. */}
      <div className={c(carved ? 'foot-name carved' : 'foot-name')} aria-hidden="true" data-anim>
        {carved && <CarveFilter />}
        <span>Brigade</span>
      </div>
    </footer>
  )
}
