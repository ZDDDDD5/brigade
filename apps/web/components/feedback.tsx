'use client'
// Give feedback: the sidebar's line opens this dialog (openFeedback). Words, and files dropped,
// pasted or picked, which upload as soon as they are added, like a message's
// (components/attachments.tsx). Sent to POST /feedback, which stores it and mails Brigade's team.
import { useEffect, useRef, useState } from 'react'
import { Check, ImagePlus } from 'lucide-react'
import { FEEDBACK_MAX } from '@brigade/contracts'
import { UploadList, useFileDrop, useUploads } from '@/components/attachments'
import { ActivityIndicator } from '@/components/ui/activity-indicator'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const OPEN_EVENT = 'brigade:feedback'

export function openFeedback() {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

export function FeedbackDialog() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string>()
  const files = useUploads()
  // While sending, nothing changes: what was sent is what the dialog shows.
  const drop = useFileDrop(files.add, open && !sent && !sending)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])

  function close(next: boolean) {
    // Not while sending: its files are being given to the feedback.
    if (!next && sending) return
    setOpen(next)
    if (next) return
    // Closed without sending: the uploads go; sent, they stay with the feedback.
    if (!sent) for (const u of files.uploads) files.remove(u.key)
    else files.clear()
    setText('')
    setError(undefined)
    setSent(false)
  }

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim() || files.busy || files.failed || sending) return
    setSending(true)
    setError(undefined)
    try {
      await api('/feedback', {
        body: {
          text,
          page: `${window.location.pathname}${window.location.search}`,
          attachmentIds: files.ids,
        },
      })
      setSent(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        {sent ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <span className="bg-muted flex size-10 items-center justify-center rounded-full">
              <Check className="size-5" />
            </span>
            <DialogHeader className="items-center text-center">
              <DialogTitle>Thanks for your feedback</DialogTitle>
              <DialogDescription>
                It went to the Brigade team. We read every one, and may reply by email.
              </DialogDescription>
            </DialogHeader>
            <Button variant="secondary" className="mt-2" onClick={() => close(false)}>
              Close
            </Button>
          </div>
        ) : (
          <form onSubmit={send} className="flex flex-col gap-4" {...drop.props}>
            <DialogHeader>
              <DialogTitle>Give feedback</DialogTitle>
              <DialogDescription className="sr-only">
                Tell the Brigade team about a bug or an idea, with screenshots or files.
              </DialogDescription>
            </DialogHeader>
            <fieldset disabled={sending} className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="feedback-text">What happened, or what would you change?</Label>
                <Textarea
                  id="feedback-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
                      e.currentTarget.form?.requestSubmit()
                  }}
                  placeholder="A bug, an idea, anything that felt off"
                  rows={5}
                  maxLength={FEEDBACK_MAX}
                  autoFocus
                  className="resize-none focus-visible:border-input focus-visible:ring-0"
                />
              </div>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => picker.current?.click()}
                  className={cn(
                    'text-muted-foreground hover:text-foreground hover:bg-muted/40 flex w-full flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-4 text-sm transition-colors',
                    drop.dragging && 'border-primary bg-muted/60 text-foreground',
                  )}
                >
                  <ImagePlus className="size-5" aria-hidden />
                  <span>
                    {drop.dragging
                      ? 'Drop to attach'
                      : 'Add screenshots or files: drop, paste or browse'}
                  </span>
                </button>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    files.add([...(e.target.files ?? [])])
                    e.target.value = ''
                  }}
                />
                <UploadList uploads={files.uploads} onRemove={files.remove} />
              </div>
            </fieldset>
            {error && <p className="text-destructive-text text-sm">{error}</p>}
            <DialogFooter className="items-center sm:justify-between">
              <span className="text-muted-foreground text-xs">Goes to the Brigade team</span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={sending}
                  onClick={() => close(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!text.trim() || files.busy || files.failed || sending}
                >
                  {sending && <ActivityIndicator label="Sending" />}
                  Send
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
