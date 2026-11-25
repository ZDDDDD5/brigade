'use client'

import { formatMention, type TeamRoom } from '@brigade/contracts'
import { ArrowUpRight, MessagesSquare, Plus, Settings } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { ROOMS_CHANGED } from '@/components/team-directory'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { api, useApi, type ComputersResponse } from '@/lib/api'
import { newThreadId } from '@/lib/pending-threads'

const field = 'rounded-md border bg-background px-3 py-2 text-sm'
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const statusNames: Record<string, string> = {
  starting: '启动中',
  running: '处理中',
  waiting: '待确认',
  idle: '已回复',
  paused: '已暂停',
  failed: '失败',
  done: '已完成',
}
type RoomTask = {
  id: string
  title: string
  status: string
  teammateId: string
  activeId: string
  roomStopped: boolean
  createdAt: string
  tickets: { id: string; title: string }[]
  replies: { seq: number; teammateId: string; text: string }[]
}
type RoomPage = { room: TeamRoom; tasks: RoomTask[]; next?: string | null }

function SettingsForm({ room, onSaved }: { room?: TeamRoom; onSaved: (room: TeamRoom) => void }) {
  const { teammates } = useDashboard()
  const [name, setName] = useState(room?.name ?? '')
  const [members, setMembers] = useState(
    room?.memberIds.filter((id) => teammates.some((t) => t.id === id)) ?? [],
  )
  const [manager, setManager] = useState(room?.managerId ?? '')
  const managerId = members.includes(manager) ? manager : (members[0] ?? '')
  const [error, fail] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault()
        if (busy) return
        setBusy(true)
        fail('')
        try {
          const settings = { name: name.trim(), managerId, memberIds: members }
          const saved = await api<TeamRoom>(room ? '/rooms/' + room.id : '/rooms', {
            method: room ? 'PUT' : 'POST',
            body: room ? { revision: room.revision, settings } : settings,
          })
          window.dispatchEvent(new Event(ROOMS_CHANGED))
          onSaved(saved)
        } catch (e) {
          fail(message(e))
        } finally {
          setBusy(false)
        }
      }}
    >
      <label className="grid gap-1 text-sm">
        群名称
        <input
          required
          maxLength={80}
          className={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm">群成员（至少两位）</legend>
        {teammates.map((t) => (
          <label className="flex items-center gap-2" key={t.id}>
            <input
              type="checkbox"
              checked={members.includes(t.id)}
              onChange={(e) =>
                setMembers(
                  e.target.checked ? [...members, t.id] : members.filter((id) => id !== t.id),
                )
              }
            />
            {t.name}
          </label>
        ))}
      </fieldset>
      {teammates.length < 2 && (
        <Link className="underline" href="/app/teammates/new">
          创建另一位队友
        </Link>
      )}
      <label className="grid gap-1 text-sm">
        群管理员
        <select className={field} value={managerId} onChange={(e) => setManager(e.target.value)}>
          {!members.length && <option value="">先选择成员</option>}
          {teammates
            .filter((t) => members.includes(t.id))
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy || !name.trim() || members.length < 2}>
        {room ? '保存群设置' : '创建群聊'}
      </Button>
    </form>
  )
}

export function RoomsHome() {
  const rooms = useApi<TeamRoom[]>('/rooms')
  const { teammates, me } = useDashboard()
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  return (
    <main className="mx-auto w-full max-w-3xl overflow-auto p-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">固定群聊</h1>
        {me.role !== 'viewer' && (
          <Button onClick={() => setCreating(true)}>
            <Plus />
            新建群聊
          </Button>
        )}
      </header>
      {rooms.error && <p role="alert">{rooms.error.message}</p>}
      {rooms.data?.length === 0 && (
        <p className="text-muted-foreground">选择队友并指定群管理员，就可以在这里布置任务。</p>
      )}
      {rooms.data?.map((r) => (
        <Link
          key={r.id}
          className="flex items-center gap-3 border-b py-4 hover:bg-accent"
          href={`/app/rooms/${r.id}`}
        >
          <MessagesSquare />
          <span className="flex-1 font-medium">{r.name}</span>
          <span className="text-sm text-muted-foreground">
            {r.memberIds.length} 位成员 ·{' '}
            {teammates.find((t) => t.id === r.managerId)?.name ?? '已归档'}管理
          </span>
          <ArrowUpRight size={16} />
        </Link>
      ))}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogTitle>新建群聊</DialogTitle>
          <SettingsForm
            onSaved={(r) => {
              setCreating(false)
              router.push('/app/rooms/' + r.id)
            }}
          />
        </DialogContent>
      </Dialog>
    </main>
  )
}

