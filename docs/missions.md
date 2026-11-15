# Missions

An experiment, behind the `missions` feature (docs/feature-flags.md). A mission is ongoing work a
member delegated to a teammate ("Grow the LinkedIn page", "Answer invoicing questions on Reddit"):
the object that ties together the threads, routines, planned actions and outputs of that work, so the
member sees at a glance what is in progress, what is planned and what waits on them, without opening
every thread and file.

Missions are for ongoing work only. Lists stay the checklists of deliverables (docs/lists.md), and the
Board what moves across them (docs/board.md).

Code: `packages/contracts/src/initiatives.ts` (operations, notes, views), `apps/api/src/initiatives.ts`
(tools, the minute's job, approvals, the views), `apps/api/src/routes/missions.ts`,
`apps/runner/src/harness/tools.ts` (`missionTools`), `apps/runner/src/instructions.ts` (`## Mission`),
`apps/web/components/missions.tsx`.

## Naming

People read "Mission". In code and in the database it is an **Initiative** (`Initiative`,
`InitiativeAction`, `InitiativeOutput`, `InitiativeValue`, `Session.initiativeId`,
`Schedule.initiativeId`), so it is never taken for the Tasks board's old missions (`Task.parentId`,
`packages/contracts/src/legacy-tasks.ts`, docs/hand-offs.md), as Snooze kept `Later` in code.

## What belongs to a mission

- **Its threads**: `Session.initiativeId`, set on its main threads. A sub-thread belongs to its
  parent's mission, a routine's run to its routine's (or its parent's), and a thread a teammate starts
  from a mission's thread (`start_thread`) is the mission's too.
- **Its routines**: `Schedule.initiativeId`, set when a routine is made from a mission's thread; a
  routine reporting to one of its threads belongs to it as well.
- **Its owner**: the teammate it is delegated to, with a title, a one-line objective and, optionally,
  a number to follow (`metricLabel`, `metricUnit`, `metricTarget`).

## Making one

- **A teammate**, from the thread a person delegated the work in (`create_mission`): a thread a
  person started, at the top, that belongs to no mission yet, where its starter has the feature. Its
  instructions (`## Missions`) say to make one only once the person delegated ongoing work or agreed,
  never for a one-off task or a deliverable. The thread becomes the mission's, with its routines and
  sub-threads; the teammate owns it. `update_mission` changes its words or number, or archives it.
- **A member**, on the Missions page (`POST /api/missions`, `PATCH /api/missions/:id`): a title, an
  objective, its owner, an optional number, and the threads it gathers (the whole set, on edit). A
  thread given is one at the top (a sub-thread belongs to its parent's), and one the member may write
  in, or any for an admin. A thread belongs to one mission at most: given to another, it moves.
  Viewers make and change none.
- A thread that moves to another mission takes its live work along: the routines reporting to it,
  and its actions not run yet. Taken out of any mission, its actions not run yet are cancelled (their
  approval tickets close) and its routines belong to none. What went out stays where it was recorded.
- A member who changes a mission's words, owner or number, archives it or gives it a thread speaks in
  its threads: they count as asking there (`noteAsker`, as for a decision on a ticket), since the
  teammates read the mission in their next turns. A thread's existing sub-threads keep their asker.
- Archived (from the page or `update_mission`), its work is over: its actions not run yet are
  cancelled and its routines paused; it leaves the page and its threads stop carrying it.
  Unarchiving brings neither back.

The seed makes two (`apps/api/prisma/seed-missions.ts`).

## The plan is data Brigade runs

`plan_action` (a mission's thread only) plans a dated action: when, what, the instructions it gets
then, and optionally a **draft** a person approves before **approveBy** (15 minutes before the action
by default, at least 5 minutes from now). The action belongs to the mission's thread it was planned
from: a sub-thread's or a run's parent, and a standalone run's mission's first thread, which outlives
the run.

- With a draft, an approval ticket opens in that thread (`payload.missionAction`), so it shows in
  Needs you everywhere, on the Missions page with Approve and Decline, and in the thread with its
  draft. Approving needs who may write in the thread, or an admin (decide.ts).
- Each minute (`missions` job, `runDueActions`), drafts past their deadline **expire** and their
  ticket closes; actions due **fire**. Each is claimed (a conditional status change) together with
  the wake-up that tells its thread (`sourceId` `action:<id>:run|declined|expired`, unique per
  thread), in one transaction, then fired as any wake-up (`fireNow`). A restart in between leaves
  the wake-up pending for the wake-ups' job; two ticks never prompt twice.
- The prompt says what is due, with the approved draft and who approved it. A declined or expired
  draft tells the teammate it will not go, once.
- A mission's actions don't count toward a thread's wake-ups in a row (`firedInARow`): they are its
  plan at work, not the teammate checking again.
- `list_actions` and `cancel_action` read and change the plan. At most `ACTIONS_PER_MISSION` (30)
  wait at once, at most `ACTION_MAX_DAYS` (31) ahead.

Only some work is truly dated (a post at a set time). Opportunistic work (daily comments, a loop
looking for openings) stays in routines; the instructions tell teammates not to force it into the plan.

## What went out is data

`record_output` records a post, comment, reply, article or email with its channel, link and summary,
optionally the action it carried out, and later its numbers (`outputId` with `metrics`, merged).
`record_number` records the mission's number as the teammate read it (`InitiativeValue`). They replace
hand-kept log files.

Where Brigade has no App (LinkedIn and X go through a teammate's browser), it sees neither what went
out nor its numbers: outputs and numbers are the teammate's word, and the page says so ("As the
teammate read it"). When one of the mission's threads has a goal (docs/goals.md), its measurements are
Brigade's own and the page draws them instead ("Measured by Brigade").

## The views

`/app/missions`, in the sidebar for people with the feature:

- **Missions** (`GET /api/missions`): one row per mission, with its owner and objective, its number
  and its trend over 30 days, what needs the member (drafts to approve, with Approve and Decline, and
  the Board's Needs you cards of its threads and routines), its next agenda item and what went out
  last (its latest output, else its latest routine report).
- **This week** (`GET /api/missions/week?from=`): the agenda across missions from the start of the
  member's day, for 7 days: its routines' runs, its threads' wake-ups (the teammate's own), its
  planned actions and the deadlines of drafts to approve.

## Teammates

A thread of a mission has `mission` in its spec, when its starter has the feature (not in Chief's pass
nor a playbook's run): its teammates get `plan_action`, `list_actions`, `cancel_action`,
`record_output` and, when the mission follows a number, `record_number`, and a `## Mission` section of
their instructions saying when to use them. `plan_action` and `cancel_action` are the thread's own
(thread-tools.ts): a sub-agent puts what it would plan in its answer.

## Limits

- Playbooks are left alone: a playbook's per-action autonomy is per App write
  (Projects/Brigade/decisions/playbooks-spec.md), which a browser action isn't.
- An approved draft is the teammate's to use as it is; Brigade does not check what went out matches it.
