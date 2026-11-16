# Harnesses

A teammate's turns run on a harness (`Teammate.harness`, `TeammateHarness` in
`packages/contracts/src/runner.ts`): Claude Code or Codex, each the vendor's own CLI on its own
login, or Pi, behind the `pi_harness` feature. The login a turn runs on is `loginOf(harness, model)`
(`packages/contracts/src/models.ts`): Claude Code's and Codex's own, and for Pi the login of its
model's vendor (a Claude model on a Claude login, a GPT model on a ChatGPT one). Accounts, usage,
limits and fallbacks are the login's.

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
- **Which accounts.** Pi calls the providers' APIs as Claude Code and Codex do, which the providers
  do not allow another client to: they may suspend a login Pi runs on. So Pi runs only on accounts
  whose name starts with "Pi" under Accounts (`isPiAccount`), a secondary login set aside for it,
  and never falls back to the member's others. A Pi thread with none says so and does not run.
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
