'use client'
import type { TeammateHarness } from '@brigade/contracts'
import { TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { ModelSelect, type ModelChoice } from '@/components/model-select'
import { Button } from '@/components/ui/button'
import { ActivityIndicator } from '@/components/ui/activity-indicator'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { Teammate } from '@/lib/api'

export type TeammateInput = {
  name: string
  title: string
  instructions: string
  harness: TeammateHarness
  model: string | null
}

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
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const saved: ModelChoice | undefined = initial && {
    harness: initial.harness,
    model: initial.model,
  }
  const [{ harness, model }, setChoice] = useState<ModelChoice>(
    saved ?? { harness: 'claude_code', model: null },
  )

  async function submit(form: FormData) {
    if (busy) return
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
    <form
      // React form actions reset uncontrolled fields (including Radix's native select)
      // after success. Settings must keep the values the member just saved.
      onSubmit={(event) => {
        event.preventDefault()
        void submit(new FormData(event.currentTarget))
      }}
      className="flex w-full max-w-2xl flex-col gap-6"
    >
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
        <ModelSelect id="model" value={{ harness, model }} saved={saved} onChange={setChoice} />
        {harness === 'codex' && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            Codex cannot ask before running commands or editing files, so its threads run them
            without asking.
          </p>
        )}
        {harness === 'antigravity' && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            Antigravity runs on a Google account you sign in to under Accounts, with Google’s own
            Antigravity CLI. Google allows other apps to drive it only while a person is in the
            session, so it may suspend an account used by routines or background work. Its threads
            run commands and edit files without asking, and it can’t answer a message on the side
            while it works.
          </p>
        )}
        {harness === 'pi' && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            Pi runs on the same Claude and ChatGPT accounts as your other teammates. The providers
            don’t allow other apps to use these logins and may suspend the account. Pi has no
            sub-agents and can’t answer a message on the side while it works.
          </p>
        )}
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex items-center justify-end gap-3 border-t pt-5">
        {footer}
        <span className="flex-1" />
        <Button type="submit" disabled={busy} aria-busy={busy}>
          {busy && <ActivityIndicator label="Saving" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}
