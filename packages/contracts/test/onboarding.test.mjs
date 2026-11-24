import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aboutMe,
  chiefFirstMessage,
  ONBOARDING_QUESTIONS,
  OnboardingAnswers,
} from '../dist/index.js'

// Onboarding's questions (src/onboarding.ts): the first message to the chief says what was
// answered under what the person wrote, and only answers of the closed lists are kept.

test('nothing answered, all skipped or only Other: nothing to say', () => {
  assert.equal(aboutMe(null), '')
  assert.equal(aboutMe({}), '')
  assert.equal(
    aboutMe({ role: { id: 'other', position: 9 }, firstWork: { id: 'other', position: 6 } }),
    '',
  )
  // Where they heard of Brigade is for us, never in the message.
  assert.equal(aboutMe({ heardFrom: { id: 'twitter', position: 1 } }), '')
  assert.equal(chiefFirstMessage('  northwind.app \n', {}), 'northwind.app')
})

test('the first message says who they are and what to start with, under what they wrote', () => {
  assert.equal(
    aboutMe({
      role: { id: 'founder', position: 3 },
      teamSize: { id: '2-10', position: 2 },
      firstWork: { id: 'support', position: 1 },
      heardFrom: { id: 'friend', position: 4 },
    }),
    "I'm a founder, on a team of 2–10. I'd like my team to start with customer support.",
  )
  assert.equal(aboutMe({ teamSize: { id: 'solo', position: 1 } }), "I'm working solo.")
  assert.equal(aboutMe({ role: { id: 'marketing', position: 1 } }), 'I work in marketing.')
  assert.equal(
    aboutMe({ firstWork: { id: 'code', position: 2 } }),
    "I'd like my team to start with code.",
  )
  assert.equal(
    chiefFirstMessage('northwind.app', { teamSize: { id: 'solo', position: 1 } }),
    "northwind.app\n\nI'm working solo.",
  )
})

test('only answers of the lists are kept', () => {
  assert.deepEqual(OnboardingAnswers.parse({}), {})
  assert.equal(OnboardingAnswers.safeParse({ role: { id: 'ceo', position: 1 } }).success, false)
  assert.equal(
    OnboardingAnswers.safeParse({ teamSize: { id: 'solo', position: 0 } }).success,
    false,
  )
  assert.equal(OnboardingAnswers.safeParse({ role: { id: 'founder' } }).success, false)
})

test('each question has its own ids, Other last, and a phrase for every option said', () => {
  for (const question of ONBOARDING_QUESTIONS) {
    const ids = question.options.map((o) => o.id)
    assert.equal(new Set(ids).size, ids.length, question.key)
    const other = ids.indexOf('other')
    assert.ok(other === -1 || other === ids.length - 1, `${question.key}: Other last`)
    // Every id must be a word PostHog's person properties take as it is.
    for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9_-]{0,39}$/)
  }
})
