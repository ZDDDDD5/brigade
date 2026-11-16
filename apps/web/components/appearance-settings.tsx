'use client'
// Preferences → Appearance (docs/themes.md): the member's own themes in this workspace, which a
// teammate makes with them, as a gallery of small previews. A click wears one; its menu exports
// or deletes it. Suggested themes are a click from being theirs. The history folds into a line.
// Only theirs: nobody else's windows change.
import {
  SAFE_LOOK_PARAM,
  THEME_EXPORT_VERSION,
  THEME_RESET_SHORTCUT,
  ThemeExport,
  themeSwatch,
  type LookChange,
  type ThemeList,
  type ThemeSwatch,
} from '@brigade/contracts'
import { Check, ChevronRight, MoreHorizontal, Plus } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { SettingsGroup } from '@/components/settings-group'
import { useWornTheme } from '@/components/theme-runtime'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ActivityIndicator } from '@/components/ui/activity-indicator'
import { api, blobOfDataUrl, uploadFile, useApi } from '@/lib/api'
import { invalidateThemeLoads, wearInWindow } from '@/lib/theme-runtime'
import { settingAnchor } from '@/lib/settings-dialog'
import { SUGGESTED_THEMES, type SuggestedTheme } from '@/lib/suggested-themes'
import { cn } from '@/lib/utils'

/** A look change in a few words. */
export function lookChangeText(change: Pick<LookChange, 'kind' | 'name' | 'count'>): string {
  switch (change.kind) {
    case 'made':
      return `Made ${change.name}`
    case 'edited':
      return `Edited ${change.name}`
    case 'wore':
      return `Wore ${change.name}`
    case 'off':
      return 'Took the theme off'
    case 'deleted':
      return `Deleted ${change.name}`
    case 'undid':
      return `Went back ${change.count === 1 ? '1 change' : `${change.count} changes`}`
  }
}

