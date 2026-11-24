'use client'
// Profile: the person's own name, picture and email, as every organization they are in sees
// them (docs/settings.md). A click on the picture changes it, and each change saves on its own, as
// the workspace's name and logo do. Their email is read only: they sign in with it. Deleting the
// account is at the foot of the page.
import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { DeleteAccount } from '@/components/danger-zone'
import { shrinkLogo, uploadLogo } from '@/components/projects'
import { SettingRow, SettingsGroup } from '@/components/settings-group'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ActivityIndicator } from '@/components/ui/activity-indicator'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { settingAnchor } from '@/lib/settings-dialog'
import { chosenImage, userImageSrc } from '@/lib/user-image'

type Status = { saving: true } | { saved: true } | { error: string } | null

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || '?'

export default function ProfilePage() {
  const { me, reloadMe } = useDashboard()
  const [name, setName] = useState(me.user.name)
  /** A picture picked and still saving, shown at once. */
  const [pending, setPending] = useState<string>()
  const [status, setStatus] = useState<Status>(null)
  const file = useRef<HTMLInputElement>(null)
  const editing = useRef(false)
  /** One change at a time, in the order they were made. */
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  // A change made elsewhere shows, unless the name is being edited here.
  useEffect(() => {
    if (!editing.current) setName(me.user.name)
  }, [me.user.name])

  // "Saved" shows for a moment, then goes.
  useEffect(() => {
    if (!status || !('saved' in status)) return
    const timer = setTimeout(() => setStatus(null), 2500)
    return () => clearTimeout(timer)
  }, [status])

  function save(body: { name?: string; avatar?: string | null }) {
    setStatus({ saving: true })
    const run = queue.current.then(async () => {
      try {
        // A new picture (a data URL) goes to the bucket first; null removes it.
        const avatar = body.avatar && (await uploadLogo(body.avatar))
        await api('/me/profile', {
          method: 'PATCH',
          body: body.avatar === undefined ? body : { ...body, avatar },
        })
        await reloadMe()
        setStatus({ saved: true })
      } catch (e) {
        setStatus({ error: (e as Error).message })
        if (body.name !== undefined) setName(me.user.name)
      } finally {
        if (body.avatar !== undefined) setPending(undefined)
      }
    })
    queue.current = run
    return run
  }

  const nextName = name.trim()
  /** The name typed differs from the saved one: Save saves it. */
  const nameChanged = !!nextName && nextName !== me.user.name

  /** The name is saving: Save shows a spinner. */
  const [savingName, setSavingName] = useState(false)

  function saveName() {
    editing.current = false
    if (!nameChanged || savingName) return
    setSavingName(true)
    void save({ name: nextName }).finally(() => setSavingName(false))
  }

  function pickPicture(picked: File | undefined) {
    if (!picked) return
    const reader = new FileReader()
    reader.onload = async () => {
      const shrunk = await shrinkLogo(String(reader.result)).catch(() => null)
      if (!shrunk)
        return setStatus({ error: 'That image cannot be a picture: try a PNG or a JPEG' })
      setPending(shrunk)
      save({ avatar: shrunk })
    }
    reader.readAsDataURL(picked)
  }

  const src = pending ?? userImageSrc(me.user.image)
  /** The picture, with a pencil on it: a click changes it. */
  const picture = (
    <span className="relative block">
      <Avatar className="size-16">
        {src && <AvatarImage src={src} alt="" referrerPolicy="no-referrer" />}
        <AvatarFallback className="bg-secondary text-2xl font-bold">
          {initial(me.user.name)}
        </AvatarFallback>
      </Avatar>
      <span className="bg-card text-muted-foreground group-hover:text-foreground absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full border transition-colors">
        <Pencil className="size-3" aria-hidden />
      </span>
    </span>
  )
  const trigger =
    'group rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card'

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-extrabold tracking-tight">Profile</h1>
        <p className="text-muted-foreground max-w-prose">
          How people see you, in every organization you are in.
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <Card className="max-w-xl flex-row items-center gap-5 px-6 py-5">
          <span data-setting={settingAnchor('Picture')}>
            {chosenImage(me.user.image) || pending ? (
              <DropdownMenu>
                <DropdownMenuTrigger className={trigger} aria-label="Change your picture">
                  {picture}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => file.current?.click()}>
                    Upload a new picture
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => save({ avatar: null })}>
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <button
                type="button"
                className={trigger}
                aria-label="Upload a picture"
                onClick={() => file.current?.click()}
              >
                {picture}
              </button>
            )}
          </span>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              pickPicture(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <div data-setting={settingAnchor('Name')} className="flex min-w-0 flex-1 flex-col gap-2">
            <Label htmlFor="profile-name">Name</Label>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                saveName()
              }}
            >
              <Input
                id="profile-name"
                value={name}
                maxLength={80}
                onFocus={() => (editing.current = true)}
                onChange={(e) => {
                  editing.current = true
                  setName(e.target.value)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setName(me.user.name)
                    editing.current = false
                    requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
                  }
                }}
              />
              <Button type="submit" disabled={!nameChanged || savingName}>
                {savingName && <ActivityIndicator label="Saving" />}
                Save
              </Button>
            </form>
          </div>
        </Card>
        {status && !('saving' in status) && (
          <p
            role="status"
            className={
              'error' in status ? 'text-destructive-text text-sm' : 'text-muted-foreground text-sm'
            }
          >
            {'error' in status ? status.error : 'Saved'}
          </p>
        )}
      </div>

      {!me.guest && (
        <SettingsGroup title="Account">
          <SettingRow
            title="Email"
            detail={<span className="text-foreground font-medium">{me.user.email}</span>}
          />
        </SettingsGroup>
      )}

      <DeleteAccount />
    </div>
  )
}
