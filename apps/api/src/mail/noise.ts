// Mail nobody took that the Inbox keeps out of To do, in Other (src/inbox.ts): it waits for no
// one. Decided once, as a mail is left in its box (src/mail/inbound.ts, src/mail/gmail-inbox.ts),
// and kept on it (MailMessage.noise). It never changes where a mail goes: a thread waiting on it,
// its conversation's or a rule's still takes it first.
import type { ScopedDb } from '../db.js'
import { bareAddress } from './names.js'

/** Why a mail is in Other. */
export type Noise = 'sign_up' | 'automatic' | 'muted'

/**
 * Public mail providers' domains: muting one would mute everyone who writes from it, so only
 * their single addresses can be muted.
 */
const PUBLIC_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.fr',
  'live.com',
  'live.fr',
  'msn.com',
  'yahoo.com',
  'yahoo.fr',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'gmx.fr',
  'web.de',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'qq.com',
  '126.com',
  '163.com',
  'orange.fr',
  'free.fr',
  'laposte.net',
  'sfr.fr',
  'wanadoo.fr',
  'fastmail.com',
  'hey.com',
  'tutanota.com',
])

/** The domain of an address, lower-cased. */
export const domainOf = (address: string) => bareAddress(address).split('@')[1] ?? ''

/** Whether everyone at this domain can be muted at once: not a public mail provider's. */
export const mutableDomain = (domain: string) =>
  !!domain && domain.includes('.') && !PUBLIC_DOMAINS.has(domain)

/** A domain and those it is under, down to two labels: news.medium.com, medium.com. */
const domainsOf = (domain: string) => {
  const labels = domain.split('.')
  const found: string[] = []
  for (let i = 0; i <= labels.length - 2; i++) found.push(labels.slice(i).join('.'))
  return found
}

/** How a sender is muted: its address, its domain (or one above it), or not. */
export async function mutedSender(db: ScopedDb, address: string) {
  const value = bareAddress(address)
  if (!value) return null
  const domains = domainsOf(domainOf(value))
  const mutes = await db.mailMute.findMany({
    where: {
      OR: [
        { kind: 'address', value },
        ...(domains.length ? [{ kind: 'domain', value: { in: domains } }] : []),
      ],
    },
    select: { kind: true, value: true },
  })
  const own = mutes.find((m) => m.kind === 'address')
  if (own) return { kind: 'address' as const, value: own.value }
  const domain = mutes.find((m) => m.kind === 'domain')
  return domain ? { kind: 'domain' as const, value: domain.value } : null
}

/**
 * Whether a mail left in its box waits for nobody, and why: a muted sender's; one to a sign-up
 * address whose thread no longer waits (a site's newsletter); or one sent by a machine or to a
 * list. A mail server saying an email could not be delivered stays To do.
 */
export async function noiseOf(
  db: ScopedDb,
  mail: { fromAddress: string; aliasId?: string | null; bulk: boolean; bounce?: boolean },
): Promise<Noise | null> {
  if (mail.bounce) return null
  if (await mutedSender(db, mail.fromAddress)) return 'muted'
  if (mail.aliasId) return 'sign_up'
  if (mail.bulk) return 'automatic'
  return null
}