const dataUrlOf = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    reader.readAsDataURL(blob)
  })

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function AppearanceSection() {
  const { data, reload } = useApi<ThemeList>('/themes', ['theme.changed'])
  const { safe } = useWornTheme()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const importer = useRef<HTMLInputElement>(null)

  async function run(key: string, work: () => Promise<unknown>) {
    setBusy(key)
    setError(undefined)
    try {
      await work()
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const wear = (id: string | null) =>
    run(`wear:${id}`, async () => {
      if (id === null) {
        invalidateThemeLoads()
        wearInWindow(null)
      }
      await api('/themes/active', { method: 'PUT', body: { id } })
    })

  const goBack = (seq: number) => run(`undo:${seq}`, () => api('/themes/undo', { body: { seq } }))

  const remove = (id: string) =>
    run(`delete:${id}`, () => api(`/themes/${id}`, { method: 'DELETE' }))

  const exportTheme = (id: string) =>
    run(`export:${id}`, async () => {
      const theme = await api<{ theme: unknown; files: Record<string, string> }>(`/themes/${id}`)
      const files: Record<string, string> = {}
      for (const [name, url] of Object.entries(theme.files)) {
        const response = await fetch(url, {
          credentials: url.startsWith('http') ? 'omit' : 'include',
        })
        if (!response.ok) throw new Error(`Could not read ${name}`)
        files[name] = await dataUrlOf(await response.blob())
      }
      const out = { brigadeTheme: THEME_EXPORT_VERSION, theme: theme.theme, files }
      download(`${id}.brigade-theme.json`, JSON.stringify(out, null, 2))
    })

  const importTheme = (file: File) =>
    run('import', async () => {
      let parsed: ReturnType<typeof ThemeExport.safeParse>
      try {
        parsed = ThemeExport.safeParse(JSON.parse(await file.text()))
      } catch {
        throw new Error('That file is not a Brigade theme.')
      }
      if (!parsed.success)
        throw new Error('That file is not a Brigade theme, or not one this Brigade reads.')
      const uploads: Record<string, string> = {}
      for (const [name, dataUrl] of Object.entries(parsed.data.files ?? {})) {
        const upload = await uploadFile('theme_file', blobOfDataUrl(dataUrl), { name })
        uploads[name] = upload.id
      }
      await api('/themes/import', { body: { theme: parsed.data.theme, files: uploads } })
    })

  // A suggested theme becomes the member's own, saved under its id and worn, as an import is.
  const addSuggested = (suggested: SuggestedTheme) =>
    run(`add:${suggested.id}`, () =>
      api('/themes/import', { body: { id: suggested.id, theme: suggested.theme } }),
    )

  const themes = data?.themes ?? []
  const history = data?.history ?? []
  const saved = new Set(themes.map((theme) => theme.id))
  const suggestions = SUGGESTED_THEMES.filter((suggested) => !saved.has(suggested.id))
  return (
    <SettingsGroup title="Appearance">
      <div data-setting={settingAnchor('Themes')} className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">Themes</p>
          <p className="text-xs text-muted-foreground">Ask a teammate for a new one</p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <ThemeTile
            name="Brigade"
            title="Brigade’s own look, light or dark as you pick in your menu"
            swatch={OWN_LOOK}
            worn={!!data && !data.active}
            busy={busy === 'wear:null'}
            disabled={!!busy}
            onPick={() => void wear(null)}
          />
          {themes.map((theme) => (
            <ThemeTile
              key={theme.id}
              name={theme.name}
              title={theme.hasCss ? `${theme.name}, with its own CSS` : theme.name}
              swatch={theme.swatch}
              worn={data?.active === theme.id}
              busy={busy === `wear:${theme.id}`}
              disabled={!!busy}
              onPick={() => void wear(theme.id)}
              menu={
                <>
                  <DropdownMenuItem onSelect={() => void exportTheme(theme.id)}>
                    Export
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => void remove(theme.id)}>
                    Delete
                  </DropdownMenuItem>
                </>
              }
            />
          ))}
          <div data-setting={settingAnchor('Import a theme')}>
            <input
              ref={importer}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void importTheme(file)
              }}
            />
            <button
              type="button"
              disabled={!!busy}
              title="A .brigade-theme.json someone exported. Checked like a teammate’s: it loads nothing from the internet."
              onClick={() => importer.current?.click()}
              className="flex size-full min-h-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
            >
              {busy === 'import' ? <ActivityIndicator /> : <Plus className="size-4" />}
              Import
            </button>
          </div>
        </div>
      </div>

      {suggestions.length > 0 && (
        <div
          data-setting={settingAnchor('Suggested themes')}
          className="flex flex-col gap-3 px-5 py-4"
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium">Suggested</p>
            <p className="text-xs text-muted-foreground">A click adds one and wears it</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {suggestions.map((suggested) => (
              <ThemeTile
                key={suggested.id}
                name={suggested.theme.name}
                title={suggested.blurb}
                detail={suggested.blurb}
                swatch={themeSwatch(suggested.theme)}
                worn={false}
                busy={busy === `add:${suggested.id}`}
                disabled={!!busy}
                onPick={() => void addSuggested(suggested)}
              />
            ))}
          </div>
        </div>
      )}

      {history.length > 0 && <History history={history} busy={busy} onGoBack={goBack} />}

      <div className="flex flex-col gap-1 px-5 py-3 text-xs text-muted-foreground">
        <p>
          Only your windows change. {THEME_RESET_SHORTCUT} takes a theme off, and ?{SAFE_LOOK_PARAM}{' '}
          in the address opens a tab without it.
        </p>
        {safe && <p>This tab keeps Brigade’s own look (safe look).</p>}
      </div>
      {error && <p className="px-5 py-3 text-xs text-destructive-text">{error}</p>}
    </SettingsGroup>
  )
}

/** Brigade's own look in its preview: the light one, whatever the member wears now. */
const OWN_LOOK: ThemeSwatch = {
  background: '#fafafa',
  sidebar: '#efeff3',
  card: '#e4e4e7',
  primary: '#7c3aed',
}

