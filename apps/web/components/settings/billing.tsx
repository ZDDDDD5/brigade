'use client'
// Billing: the workspace's plan. Brigade is free on members' own machines; Brigade Cloud,
// per workspace, adds the cloud computer, and Brigade Cloud Starter the same computer for a
// number of hours a month. Owners and admins subscribe through Stripe Checkout, move from
// Starter to Cloud in Stripe's portal, and manage the subscription (card, invoices, cancel) there.
import type { BillingResponse } from '@brigade/contracts'
import { Check, Cloud, Gauge } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { api, openStripe, subscribeToCloud, upgradeToCloud, useApi } from '@/lib/api'
import { useSettingsParams } from '@/lib/settings-dialog'
import { cn } from '@/lib/utils'

type Tier = 'cloud' | 'starter'

/** Each plan as the page offers it. Starter's hours are the API's (PLANS in src/billing.ts). */
const PLANS: Record<Tier, { name: string; price: string; features: string[] }> = {
  starter: {
    name: 'Brigade Cloud Starter',
    price: '$15 a month per workspace, or €15 in the euro zone',
    features: [
      '100 hours of cloud computer a month: teammates keep working when your computer is off',
      'An email address for each teammate, and the Inbox to follow their mail',
      'Still on your own Claude or ChatGPT plan: no charge for AI usage',
    ],
  },
  cloud: {
    name: 'Brigade Cloud',
    price: '$99 a month per workspace, or €99 in the euro zone',
    features: [
      'Teammates keep working when your Mac is asleep, closed or you don’t have one',
      'Brigade’s cloud computer, shared by the workspace, up to 4 threads at once, with no limit of hours',
      'An email address for each teammate, the Inbox to follow their mail, and dictation',
      'Still on your own Claude or ChatGPT plan: no charge for AI usage',
    ],
  },
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

/** What the plan's status means for the workspace, in a line. */
function standing(plan: NonNullable<BillingResponse['plan']>) {
  if (plan.complimentary) return 'Included by Brigade'
  if (plan.status === 'past_due') return 'Payment failed: update your card to keep it'
  if (plan.status === 'trialing' && plan.periodEnd) return `Trial until ${day(plan.periodEnd)}`
  if (plan.cancelAt) return `Ends on ${day(plan.cancelAt)}`
  if (plan.active && plan.periodEnd) return `Renews on ${day(plan.periodEnd)}`
  if (plan.active) return 'Active'
  return 'Ended'
}

/** A plan's name and line, beside its icon. */
function PlanHead({ tier, line, dot }: { tier: Tier; line: ReactNode; dot?: boolean }) {
  return (
    <div className="flex items-start gap-4">
      <span
        aria-hidden
        className="flex size-11 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary [&_svg]:size-5"
      >
        {tier === 'starter' ? <Gauge /> : <Cloud />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold">{PLANS[tier].name}</span>
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          {dot !== undefined && (
            <span
              aria-hidden
              className={cn(
                'size-2 shrink-0 rounded-full',
                dot ? 'bg-primary' : 'bg-muted-foreground/40',
              )}
            />
          )}
          {line}
        </span>
      </div>
    </div>
  )
}

function Features({ tier }: { tier: Tier }) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {PLANS[tier].features.map((feature) => (
        <li key={feature} className="flex gap-2">
          <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
          {feature}
        </li>
      ))}
    </ul>
  )
}

/** Starter's hours this period: how many the cloud computer ran, and when they start over. */
function Hours({ hours }: { hours: NonNullable<NonNullable<BillingResponse['plan']>['hours']> }) {
  const left = hours.used < hours.included
  const used = Math.min(hours.used, hours.included)
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/60 px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">
          {used.toLocaleString(undefined, { maximumFractionDigits: 1 })} of {hours.included} hours
          used
        </span>
        <span className="text-muted-foreground">Starts over on {day(hours.resetsAt)}</span>
      </div>
      <Progress value={(used / hours.included) * 100} aria-label="Cloud computer hours used" />
      <p className="text-[0.8125rem] leading-snug text-muted-foreground">
        {left
          ? 'Hours count while the cloud computer is on. It goes to sleep 30 minutes after teammates finish, and wakes when they have work.'
          : 'This month’s hours are used up: the cloud computer sleeps, and teammates’ work waits for it, until they start over or you upgrade.'}
      </p>
    </div>
  )
}

