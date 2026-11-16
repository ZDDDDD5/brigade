// A small D-Bus client for the session bus: what computer use on Linux needs of it (GNOME's
// RemoteDesktop for the pointer and keyboard on Wayland, the desktop portal's screenshots, the
// accessibility bus's state). Method calls and their replies, and signals, in the wire format of
// the D-Bus specification: little-endian, SASL EXTERNAL authentication, no file descriptors.
import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'

/** A value of type `v` to send: its signature and the value. */
export type Variant = { sig: string; value: unknown }
export const variant = (sig: string, value: unknown): Variant => ({ sig, value })

export class DBusError extends Error {
  constructor(
    readonly name: string,
    message: string,
  ) {
    super(message)
  }
}

export type Call = {
  destination: string
  path: string
  interface: string
  member: string
  signature?: string
  body?: unknown[]
}

export type Signal = {
  path: string
  interface: string
  member: string
  sender?: string
  body: unknown[]
}

const ALIGN: Record<string, number> = {
  y: 1,
  b: 4,
  n: 2,
  q: 2,
  i: 4,
  u: 4,
  x: 8,
  t: 8,
  d: 8,
  h: 4,
  s: 4,
  o: 4,
  g: 1,
  v: 1,
  a: 4,
  '(': 8,
  '{': 8,
}

/** The complete types a signature is made of: "a{sv}ii" → ["a{sv}", "i", "i"]. */
export function splitSignature(signature: string): string[] {
  const types: string[] = []
  let at = 0
  while (at < signature.length) {
    const end = completeType(signature, at)
    types.push(signature.slice(at, end))
    at = end
  }
  return types
}

function completeType(signature: string, at: number): number {
  const c = signature[at]
  if (c === 'a') return completeType(signature, at + 1)
  if (c === '(' || c === '{') {
    const close = c === '(' ? ')' : '}'
    let i = at + 1
    while (signature[i] !== close) {
      if (i >= signature.length) throw new Error(`bad signature ${signature}`)
      i = completeType(signature, i)
    }
    return i + 1
  }
  if (c === undefined || !(c in ALIGN)) throw new Error(`bad signature ${signature}`)
  return at + 1
}

class Writer {
  private chunks: Buffer[] = []
  length = 0

  constructor(private readonly base = 0) {}

  private push(buffer: Buffer) {
    this.chunks.push(buffer)
    this.length += buffer.length
  }

  align(n: number) {
    const offset = this.base + this.length
    const pad = (n - (offset % n)) % n
    if (pad) this.push(Buffer.alloc(pad))
  }

  write(type: string, value: unknown): void {
    const c = type[0]!
    this.align(ALIGN[c] ?? 1)
    switch (c) {
      case 'y': {
        const b = Buffer.alloc(1)
        b.writeUInt8(Number(value) & 0xff)
        return this.push(b)
      }
      case 'b':
      case 'u':
      case 'h': {
        const b = Buffer.alloc(4)
        b.writeUInt32LE(c === 'b' ? (value ? 1 : 0) : Number(value) >>> 0)
        return this.push(b)
      }
      case 'i': {
        const b = Buffer.alloc(4)
        b.writeInt32LE(Number(value) | 0)
        return this.push(b)
      }
      case 'n': {
        const b = Buffer.alloc(2)
        b.writeInt16LE(Number(value))
        return this.push(b)
      }
      case 'q': {
        const b = Buffer.alloc(2)
        b.writeUInt16LE(Number(value))
        return this.push(b)
      }
      case 'x': {
        const b = Buffer.alloc(8)
        b.writeBigInt64LE(BigInt(value as number))
        return this.push(b)
      }
      case 't': {
        const b = Buffer.alloc(8)
        b.writeBigUInt64LE(BigInt(value as number))
        return this.push(b)
      }
      case 'd': {
        const b = Buffer.alloc(8)
        b.writeDoubleLE(Number(value))
        return this.push(b)
      }
      case 's':
      case 'o': {
        const text = Buffer.from(String(value), 'utf8')
        const b = Buffer.alloc(4)
        b.writeUInt32LE(text.length)
        this.push(b)
        this.push(text)
        return this.push(Buffer.alloc(1))
      }
      case 'g': {
        const text = Buffer.from(String(value), 'ascii')
        this.push(Buffer.from([text.length]))
        this.push(text)
        return this.push(Buffer.alloc(1))
      }
      case 'v': {
        const { sig, value: inner } = value as Variant
        this.write('g', sig)
        return this.write(sig, inner)
      }
      case '(': {
        const fields = splitSignature(type.slice(1, -1))
        const values = value as unknown[]
        fields.forEach((field, i) => this.write(field, values[i]))
        return
      }
      case 'a': {
        const element = type.slice(1)
        const lengthAt = Buffer.alloc(4)
        this.push(lengthAt)
        // The elements start aligned, and the padding before the first is not counted.
        this.align(ALIGN[element[0]!] ?? 1)
        const start = this.length
        if (element[0] === '{') {
          const [keyType, valueType] = splitSignature(element.slice(1, -1)) as [string, string]
          const entries =
            value instanceof Map ? [...value.entries()] : Object.entries(value as object)
          for (const [k, v] of entries) {
            this.align(8)
            this.write(keyType, k)
            this.write(valueType, v)
          }
        } else if (element === 'y' && Buffer.isBuffer(value)) {
          this.push(value)
        } else {
          for (const item of value as unknown[]) this.write(element, item)
        }
        lengthAt.writeUInt32LE(this.length - start)
        return
      }
      default:
        throw new Error(`cannot write D-Bus type ${type}`)
    }
  }

