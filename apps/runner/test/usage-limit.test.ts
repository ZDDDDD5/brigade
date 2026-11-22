// Claude Code's out-of-usage messages: an account that ran out moves the thread to the member's
// next account, never shows as the teammate failing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '@brigade/contracts'
import { EventMapper } from '../src/harness/events.js'

test('recognises the limits Claude Code names, as running out of usage', () => {
  for (const message of [
    "You've hit your 5-hour limit · resets 3:40pm (UTC)",
    "You've hit your weekly limit · resets Nov 20, 9am",
    "You've hit your Opus limit",
    "You've hit your limit",
    'Claude AI usage limit reached|1763307600',
  ])
    assert.ok(EventMapper.exhaustedBy(message), message)
  assert.equal(EventMapper.exhaustedBy('API Error: 500 Internal server error'), undefined)
})

test("a limit's error message is no error of the thread's, and keeps when its limit resets", () => {
  const events: AgentEvent[] = []
  const mapper = new EventMapper((event) => events.push(event))
  mapper.map({
    type: 'raw',
    rawValue: {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1763307600 },
    },
  } as never)
  mapper.map({
    type: 'error',
    error: new Error("You've hit your 5-hour limit · resets 3:40pm (UTC)"),
  } as never)
  assert.equal(events.filter((e) => e.type === 'error').length, 0)
  assert.equal(mapper.exhausted?.resetsAt, new Date(1763307600 * 1000).toISOString())
})
