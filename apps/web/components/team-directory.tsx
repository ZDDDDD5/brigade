'use client'

import {
  emptyDirectory,
  type DirectoryLayout,
  type DirectoryState,
  type TeamRoom,
} from '@brigade/contracts'
import { ChevronDown, ChevronRight, FolderTree, MessagesSquare, Pin } from 'lucide-react'
import Link from 'next/link'
import { Fragment, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { api, useApi, type Teammate } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'

export const ROOMS_CHANGED = 'brigade:rooms-changed'

function move<T>(list: T[], item: T, target: T) {
  if (item === target || !list.includes(item) || !list.includes(target)) return list
  const result = list.filter((value) => value !== item)
  result.splice(list.indexOf(target), 0, item)
  return result
}

export function TeamDirectory({
  teammates,
  renderBot,
}: {
  teammates: Teammate[]
  renderBot: (t: Teammate, drag: ComponentProps<'li'>) => ReactNode
}) {
  const prefs = useApi<DirectoryState>('/me/directory')
  const rooms = useApi<TeamRoom[]>('/rooms')
  const [draft, edit] = useState<DirectoryLayout | null>(null)
  const [version, setVersion] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const dragId = useRef('')
  const reloadRooms = rooms.reload
  useEffect(() => {
    const changed = () => void reloadRooms()
    window.addEventListener(ROOMS_CHANGED, changed)
    return () => window.removeEventListener(ROOMS_CHANGED, changed)
  }, [reloadRooms])
  const saved = prefs.data?.layout ?? emptyDirectory
  const bots = new Map(teammates.map((t) => ['bot:' + t.id, t]))
  const chats = new Map(rooms.data?.map((r) => ['room:' + r.id, r]))
  const ids = [...bots.keys(), ...chats.keys()]
  const ordered = (layout: DirectoryLayout) =>
    [...new Set([...layout.order, ...ids])].filter((id) => bots.has(id) || chats.has(id))
  const name = (id: string) => bots.get(id)?.name ?? chats.get(id)?.name ?? id
  async function save(layout: DirectoryLayout, revision = prefs.data?.revision) {
    if (lock.current || revision === undefined) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const response = await api<DirectoryState>('/me/directory', {
        method: 'PUT',
        body: { revision, layout },
      })
      prefs.setData(response)
      edit(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      await prefs.reload()
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const drag = (id: string): ComponentProps<'li'> => ({
    draggable: true,
    onDragStart: (e) => {
      dragId.current = id
      e.dataTransfer.setData('text/plain', id)
    },
    onDragEnd: () => {
      dragId.current = ''
    },
    onDragOver: (e) => {
      if (dragId.current) e.preventDefault()
    },
    onDrop: (e) => {
      if (!dragId.current) return
      e.preventDefault()
      const item = dragId.current
      dragId.current = ''
      const order = move(ordered(saved), item, id)
      const group = saved.groups.find((g) => g.items.includes(id))
      const groups = saved.groups.map((g) => ({
        ...g,
        items: [...g.items.filter((key) => key !== item), ...(g.id === group?.id ? [item] : [])],
      }))
      void save({ ...saved, order, groups })
    },
  })
  const row = (id: string) => {
    const bot = bots.get(id)
    if (bot) return renderBot(bot, drag(id))
    const room = chats.get(id)!
    return (
      <SidebarMenuItem key={id} {...drag(id)}>
        <SidebarMenuButton asChild>
          <Link href={`/app/rooms/${room.id}`}>
            <MessagesSquare />
            <span>{room.name}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }
  const all = ordered(saved)
  const pinned = all.filter((id) => saved.pins.includes(id))
  const free = all.filter((id) => !saved.pins.includes(id))
  const failure = error || prefs.error?.message || rooms.error?.message
  return (
    <>
      <SidebarMenuItem className="flex items-center">
        <SidebarMenuButton asChild>
          <Link href="/app/rooms">
            <MessagesSquare />
            <span>固定群聊</span>
          </Link>
        </SidebarMenuButton>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="整理队友和群聊"
          disabled={!prefs.data}
          onClick={() => {
            edit(saved)
            setVersion(prefs.data!.revision)
            setError('')
          }}
        >
          <FolderTree />
        </Button>
      </SidebarMenuItem>
      {failure && !draft && (
        <li className="p-2 text-xs text-destructive" role="alert">
          {failure}
        </li>
      )}
      {pinned.length > 0 && (
        <li className="flex items-center gap-1 px-2 text-xs text-muted-foreground">
          <Pin size={12} />
          置顶
        </li>
      )}
      {pinned.map(row)}
      {saved.groups.map((g) => (
        <Fragment key={g.id}>
          <li>
            <button
              className="flex w-full items-center gap-1 px-2 py-1 text-xs text-muted-foreground"
              aria-expanded={!g.collapsed}
              disabled={busy}
              onClick={() =>
                void save({
                  ...saved,
                  groups: saved.groups.map((x) =>
                    x.id === g.id ? { ...x, collapsed: !x.collapsed } : x,
                  ),
                })
              }
            >
              {g.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />} {g.name}
            </button>
          </li>
          {!g.collapsed && free.filter((id) => g.items.includes(id)).map(row)}
        </Fragment>
      ))}
      {saved.groups.length > 0 && <li className="px-2 text-xs text-muted-foreground">未分组</li>}
      {free.filter((id) => !saved.groups.some((g) => g.items.includes(id))).map(row)}
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open && !busy) edit(null)
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogTitle>整理队友和群聊</DialogTitle>
          {draft && (
            <>
              <h3 className="font-medium">我的分组</h3>
              {draft.groups.map((g) => (
                <div className="flex gap-2" key={g.id}>
                  <input
                    aria-label="分组名称"
                    className="min-w-0 flex-1 rounded-md border px-2"
                    maxLength={64}
                    value={g.name}
                    onChange={(e) =>
                      edit({
                        ...draft,
                        groups: draft.groups.map((x) =>
                          x === g ? { ...g, name: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => edit({ ...draft, groups: draft.groups.filter((x) => x !== g) })}
                  >
                    解散分组
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                onClick={() =>
                  edit({
                    ...draft,
                    groups: [
                      ...draft.groups,
                      { id: crypto.randomUUID(), name: '新分组', collapsed: false, items: [] },
                    ],
                  })
                }
              >
                添加分组
              </Button>
              <h3 className="font-medium">显示顺序</h3>
              {ordered(draft).map((id, i, keys) => (
                <div key={id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-20 flex-1 truncate">{name(id)}</span>
                  <button
                    aria-label={`置顶 ${name(id)}`}
                    aria-pressed={draft.pins.includes(id)}
                    className="rounded p-1 aria-pressed:bg-accent"
                    onClick={() =>
                      edit({
                        ...draft,
                        pins: draft.pins.includes(id)
                          ? draft.pins.filter((v) => v !== id)
                          : [...draft.pins, id],
                      })
                    }
                  >
                    <Pin size={16} />
                  </button>
                  <select
                    aria-label={`${name(id)} 所在分组`}
                    className="max-w-28 rounded border px-1"
                    value={draft.groups.find((g) => g.items.includes(id))?.id ?? ''}
                    onChange={(e) =>
                      edit({
                        ...draft,
                        groups: draft.groups.map((g) => ({
                          ...g,
                          items: [
                            ...g.items.filter((x) => x !== id),
                            ...(g.id === e.target.value ? [id] : []),
                          ],
                        })),
                      })
                    }
                  >
                    <option value="">未分组</option>
                    {draft.groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                  {[-1, 1].map((step) => (
                    <button
                      key={step}
                      aria-label={`${step < 0 ? '上移' : '下移'} ${name(id)}`}
                      disabled={!keys[i + step]}
                      className="px-1 disabled:opacity-30"
                      onClick={() => edit({ ...draft, order: move(keys, id, keys[i + step]!) })}
                    >
                      {step < 0 ? '↑' : '↓'}
                    </button>
                  ))}
                </div>
              ))}
              {error && (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              )}
              <Button
                disabled={busy || draft.groups.some((g) => !g.name.trim())}
                onClick={() => void save(draft, version)}
              >
                保存整理
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