  buffer() {
    return Buffer.concat(this.chunks)
  }
}

class Reader {
  constructor(
    private readonly buffer: Buffer,
    public offset = 0,
  ) {}

  align(n: number) {
    this.offset += (n - (this.offset % n)) % n
  }

  read(type: string): unknown {
    const c = type[0]!
    this.align(ALIGN[c] ?? 1)
    const b = this.buffer
    switch (c) {
      case 'y':
        return b.readUInt8(this.offset++)
      case 'b':
        return this.take(4, () => b.readUInt32LE(this.offset) !== 0)
      case 'u':
      case 'h':
        return this.take(4, () => b.readUInt32LE(this.offset))
      case 'i':
        return this.take(4, () => b.readInt32LE(this.offset))
      case 'n':
        return this.take(2, () => b.readInt16LE(this.offset))
      case 'q':
        return this.take(2, () => b.readUInt16LE(this.offset))
      case 'x':
        return this.take(8, () => Number(b.readBigInt64LE(this.offset)))
      case 't':
        return this.take(8, () => Number(b.readBigUInt64LE(this.offset)))
      case 'd':
        return this.take(8, () => b.readDoubleLE(this.offset))
      case 's':
      case 'o': {
        const length = b.readUInt32LE(this.offset)
        const text = b.toString('utf8', this.offset + 4, this.offset + 4 + length)
        this.offset += 4 + length + 1
        return text
      }
      case 'g': {
        const length = b.readUInt8(this.offset)
        const text = b.toString('ascii', this.offset + 1, this.offset + 1 + length)
        this.offset += 1 + length + 1
        return text
      }
      case 'v': {
        const sig = this.read('g') as string
        return this.read(sig)
      }
      case '(':
        return splitSignature(type.slice(1, -1)).map((field) => this.read(field))
      case 'a': {
        const element = type.slice(1)
        const length = b.readUInt32LE(this.offset)
        this.offset += 4
        this.align(ALIGN[element[0]!] ?? 1)
        const end = this.offset + length
        if (element === 'y') {
          const bytes = b.subarray(this.offset, end)
          this.offset = end
          return Buffer.from(bytes)
        }
        if (element[0] === '{') {
          const [keyType, valueType] = splitSignature(element.slice(1, -1)) as [string, string]
          const out: Record<string, unknown> = {}
          while (this.offset < end) {
            this.align(8)
            const key = this.read(keyType)
            out[String(key)] = this.read(valueType)
          }
          return out
        }
        const items: unknown[] = []
        while (this.offset < end) items.push(this.read(element))
        return items
      }
      default:
        throw new Error(`cannot read D-Bus type ${type}`)
    }
  }