export default function BillingPage() {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const billing = useApi<BillingResponse>('/billing')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [welcome, setWelcome] = useState(false)
  const [upgradedNow, setUpgradedNow] = useState(false)

  // Back from Checkout (/app/billing?subscribed=1), or the portal's upgrade (?upgraded=1): say so.
  const params = useSettingsParams()
  const subscribed = params.has('subscribed')
  const upgraded = params.has('upgraded')
  useEffect(() => {
    if (subscribed) setWelcome(true)
  }, [subscribed])
  useEffect(() => {
    if (upgraded) setUpgradedNow(true)
  }, [upgraded])

  async function go(open: () => Promise<void>) {
    setBusy(true)
    setError(undefined)
    try {
      await open()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      // Opened in a new tab (a preview's frame), this page stays.
      setBusy(false)
    }
  }

  const manage = () =>
    go(() =>
      openStripe(
        async () => (await api<{ url: string }>('/billing/portal', { method: 'POST' })).url,
      ),
    )

  const data = billing.data
  const plan = data?.plan
  const active = !!plan?.active
  const tier: Tier = plan?.tier ?? 'cloud'

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-extrabold tracking-tight">Billing</h1>
        <p className="max-w-prose text-muted-foreground">
          Brigade is free on your own machines. Brigade Cloud adds the cloud computer and email
          addresses, for this workspace. {!admin && 'Only owners and admins can change the plan.'}
        </p>
      </header>

      {welcome && active && (
        <p role="status" className="rounded-lg bg-accent p-4 text-sm text-accent-foreground">
          Welcome to {PLANS[tier].name}. Your cloud computer is being set up: it shows in Computers
          within a few minutes.
        </p>
      )}
      {upgradedNow && active && tier === 'cloud' && (
        <p role="status" className="rounded-lg bg-accent p-4 text-sm text-accent-foreground">
          You’re on Brigade Cloud now: the cloud computer has no limit of hours.
        </p>
      )}

      {!data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !data.enabled ? (
        <Card className="max-w-xl px-6 py-5 text-sm text-muted-foreground">
          Billing is off on this Brigade server: the cloud computer, when there is one, is included.
        </Card>
      ) : active ? (
        <Card className="max-w-xl gap-5 px-6 py-5">
          <PlanHead tier={tier} line={standing(plan)} dot />
          {plan.hours && <Hours hours={plan.hours} />}
          {admin && !plan.complimentary && (
            <div className="flex flex-wrap gap-2">
              {tier === 'starter' && (
                <Button disabled={busy} onClick={() => void go(() => upgradeToCloud())}>
                  Upgrade to Brigade Cloud · $99
                </Button>
              )}
              <Button variant="outline" disabled={busy} onClick={() => void manage()}>
                Manage billing
              </Button>
            </div>
          )}
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {plan && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
              {PLANS[tier].name}: {standing(plan)}
              {admin && !plan.complimentary && (
                <Button
                  variant="link"
                  className="h-auto p-0"
                  disabled={busy}
                  onClick={() => void manage()}
                >
                  Invoices
                </Button>
              )}
            </p>
          )}
          <div className="grid max-w-3xl gap-4 md:grid-cols-2">
            {(['starter', 'cloud'] as const).map((offer) => (
              <Card key={offer} className="gap-5 px-6 py-5">
                <PlanHead tier={offer} line={PLANS[offer].price} />
                <Features tier={offer} />
                {admin && (
                  <Button
                    className="mt-auto self-start"
                    variant={offer === 'cloud' ? 'default' : 'outline'}
                    disabled={busy}
                    onClick={() => void go(() => subscribeToCloud('billing', offer))}
                  >
                    {offer === 'starter' ? 'Start with Starter' : 'Get Brigade Cloud'}
                  </Button>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive-text">{error}</p>}
    </div>
  )
}
