import s from './home.module.css'

/** The home page's class names, written as in the design ("btn ink lg"), mapped to this
 * module's. A name the module does not define passes through as is. */
export function h(names: string) {
  return names
    .split(' ')
    .map((n) => s[n] ?? n)
    .join(' ')
}

export const PEBBLE =
  'M56 0A44 56 0 0 1 100 56A40 44 0 0 1 60 100A60 54 0 0 1 0 46A56 46 0 0 1 56 0Z'

/** The sample workspace's teammates, as their pebbles: colour and whether their eyes smile. */
export const TEAMMATES = {
  riley: { name: 'Riley', job: 'engineer', fill: 'oklch(0.62 0.22 290)', smile: true },
  sam: { name: 'Sam', job: 'support', fill: 'oklch(0.78 0.16 155)', smile: false },
  mark: { name: 'Mark', job: 'marketing', fill: 'oklch(0.74 0.17 50)', smile: true },
  lea: { name: 'Léa', job: 'sales', fill: 'oklch(0.72 0.13 250)', smile: false },
} as const
export type TeammateId = keyof typeof TEAMMATES

/** A teammate's pebble avatar, drawn like Brigade's logo. */
export function PebbleAvatar({ id, className }: { id: TeammateId; className?: string }) {
  const t = TEAMMATES[id]
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className={className}>
      <path fill={t.fill} d={PEBBLE} />
      {t.smile ? (
        <g fill="none" stroke="#190d2b" strokeWidth="6" strokeLinecap="round">
          <path d="M34.5 44Q40.5 28 46.5 44" />
          <path d="M53.5 44Q59.5 28 65.5 44" />
        </g>
      ) : (
        <g fill="#190d2b">
          <ellipse cx="40.5" cy="40" rx="5" ry="7" />
          <ellipse cx="59.5" cy="40" rx="5" ry="7" />
        </g>
      )}
    </svg>
  )
}
