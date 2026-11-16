'use client'
import {
  CODEX_DEFAULT_MODEL,
  HARNESS_MODELS,
  isHarnessModel,
  modelLabel,
  PI_DEFAULT_MODEL,
  type TeammateHarness,
} from '@brigade/contracts'
import { TriangleAlert } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import { useDashboard } from '@/components/dashboard'
import { HarnessLogo } from '@/components/harness-logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectGroup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { harnessLabel, type Teammate } from '@/lib/api'

export type TeammateInput = {
  name: string
  title: string
  instructions: string
  harness: TeammateHarness
  model: string | null
}

type Harness = TeammateInput['harness']
/** Radix Select can't hold null: this stands for "the account's default model". */
const DEFAULT_MODEL = 'default'
const HARNESSES: Harness[] = ['claude_code', 'codex']

/** The Default option's line: Codex's and Pi's model is Brigade's, Claude Code's the account's. */
const defaultLine = (h: Harness) =>
  h === 'codex'
    ? modelLabel(h, CODEX_DEFAULT_MODEL)
    : h === 'pi'
      ? modelLabel(h, PI_DEFAULT_MODEL)
      : 'The account’s default model'

export function TeammateForm({
  initial,
  submitLabel,
  onSubmit,
  footer,
}: {
  initial?: Teammate
  submitLabel: string
  onSubmit: (input: TeammateInput) => Promise<void>
  /** On the left of the submit button, e.g. Archive. */
  footer?: ReactNode
}) {
  // Pi only with the pi_harness feature (docs/harnesses.md), or for a teammate already on it.
  const { me } = useDashboard()
  const harnesses: Harness[] =
    me.features?.includes('pi_harness') || initial?.harness === 'pi'
      ? [...HARNESSES, 'pi']
      : HARNESSES
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [harness, setHarness] = useState<Harness>(initial?.harness ?? 'claude_code')
  const [model, setModel] = useState<string | null>(initial?.model ?? null)
  // A model saved before the list existed stays selectable until it's changed.
  const legacy =
    initial?.model && !isHarnessModel(initial.harness, initial.model)
      ? { harness: initial.harness, model: initial.model }
      : null

  /** A picker value is `harness:model`, with DEFAULT_MODEL for the default. */
  function choose(value: string) {
    const at = value.indexOf(':')
    const next = value.slice(at + 1)
    setHarness(value.slice(0, at) as Harness)
    setModel(next === DEFAULT_MODEL ? null : next)
  }

  async function submit(form: FormData) {
    setBusy(true)
    setError(undefined)
    try {
      await onSubmit({
        name: String(form.get('name')),
        title: String(form.get('title') ?? ''),
        instructions: String(form.get('instructions') ?? ''),
        harness,
        model,
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form action={submit} className="flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          defaultValue={initial?.name}
          placeholder="Riley"
          required
          // The chief keeps its name, so @chief always reaches it.
          readOnly={initial?.kind === 'chief'}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          name="title"
          defaultValue={initial?.title}
          placeholder="Software engineer"
          maxLength={40}
        />
        <p className="text-xs text-muted-foreground">Shown as a badge beside its name.</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="instructions">Role instructions</Label>
        <Textarea
          id="instructions"
          name="instructions"
          rows={6}
          defaultValue={initial?.instructions}
          placeholder="You handle customer support for Acme. Answer from the docs, be brief, and escalate refunds."
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="model">Model</Label>
        {/* One picker for both: a model belongs to an agent, so choosing it picks the agent. */}
        <Select value={`${harness}:${model ?? DEFAULT_MODEL}`} onValueChange={choose}>
          <SelectTrigger id="model" className="w-full sm:w-80">
            <SelectValue>
              <HarnessLogo harness={harness} />
              {modelLabel(harness, model)}
              <span className="text-muted-foreground">· {harnessLabel(harness)}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-96">
            {harnesses.map((h, i) => (
              <Fragment key={h}>
                {i > 0 && <SelectSeparator />}
                <SelectGroup>
                  <SelectLabel className="flex items-center gap-2 font-semibold">
                    <HarnessLogo harness={h} className="size-3.5" />
                    {harnessLabel(h)}
                  </SelectLabel>
                  <ModelOption value={`${h}:${DEFAULT_MODEL}`} label="Default">
                    {defaultLine(h)}
                  </ModelOption>
                  {HARNESS_MODELS[h].map((m) => (
                    <ModelOption key={m.id} value={`${h}:${m.id}`} label={m.label}>
                      {m.description}
                    </ModelOption>
                  ))}
                  {legacy && legacy.harness === h && (
                    <ModelOption value={`${h}:${legacy.model}`} label={legacy.model}>
                      Saved earlier; not in the current list
                    </ModelOption>
                  )}
                </SelectGroup>
              </Fragment>
            ))}
          </SelectContent>
        </Select>
        {harness === 'codex' && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            Codex cannot ask before running commands or editing files, so its threads run them
            without asking.
          </p>
        )}
        {harness === 'pi' && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            Pi runs only on accounts named “Pi” under Accounts: use a secondary Claude or ChatGPT
            login. The providers don’t allow other apps to use these logins and may suspend the
            account. Pi has no sub-agents and can’t answer a message on the side while it works.
          </p>
        )}
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex items-center justify-end gap-3 border-t pt-5">
        {footer}
        <span className="flex-1" />
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

function ModelOption({
  value,
  label,
  children,
}: {
  value: string
  label: string
  children: string
}) {
  return (
    <SelectItem value={value} className="items-start py-2">
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{children}</span>
      </span>
    </SelectItem>
  )
}