  private take<T>(size: number, read: () => T): T {
    const value = read()
    this.offset += size
    return value
  }
}

/** Encodes a message: its header, padded to 8, then its body. */
export function encodeMessage(message: {
  type: 1 | 2 | 3 | 4
  serial: number
  flags?: number
  path?: string
  interface?: string
  member?: string
  destination?: string
  replySerial?: number
  signature?: string
  body?: unknown[]
}): Buffer {
  const signature = message.signature ?? ''
  const bodyWriter = new Writer(0)
  const types = splitSignature(signature)
  types.forEach((type, i) => bodyWriter.write(type, message.body?.[i]))
  const body = bodyWriter.buffer()
  const fields: [number, Variant][] = []
  if (message.path) fields.push([1, variant('o', message.path)])
  if (message.interface) fields.push([2, variant('s', message.interface)])
  if (message.member) fields.push([3, variant('s', message.member)])
  if (message.replySerial !== undefined) fields.push([5, variant('u', message.replySerial)])
  if (message.destination) fields.push([6, variant('s', message.destination)])
  if (signature) fields.push([8, variant('g', signature)])
  const header = new Writer(0)
  header.write('y', 'l'.charCodeAt(0))
  header.write('y', message.type)
  header.write('y', message.flags ?? 0)
  header.write('y', 1)
  header.write('u', body.length)
  header.write('u', message.serial)
  header.write('a(yv)', fields)
  header.align(8)
  return Buffer.concat([header.buffer(), body])
}

type Decoded = {
  type: number
  serial: number
  fields: Map<number, unknown>
  body: unknown[]
}

/** The first whole message in `buffer` and its length, or undefined while it is incomplete. */
export function decodeMessage(buffer: Buffer): { message: Decoded; length: number } | undefined {
  if (buffer.length < 16) return
  if (buffer[0] !== 'l'.charCodeAt(0))
    throw new Error('big-endian D-Bus messages are not supported')
  const bodyLength = buffer.readUInt32LE(4)
  const fieldsLength = buffer.readUInt32LE(12)
  const headerEnd = 16 + fieldsLength + ((8 - ((16 + fieldsLength) % 8)) % 8)
  const total = headerEnd + bodyLength
  if (buffer.length < total) return
  const reader = new Reader(buffer.subarray(0, headerEnd), 12)
  const fields = new Map<number, unknown>()
  for (const [code, value] of reader.read('a(yv)') as [number, unknown][]) fields.set(code, value)
  const signature = (fields.get(8) as string | undefined) ?? ''
  const bodyReader = new Reader(buffer.subarray(headerEnd, total), 0)
  const body = splitSignature(signature).map((type) => bodyReader.read(type))
  return {
    message: { type: buffer[1]!, serial: buffer.readUInt32LE(8), fields, body },
    length: total,
  }
}

/** The session bus's socket address, from DBUS_SESSION_BUS_ADDRESS or the runtime directory. */
export function sessionBusPath(env = process.env): string | undefined {
  const address = env.DBUS_SESSION_BUS_ADDRESS
  for (const entry of (address ?? '').split(';')) {
    const [transport, rest = ''] = entry.split(':', 2)
    if (transport !== 'unix') continue
    const params = new Map(
      rest.split(',').map((pair) => {
        const at = pair.indexOf('=')
        return [pair.slice(0, at), decodeURIComponent(pair.slice(at + 1))] as const
      }),
    )
    if (params.get('path')) return params.get('path')
    if (params.get('abstract')) return `\0${params.get('abstract')}`
  }
  if (env.XDG_RUNTIME_DIR) return `${env.XDG_RUNTIME_DIR}/bus`
  return undefined
}

/** One connection to the session bus. */
export class Bus extends EventEmitter {
  private serial = 1
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<
    number,
    { resolve: (body: unknown[]) => void; reject: (error: Error) => void }
  >()
  closed = false
  uniqueName = ''

  private constructor(private readonly socket: Socket) {
    super()
  }

