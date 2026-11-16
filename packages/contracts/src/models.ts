// The models a teammate can run, per harness. The single list: the teammate form's
// picker, the API's validation and the labels shown elsewhere all read it. To add a
// model when it's released, add a line to its harness below; order is display order.
import type { Effort, HarnessId, TeammateHarness } from './runner.js'

export type HarnessModel = {
  /** What the harness CLI takes as its model (Claude Code `--model`, Codex `-m`). */
  id: string
  /** As the vendor names it in its own picker. */
  label: string
  description: string
  /**
   * The effort the CLI runs it at when Brigade sends none, from the vendor's docs
   * (Claude Code's model config, OpenAI's model guide). Unset where they don't say.
   */
  effort?: Effort
}

const CLAUDE_MODELS = [
  {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    description: 'Most capable Opus for complex, agentic work.',
    effort: 'medium',
  },
  {
    id: 'claude-fable-5-2',
    label: 'Fable 5.2',
    description: 'Anthropic’s most capable model, for the hardest long tasks.',
    effort: 'high',
  },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    description: 'Previous Fable model.',
    effort: 'high',
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Sonnet 5.5',
    description: 'Fast and capable for everyday coding and agent work.',
    effort: 'medium',
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Haiku 5.5',
    description: 'Fastest and cheapest, for simple tasks.',
    effort: 'medium',
  },
] as const satisfies readonly HarnessModel[]

const CODEX_MODELS = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    description: 'Latest workhorse model for coding and everyday work.',
    effort: 'medium',
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    description: 'Frontier intelligence for the most demanding work.',
  },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', description: 'Previous generation workhorse model.' },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    description: 'Fast and affordable model for easier tasks.',
  },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Older generation workhorse model.' },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'Older balanced model for straightforward work.',
  },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'Older fast and efficient model.' },
] as const satisfies readonly HarnessModel[]

export const HARNESS_MODELS = {
  claude_code: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  // Pi calls the vendor's API itself, on the login of the model's vendor (loginOf): Claude's
  // models on a Claude login, GPT's on a ChatGPT one.
  pi: [...CLAUDE_MODELS, ...CODEX_MODELS],
} as const satisfies Record<TeammateHarness, readonly HarnessModel[]>

/** What a Pi teammate on Default runs: Pi has no account default of its own to fall back on. */
export const PI_DEFAULT_MODEL = 'claude-opus-5-5'

/**
 * What a Codex teammate on Default runs, and the image tool. The Codex adapter's
 * own default (GPT-5.5) was retired for ChatGPT sign-ins on 2026-10-14.
 */
export const CODEX_DEFAULT_MODEL = 'gpt-6.1-sol'

/** The model a turn asks for: on Default, Claude Code runs the account's own, Codex and Pi ours. */
export const runModel = (harness: TeammateHarness, model: string | null) =>
  model ?? (harness === 'codex' ? CODEX_DEFAULT_MODEL : harness === 'pi' ? PI_DEFAULT_MODEL : null)

/**
 * The login a teammate's turns run on: Claude Code's and Codex's own, and for Pi the login of its
 * model's vendor. Accounts, usage and limits are the login's; the harness only runs the turns.
 */
export const loginOf = (harness: TeammateHarness, model: string | null): HarnessId => {
  if (harness !== 'pi') return harness
  return CODEX_MODELS.some((m) => m.id === runModel(harness, model)) ? 'codex' : 'claude_code'
}

/**
 * Pi runs only on accounts a member set aside for it, by naming them "Pi …" under Accounts (a
 * secondary login, docs/harnesses.md): a provider may suspend a login Pi runs on, and the team's
 * other teammates keep theirs.
 */
export const isPiAccount = (label: string) => /^pi\b/i.test(label.trim())

/** A login's vendor, as people know it: Claude or Codex (ChatGPT). */
export const loginName = (login: HarnessId) => (login === 'codex' ? 'Codex' : 'Claude')

/** The harness as its vendor names it. */
export const harnessName = (harness: TeammateHarness) =>
  harness === 'codex' ? 'Codex' : harness === 'pi' ? 'Pi' : 'Claude Code'

/** A teammate's model: null is Default (runModel). */
export const isHarnessModel = (harness: TeammateHarness, model: string | null) =>
  model === null || HARNESS_MODELS[harness].some((m) => m.id === model)

/** The vendor's name for a model id, or the id itself for one no longer listed. */
export const modelLabel = (harness: TeammateHarness, model: string | null) =>
  model === null ? 'Default' : (HARNESS_MODELS[harness].find((m) => m.id === model)?.label ?? model)

/** A thread's effort choices, lowest first, as Claude Code and Codex name them. */
export const EFFORTS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
] as const satisfies readonly { id: Effort; label: string }[]

/** An effort's name, or Default for none. */
export const effortLabel = (effort: Effort | null) =>
  EFFORTS.find((e) => e.id === effort)?.label ?? 'Default'

/**
 * The effort a thread with none runs at, for the slider's Default mark: the model's own,
 * else Medium, the level of today's models (and a guess for the account's own model).
 */
export const defaultEffort = (harness: TeammateHarness, model: string | null): Effort => {
  const id = runModel(harness, model)
  const models: readonly HarnessModel[] = HARNESS_MODELS[harness]
  return models.find((m) => m.id === id)?.effort ?? 'medium'
}