/** A theme drawn small: its sidebar, a reply and a message, in its own colours. */
function ThemePreview({ swatch }: { swatch: ThemeSwatch }) {
  const background = swatch.background ?? swatch.canvas ?? 'var(--background)'
  const sidebar = swatch.sidebar ?? `color-mix(in srgb, ${background} 86%, #808080)`
  const card = swatch.card ?? `color-mix(in srgb, ${background} 88%, #808080)`
  const accent = swatch.primary ?? swatch.accent ?? 'var(--primary)'
  return (
    <span aria-hidden className="flex h-14 w-full" style={{ background }}>
      <span className="flex w-[28%] flex-col gap-1 px-1.5 py-2" style={{ background: sidebar }}>
        {[0, 1, 2].map((line) => (
          <span
            key={line}
            className="h-[3px] rounded-full opacity-50"
            style={{ background: accent }}
          />
        ))}
      </span>
      <span className="flex flex-1 flex-col items-end gap-1.5 px-2 py-2">
        <span className="h-1.5 w-3/5 rounded-full" style={{ background: accent }} />
        <span className="h-1.5 w-4/5 rounded-full" style={{ background: card }} />
      </span>
    </span>
  )
}

function ThemeTile({
  name,
  title,
  detail,
  swatch,
  worn,
  busy,
  disabled,
  onPick,
  menu,
}: {
  name: string
  title: string
  detail?: string
  swatch: ThemeSwatch
  worn: boolean
  busy: boolean
  disabled: boolean
  onPick: () => void
  menu?: ReactNode
}) {
  return (
    <div className="group/tile relative">
      <button
        type="button"
        title={title}
        aria-pressed={worn}
        disabled={disabled}
        onClick={worn ? undefined : onPick}
        className={cn(
          'flex w-full flex-col overflow-hidden rounded-lg bg-muted text-left ring-offset-2 ring-offset-card transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
          worn ? 'ring-2 ring-primary' : 'hover:ring-1 hover:ring-border',
        )}
      >
        <ThemePreview swatch={swatch} />
        <span className="flex min-w-0 flex-col gap-0.5 px-2 py-1.5">
          <span className="flex items-center gap-1.5 text-xs">
            <span className="truncate">{name}</span>
            {busy && <ActivityIndicator />}
          </span>
          {detail && (
            <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
              {detail}
            </span>
          )}
        </span>
      </button>
      {worn && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute top-1.5 right-1.5 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground',
            menu && 'group-focus-within/tile:opacity-0 group-hover/tile:opacity-0',
          )}
        >
          <Check className="size-3" />
        </span>
      )}
      {menu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="secondary"
              aria-label={`More for ${name}`}
              className="absolute top-1 right-1 size-6 opacity-0 group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

/** "Today", "Yesterday" or the date, for the history's day headings. */
function dayLabel(at: Date, now = new Date()): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(at)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return at.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/** The last look changes, folded into one line until opened, by day. */
function History({
  history,
  busy,
  onGoBack,
}: {
  history: LookChange[]
  busy: string | null
  onGoBack: (seq: number) => void
}) {
  const [open, setOpen] = useState(false)
  const shown = history.slice(0, 10)
  let lastDay = ''
  return (
    <div className="flex flex-col px-5 py-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="flex items-center justify-between gap-3 text-xs text-muted-foreground hover:text-foreground"
      >
        <span>
          History · {history.length} change{history.length === 1 ? '' : 's'}
        </span>
        <span className="flex items-center gap-0.5">
          {open ? 'Hide' : 'Show'}
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        </span>
      </button>
      {open && (
        <ol className="mt-2 flex flex-col">
          {shown.map((change, index) => {
            const at = new Date(change.at)
            const day = dayLabel(at)
            const heading = day !== lastDay ? day : null
            lastDay = day
            return (
              <li key={change.seq} className="flex flex-col">
                {heading && (
                  <span className="mt-2 mb-1 px-1.5 text-[11px] text-muted-foreground first:mt-0">
                    {heading}
                  </span>
                )}
                <span className="group/change flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted">
                  <time
                    dateTime={change.at}
                    className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground"
                  >
                    {at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </time>
                  <span className="min-w-0 truncate">
                    {lookChangeText(change)}
                    {change.by && <span className="text-muted-foreground"> · {change.by}</span>}
                  </span>
                  {index === 0 ? (
                    <span className="ml-auto shrink-0 text-muted-foreground">Now</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-6 shrink-0 px-2 text-xs opacity-0 group-hover/change:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                      disabled={!!busy}
                      onClick={() => onGoBack(change.seq)}
                    >
                      {busy === `undo:${change.seq}` ? <ActivityIndicator /> : 'Go back here'}
                    </Button>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