export function RoomWorkspace({ id }: { id: string }) {
  const [pages, setPages] = useState<string[]>([])
  const before = pages.at(-1)
  const details = useApi<RoomPage>(
    '/rooms/' + id + (before ? '?before=' + encodeURIComponent(before) : ''),
  )
  const computers = useApi<ComputersResponse>('/computers')
  const { teammates } = useDashboard()
  const [editing, setEditing] = useState(false)
  const [text, write] = useState('')
  const [targets, select] = useState<string[]>([])
  const [machine, setMachine] = useState('')
  const [pending, setPending] = useState(false)
  const [error, fail] = useState('')
  const lock = useRef(false)
  const draft = useRef<{ body: string; id: string } | null>(null)
  const resume = useRef(new Map<string, string>())
  // A task can finish on a different tab or runner while this page stays open.
  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void details.reload()
    }, 5000)
    return () => clearInterval(poll)
  }, [details.reload])
  const data = details.data
  if (!data || data.room.id !== id)
    return <p className="p-6">{details.error?.message ?? '正在打开群聊…'}</p>
  const { room, tasks } = data
  const members = teammates.filter((t) => room.memberIds.includes(t.id))
  const label = (id: string) => teammates.find((t) => t.id === id)?.name ?? '已归档队友'
  const local =
    computers.data?.computers.filter((c) => c.online && c.kind === 'member_machine') ?? []
  const computerId = local.some((c) => c.id === machine) ? machine : (local[0]?.id ?? '')
  async function act(task: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setPending(true)
    fail('')
    try {
      await task()
      await details.reload()
    } catch (e) {
      fail(message(e))
    } finally {
      lock.current = false
      setPending(false)
    }
  }
  return (
    <main className="mx-auto w-full max-w-3xl space-y-5 overflow-y-auto p-5 sm:p-8">
      <Link href="/app/rooms" className="text-sm text-muted-foreground hover:underline">
        ‹ 全部群聊
      </Link>
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{room.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理员 {label(room.managerId)} · {members.map((t) => t.name).join('、')}
          </p>
        </div>
        <Button variant="outline" onClick={() => setEditing(true)}>
          <Settings />
          群设置
        </Button>
      </header>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogTitle>群设置</DialogTitle>
          <SettingsForm
            room={room}
            onSaved={() => {
              setEditing(false)
              void details.reload()
            }}
          />
        </DialogContent>
      </Dialog>
      <form
        className="grid gap-3 rounded-lg border p-4"
        onSubmit={(e) => {
          e.preventDefault()
          void act(async () => {
            const mentions = members
              .filter((t) => targets.includes(t.id))
              .map((t) => formatMention({ kind: 'teammate', id: t.id, label: t.name }))
            const body = {
              roomId: id,
              teammateId: room.managerId,
              computerId,
              text: [...mentions, text.trim()].join(' '),
            }
            const key = JSON.stringify(body)
            if (draft.current?.body !== key) draft.current = { body: key, id: newThreadId() }
            await api('/threads', { body: { ...body, id: draft.current.id } })
            draft.current = null
            write('')
            select([])
            setPages([])
          })
        }}
      >
        <label className="grid gap-2 font-medium">
          布置任务
          <textarea
            className={field}
            rows={3}
            maxLength={96000}
            required
            value={text}
            onChange={(e) => write(e.target.value)}
            placeholder="想让队友一起做什么？"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">点名</span>
          {members.map((t) => (
            <Button
              key={t.id}
              type="button"
              size="xs"
              variant={targets.includes(t.id) ? 'default' : 'outline'}
              aria-pressed={targets.includes(t.id)}
              disabled={!targets.includes(t.id) && targets.length >= 5}
              onClick={() =>
                select(
                  targets.includes(t.id) ? targets.filter((v) => v !== t.id) : [...targets, t.id],
                )
              }
            >
              @{t.name}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-sm">
            运行电脑{' '}
            <select
              className={field}
              value={computerId}
              onChange={(e) => setMachine(e.target.value)}
            >
              {!local.length && <option value="">等待本机 Runner 上线</option>}
              {local.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={!text.trim() || !computerId || pending}>发送任务</Button>
        </div>
        {!targets.length && (
          <p className="text-xs text-muted-foreground">未点名时由 {label(room.managerId)} 接单。</p>
        )}
      </form>
      {(error || details.error || computers.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || details.error?.message || computers.error?.message}
        </p>
      )}
      <h2 className="text-lg font-semibold">群任务与回执</h2>
      {!tasks.length && (
        <p className="text-sm text-muted-foreground">群里的任务和队友回复会显示在这里。</p>
      )}
      {tasks.map((t) => (
        <article key={t.id} className="space-y-3 rounded-lg border p-4">
          <div className="flex items-baseline justify-between gap-3">
            <Link href={`/app/threads/${t.id}`} className="font-semibold hover:underline">
              {t.title}
            </Link>
            <span className="shrink-0 text-xs text-muted-foreground">
              {t.roomStopped ? '已停止接力' : (statusNames[t.status] ?? t.status)}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            负责人 {label(t.activeId)} · {new Date(t.createdAt).toLocaleString('zh-CN')}
          </p>
          {t.replies.map((r) => (
            <div className="border-l-2 pl-3 text-sm" key={r.seq}>
              <b>{label(r.teammateId)}</b>
              <p className="whitespace-pre-wrap break-words">{r.text}</p>
            </div>
          ))}
          {t.tickets.map((ticket) => (
            <p key={ticket.id} className="text-sm">
              待确认 · {ticket.title}
            </p>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href={`/app/threads/${t.id}`}>
                对话、审批与文件 <ArrowUpRight />
              </Link>
            </Button>
            {['starting', 'running', 'waiting'].includes(t.status) && !t.roomStopped && (
              <Button
                disabled={pending}
                variant="danger"
                size="sm"
                onClick={() =>
                  void act(async () => {
                    await api('/threads/' + t.id + '/interrupt', { body: {} })
                  })
                }
              >
                停止任务
              </Button>
            )}
            {(t.status === 'failed' || t.roomStopped) && (
              <Button
                disabled={pending}
                variant="outline"
                size="sm"
                onClick={() =>
                  void act(async () => {
                    if (t.roomStopped) {
                      const messageId = resume.current.get(t.id) ?? crypto.randomUUID()
                      resume.current.set(t.id, messageId)
                      await api('/threads/' + t.id + '/messages', {
                        body: { messageId, text: '请继续执行这个群任务。' },
                      })
                      resume.current.delete(t.id)
                    } else await api('/threads/' + t.id + '/retry', { body: {} })
                  })
                }
              >
                {t.roomStopped ? '继续任务' : '重试失败回合'}
              </Button>
            )}
          </div>
        </article>
      ))}
      <div className="flex gap-2">
        {before && (
          <Button variant="outline" onClick={() => setPages(pages.slice(0, -1))}>
            上一页
          </Button>
        )}
        {data.next && (
          <Button variant="outline" onClick={() => setPages([...pages, data.next!])}>
            更早任务
          </Button>
        )}
      </div>
    </main>
  )
}
