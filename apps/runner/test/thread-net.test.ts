import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'
import {
  asTeammate,
  dockerSocket,
  netWithTries,
  syncHoldersAfterRestore,
} from '../src/thread-net.js'

// What runs as a teammate finds the runner's Node first: sudo's PATH has only the system's.
const withNode = [
  '/bin/sh',
  '-c',
  'PATH="$0${PATH:+:$PATH}"; export PATH; exec "$@"',
  dirname(process.execPath),
]

test("a teammate's command runs in its thread's network when the thread has one", () => {
  assert.deepEqual(asTeammate('bt-ada', { thread: 'cmthread1', address: '10.231.0.6' }), {
    file: 'sudo',
    args: ['-n', '-E', '/usr/local/sbin/brigade-thread', 'run', 'cmthread1', 'bt-ada', ...withNode],
  })
  // With its own /tmp, processes and IPC too: in all of its namespaces.
  assert.deepEqual(
    asTeammate('bt-ada', { thread: 'cmthread1', address: '10.231.0.6', isolated: true }),
    {
      file: 'sudo',
      args: [
        '-n',
        '-E',
        '/usr/local/sbin/brigade-thread',
        'enter',
        'cmthread1',
        'bt-ada',
        ...withNode,
      ],
    },
  )
  // Without one, as before: the teammate's user on the computer's network.
  assert.deepEqual(asTeammate('bt-ada', null), {
    file: 'sudo',
    args: ['-n', '-E', '-u', 'bt-ada', '--', ...withNode],
  })
})

test("a teammate's Docker socket in a thread is where the helper puts it", () => {
  assert.equal(
    dockerSocket('cmthread1', 'bt-ada'),
    '/run/brigade-docker/cmthread1/bt-ada/docker.sock',
  )
})

test("a teammate's command finds the runner's Node first, then sudo's PATH", () => {
  // The wrapper the teammate's command runs through, here without sudo.
  const { args } = asTeammate('bt-ada', null, '/opt/brigade/node/bin')
  const wrapper = args.slice(args.indexOf('--') + 1)
  assert.equal(wrapper[0], '/bin/sh')
  const out = execFileSync(wrapper[0]!, [...wrapper.slice(1), 'sh', '-c', 'printf %s "$PATH"'], {
    env: { PATH: '/usr/bin:/bin' },
  }).toString()
  assert.equal(out, '/opt/brigade/node/bin:/usr/bin:/bin')
  // Its arguments reach it untouched.
  const echoed = execFileSync(
    wrapper[0]!,
    [...wrapper.slice(1), 'sh', '-c', 'printf "%s|" "$@"', 'sh', 'a b', '$HOME', ''],
    { env: { PATH: '/usr/bin:/bin' } },
  ).toString()
  assert.equal(echoed, 'a b|$HOME||')
})

test("a thread's network is tried again when the helper fails, and never left to the computer's", async () => {
  const net = { thread: 'cmthread1', address: '10.231.0.6' }
  // Its lock held by the other threads' (a resumed computer bringing them all back): then up.
  let calls = 0
  const made = await netWithTries(
    'cmthread1',
    async () => {
      if (++calls < 3) throw Object.assign(new Error('timed out'), { stderr: '' })
      return net
    },
    3,
    1,
  )
  assert.deepEqual(made, net)
  assert.equal(calls, 3)
  // Failing each time: the thread's command fails with why, rather than running without it.
  await assert.rejects(
    netWithTries(
      'cmthread1',
      async () => {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'brigade-thread: no address left\n',
        })
      },
      2,
      1,
    ),
    /own network could not be set up on the computer \(brigade-thread: no address left\)/,
  )
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("the threads' holders are brought in line once boat has restored the disk, not while it does", async () => {
  // Restoring for the first checks, then restored.
  let restoringFor = 3
  const syncs: number[] = []
  const started = Date.now()
  const stop = syncHoldersAfterRestore(
    async () => restoringFor-- > 0,
    async () => void syncs.push(Date.now() - started),
    { everyMs: 10, afterMs: [20, 60], forMs: 1000 },
  )
  await pause(25)
  assert.equal(syncs.length, 0, 'nothing while the disk is restored')
  await pause(150)
  stop()
  // Once some time after, and once more later: boat retires its mounts after saying so.
  assert.equal(syncs.length, 2)
  assert.ok(syncs[1]! - syncs[0]! >= 30)
})

test('a runner that starts after the restore brings the holders in line once, and only once', async () => {
  let syncs = 0
  const stop = syncHoldersAfterRestore(
    async () => false,
    async () => void syncs++,
    { everyMs: 5, afterMs: [10], forMs: 1000 },
  )
  await pause(80)
  stop()
  assert.equal(syncs, 1)
})

test('a failing check counts as restored, and stopping cancels what was planned', async () => {
  let syncs = 0
  const stop = syncHoldersAfterRestore(
    async () => {
      throw new Error('no restore files')
    },
    async () => void syncs++,
    { everyMs: 5, afterMs: [40], forMs: 1000 },
  )
  await pause(15)
  stop()
  await pause(50)
  assert.equal(syncs, 0)
})
