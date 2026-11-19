# Harnesses

A teammate's turns run on a harness (`Teammate.harness`, `TeammateHarness` in
`packages/contracts/src/runner.ts`): Claude Code or Codex, each the vendor's own CLI on its own
login, Antigravity (Google's `agy acp`, on a Google account) behind the `antigravity_harness`
feature, or Pi, behind the `pi_harness` feature. The login a turn runs on is
`loginOf(harness, model)` (`packages/contracts/src/models.ts`): Claude Code's, Codex's and
Antigravity's own, and for Pi the login of its model's vendor (a Claude model on a Claude login, a
GPT model on a ChatGPT one). Accounts, usage, limits and fallbacks are the login's.

## Antigravity

Antigravity (`apps/runner/src/harness/antigravity.ts`) is Google's own agent CLI, `agy`, driven over
the Agent Client Protocol (`agy acp`) by the AI SDK's ACP adapter (`@ai-sdk/harness-acp`). Like
Claude Code and Codex it runs as a child process under the adapter's bridge, as the teammate's
user on a cloud computer, and is handed over across a runner update.

- **Who has it.** Only where the `antigravity_harness` feature is open (docs/feature-flags.md): the
  teammate form offers it and the Accounts page Google accounts, the API refuses both without it
  (and on a runner older than `ANTIGRAVITY_PROTOCOL`), and a thread's spec is made for it only then.
  It is open to Brigade's own workspace. Google's forum guidance allows a third-party ACP client on
  a personal Google AI plan only while a person drives the session: routines and background work
  go past that, and the member accepted the risk of a suspended account (19 Nov 2026).
- **The CLI.** Not in the runner's bundle (about 260 MB): the runner downloads Google's build for
  its platform at the version pinned in `AGY_RELEASE`, checks its SHA-512 (Google's release
  manifest's), and keeps it in `<install dir>/antigravity/<version>/agy`, readable by every
  teammate. It never updates itself (`AGY_CLI_DISABLE_AUTO_UPDATE`); to move to a new version,
  change `AGY_RELEASE` (the manifests are at
  `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<platform>.json`).
  Linux and macOS only: on a Windows runner its sign-in and turns fail, saying so.
- **Its home.** The ACP adapter starts an installed agent with a home of its own under its
  bootstrap folder, which Antigravity's shell commands would inherit. What it starts is a wrapper
  its install writes (`WRAPPER_INSTALL`), which gives Antigravity the teammate's own home
  (`AGY_BRIGADE_HOME`) and the account's folder for its state (`AGY_BRIGADE_GEMINI_DIR`, passed
  as `--gemini-dir`), then runs the pinned CLI (`AGY_BRIGADE_BIN`).
- **Accounts.** A Google account signs in through Brigade like a Claude or ChatGPT one: the runner
  runs `agy acp --login`, the dashboard opens Google's page and the person pastes the code back. Its
  login is one file, `antigravity-oauth-token`, in the account's folder, readable by the runner
  alone and backed up with the others (`ACCOUNT_LOGIN_FILES`). Each turn copies it into the folder
  Antigravity runs on: the teammate's `~/.accounts/<id>/.gemini` on a cloud computer, the
  account's own on a member's machine. A Google refresh token is not spent when used, so every
  copy stays signed in, and a copy holding the same login is left as it is. A member machine's own
  `~/.gemini` login is used as it is (a machine account). The email comes from the login; the plan
  is not known.
- **Models.** Gemini models only (`HARNESS_MODELS.antigravity`): Google offers its other models to
  its own and a few named editors' clients. Default is Gemini 3.8 Flash, the model `agy` starts on.
  The thread's effort goes on the model's id (`antigravityModelId`: `gemini-3.8-flash-low`), at
  the nearest level the model has (`HarnessModel.efforts`). Which models an account has is
  Google's: Gemini 4 Neon was not offered to a Google AI Pro account on 19 Nov 2026, and a turn on
  it fails with Google's "Unknown model ID" until it is.
- **Tools.** Brigade's tools reach it through the adapter's MCP server; Antigravity names an MCP
  tool `mcp_<server>_<tool>` and adds a `toolSummary` to its input, which `resolveHostToolCall`
  strips. The browser is an MCP server of its own, started by Antigravity. Instructions are in
  `AGENTS.md` and skills in `.agents/skills`, which Antigravity reads, and the teammate's own
  instructions in its system prompt (`_meta.antigravity.systemPrompt.append`).
- **Asks.** As on Codex, a ticket or question opens and returns at once (`asksWithoutWaiting`),
  and the person's answer comes as a message; its turns run commands and edit files without
  asking (`allow-all`). The ACP adapter continues a turn frozen on a person only under the bridge it
  ran under, which a parked session no longer has, so a turn never waits on one.
- **What it lacks next to Claude Code.** No side replies (a message steers the running turn); no
  usage limits read (Google's quota errors are recognised as out of
  usage); no per-response token log (the turn's totals are counted); Windows.

## Pi

Pi (`@ai-sdk/harness-pi`, `apps/runner/src/harness/pi.ts`) runs inside the runner, not as a CLI of
its own. Its file tools and shell go through the thread's sandbox, as the teammate's Linux user.

- **Installed on first use.** The runner's bundle doesn't carry Pi: its dependencies (pi-coding-agent,
  the OpenAI, Google and AWS SDKs) would take the bundle past the 25 MiB a Worker asset may be, and
  the API serves the bundle as one (#888's deploy failed on it). The bundle carries Pi's manifest and
  lockfile (`apps/runner/pi`); the first turn on Pi installs exactly that tree with the runner's own
  pnpm (`--frozen-lockfile`, which checks each package's integrity) beside the runner, in
  `<install dir>/pi/<lockfile hash>`, where updates leave it (`apps/runner/src/pi-package.ts`). In
  the repository the devDependency's copy is used. To move Pi to a new version, change both
  `apps/runner/package.json`'s devDependency and `apps/runner/pi/package.json`, then
  `pnpm install --lockfile-only --ignore-workspace` in `apps/runner/pi`; CI's Runner bundle job
  checks the bundle's size and runs Pi's tests on an install made as runners make it.
- **Who has it.** Only where the `pi_harness` feature is open (docs/feature-flags.md): the teammate
  form offers it, the API accepts it, and a thread's spec is made for it. It is open to Brigade's
  own workspace only, to benchmark Pi against Claude Code and Codex.
- **Which accounts.** Pi runs on the same accounts as Claude Code and Codex, chosen and switched
  the same way (its model's login: `loginOf`). It calls the providers' APIs as Claude Code and Codex
  do, which the providers do not allow another client to: they may suspend a login Pi runs on. The
  member accepted that risk for the benchmark (16 Nov 2026), after an earlier version kept Pi to
  accounts named "Pi".
- **Tokens.** Pi never refreshes or writes a login. Before each request it reads the access token
  the login holds now (`loginCredentials`): a cloud computer's Claude token from `claude
setup-token` (it never expires), else Claude Code's `.credentials.json` (an expired one fails the
  turn until Claude Code refreshes it), and Codex's `auth.json`, which Codex itself refreshes when
  it is about to expire (`refreshCodexLogin`: `codex app-server`, `account/read` with
  `refreshToken`). Refresh tokens rotate, so one refresher per login keeps Claude Code and Codex
  signed in, and Brigade's backup of the login (`account-backups.ts`) the live copy.
- **Tools.** Brigade's own tools are the agent's tools, as for the other harnesses. The teammate's
  browser is an MCP server Pi's own client starts (as the teammate's user, with no environment of
  the runner's): its tools keep Claude Code's names (`mcp__browser__browser_click`), and its
  screenshots reach the model as images. Skills are written in `.agents/skills` and listed to Pi.
  Pi reads no AGENTS.md or CLAUDE.md: Brigade's instructions are its system prompt.
- **What it lacks next to Claude Code.** No sub-agents (the Agent tool) nor background tasks; no
  question tool of its own (`ask_user` is Brigade's, as for Codex); no side replies while it works
  (a message is steered into the turn instead); no prompt suggestions; no hand-over on a runner
  update (its turn continues after the restart from what it said so far); no usage limits read
  during a turn on a Claude login (a Codex login's are read after it); a usage-limit refusal may
  not be recognised as one, so the turn fails rather than pause. Context compaction is Pi's own.

## Benchmark

Each `turn.started` event says the turn's `harness` and `model`, and each `turn.completed` its
`toolCalls` and `toolErrors`. Tokens are in `TokenUsage`, by thread and teammate. One row per turn,
to compare harnesses on the same work:

```sql
WITH started AS (
  SELECT e."sessionId", e.seq, e.at, e.data->>'teammateId' AS teammate,
         coalesce(e.data->>'harness', t.harness::text) AS harness,
         coalesce(e.data->>'model', t.model, 'default') AS model
  FROM "SessionEvent" e
  JOIN "Teammate" t ON t.id = e.data->>'teammateId'
  WHERE e.type = 'turn.started' AND e.at > now() - interval '14 days'
),
turns AS (
  SELECT s.*, x.type AS ended, x.at AS ended_at, x.data AS end_data
  FROM started s
  LEFT JOIN LATERAL (
    SELECT type, at, data FROM "SessionEvent" n
    WHERE n."sessionId" = s."sessionId" AND n.seq > s.seq
      AND n.type IN ('turn.completed', 'error', 'turn.started')
    ORDER BY n.seq LIMIT 1
  ) x ON true
)
SELECT harness, model,
  count(*) AS turns,
  count(*) FILTER (WHERE ended = 'error') AS failed,
  round(avg(extract(epoch FROM ended_at - at)) FILTER (WHERE ended = 'turn.completed')) AS avg_seconds,
  sum((end_data->>'toolCalls')::int) AS tool_calls,
  sum((end_data->>'toolErrors')::int) AS tool_errors,
  sum(u.input) AS input_tokens, sum(u.output) AS output_tokens
FROM turns
LEFT JOIN LATERAL (
  SELECT sum("inputTokens") AS input, sum("outputTokens") AS output FROM "TokenUsage" k
  WHERE k."sessionId" = turns."sessionId" AND k."teammateId" = turns.teammate
    AND k.at >= turns.at AND k.at <= coalesce(turns.ended_at, now()) AND NOT k.replaced
) u ON true
GROUP BY harness, model
ORDER BY harness, model;
```

A turn that paused on a person (a ticket, an approval) ends with `turn.completed` and goes on in a
new `turn.started`: each run of it counts as a turn. Turns before this change have no `harness` on
their event; the query takes the teammate's present one. A Claude login's usage limits are in
Settings › Usage, per account: with Pi on an account of its own, that account's line is Pi's.