  static async connect(path = sessionBusPath(), timeoutMs = 5000): Promise<Bus> {
    if (!path) throw new Error('There is no session bus: no DBUS_SESSION_BUS_ADDRESS')
    const socket = createConnection(path)
    const bus = new Bus(socket)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('The session bus did not answer in time'))
      }, timeoutMs)
      let text = ''
      const fail = (error: Error) => {
        clearTimeout(timer)
        reject(error)
      }
      socket.once('error', fail)
      socket.on('connect', () => {
        const uid = Buffer.from(String(process.getuid?.() ?? 0), 'ascii').toString('hex')
        socket.write(Buffer.from([0]))
        socket.write(`AUTH EXTERNAL ${uid}\r\n`)
      })
      const onData = (data: Buffer) => {
        text += data.toString('ascii')
        if (!text.includes('\r\n')) return
        socket.off('data', onData)
        socket.off('error', fail)
        if (!text.startsWith('OK ')) {
          clearTimeout(timer)
          socket.destroy()
          return reject(new Error(`The session bus refused us: ${text.trim()}`))
        }
        socket.write('BEGIN\r\n')
        clearTimeout(timer)
        resolve()
      }
      socket.on('data', onData)
    })
    socket.on('data', (data: Buffer) => bus.receive(data))
    socket.on('error', () => bus.close())
    socket.on('close', () => bus.close())
    bus.uniqueName = String(
      (
        await bus.call({
          destination: 'org.freedesktop.DBus',
          path: '/org/freedesktop/DBus',
          interface: 'org.freedesktop.DBus',
          member: 'Hello',
        })
      )[0],
    )
    return bus
  }

  private receive(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data])
    for (;;) {
      let decoded: ReturnType<typeof decodeMessage>
      try {
        decoded = decodeMessage(this.buffer)
      } catch {
        this.close()
        return
      }
      if (!decoded) return
      this.buffer = this.buffer.subarray(decoded.length)
      const { message } = decoded
      if (message.type === 2 || message.type === 3) {
        const serial = message.fields.get(5) as number
        const waiting = this.pending.get(serial)
        if (!waiting) continue
        this.pending.delete(serial)
        if (message.type === 2) waiting.resolve(message.body)
        else
          waiting.reject(
            new DBusError(
              String(message.fields.get(4) ?? 'org.freedesktop.DBus.Error.Failed'),
              String(message.body[0] ?? message.fields.get(4) ?? 'failed'),
            ),
          )
      } else if (message.type === 4) {
        const signal: Signal = {
          path: String(message.fields.get(1) ?? ''),
          interface: String(message.fields.get(2) ?? ''),
          member: String(message.fields.get(3) ?? ''),
          sender: message.fields.get(7) as string | undefined,
          body: message.body,
        }
        this.emit('signal', signal)
      }
    }
  }

  call(call: Call, timeoutMs = 30_000): Promise<unknown[]> {
    if (this.closed) return Promise.reject(new Error('The session bus connection is closed'))
    const serial = this.serial++
    const message = encodeMessage({
      type: 1,
      serial,
      path: call.path,
      interface: call.interface,
      member: call.member,
      destination: call.destination,
      ...(call.signature ? { signature: call.signature, body: call.body ?? [] } : {}),
    })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial)
        reject(new Error(`${call.interface}.${call.member} did not answer in time`))
      }, timeoutMs)
      this.pending.set(serial, {
        resolve: (body) => {
          clearTimeout(timer)
          resolve(body)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.write(message)
    })
  }

  /** Receives the signals a match rule selects ("type='signal',interface=…"). */
  async match(rule: string) {
    await this.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'AddMatch',
      signature: 's',
      body: [rule],
    })
  }

  /** A property, through org.freedesktop.DBus.Properties. */
  async property(destination: string, path: string, iface: string, name: string) {
    const [value] = await this.call({
      destination,
      path,
      interface: 'org.freedesktop.DBus.Properties',
      member: 'Get',
      signature: 'ss',
      body: [iface, name],
    })
    return value
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    for (const waiting of this.pending.values())
      waiting.reject(new Error('The session bus connection closed'))
    this.pending.clear()
    this.emit('close')
  }
}
