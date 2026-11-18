// A cloud computer marked running whose runner is away (src/cloud.ts's recoverAway, and its ops
// alert in src/ops/checks.ts): how long, from what its workspace's hub keeps (runnerAway), and
// what Brigade does about it (recoveryStep).
import type { RecoverAnswer } from '@brigade/providers'

/**
 * A cloud computer's runner away while its computer is marked running (the hub's runnerAway):
 * since when, what boat answered when asked to recover it during this absence, and how many
 * times Brigade stopped it with its last snapshot and started it again (recoverAway).
 */
export type RunnerAway = {
  since: number
  restarts: number
  gaveUp?: boolean
  /** When boat was last asked to recover it, and what it answered. */
  recoverAskedAt?: number
  recover?: RecoverAnswer
  /**
   * Since when the commands boat is asked to run there (its runner's service start) never reach
   * the machine: sent then, and none has reached it since.
   */
  unreachedSince?: number
}

/** Its runner away this long, Brigade looks at whether boat still reaches the machine. */
export const RECOVER_AFTER_MS = 20 * 60_000
/**
 * boat saves a running machine's disk, or checks it has nothing new to save, at least every 10
 * minutes or so (Nov 5–7): nothing saved for this long, it no longer reaches the machine. Its own
 * rule refuses a stop past 30 minutes without a snapshot.
 */
export const UNSAVED_MS = 15 * 60_000
/** A power-cycle boat accepted: its runner is waited for this long (boat says 1–2 minutes). */
export const RECOVER_WAIT_MS = 5 * 60_000
/** boat answered it reaches the machine: asked again this long after, should that change. */
export const RECOVER_AGAIN_MS = 10 * 60_000
/**
 * Restarts with its last snapshot without its runner coming back, at most, before the computer
 * is moved to a new VM (recoveryStep's 'replace'). A restart keeps its whole disk, and lands the
 * VM on another of boat's hosts at times; on Nov 18, three in a row came back on the same host,
 * its disk's restore stuck at 15%, for three hours, until a member replaced it by hand.
 */
export const RECOVER_LIMIT = 1
/**
 * boat reaches its machine, yet its runner stays away and boat does not save its disk (a full
 * disk, its snapshots failing): replaced once it has been so for this long past RECOVER_AFTER_MS.
 */
export const REACHABLE_REPLACE_MS = 30 * 60_000
/**
 * Automatic replacements of one computer within AUTO_REPLACE_WINDOW_MS, at most: past them, its
 * new VMs do not stay up either, and it is left to operators (its alert says so).
 */
export const AUTO_REPLACE_LIMIT = 2
export const AUTO_REPLACE_WINDOW_MS = 6 * 60 * 60_000

/** How long a running computer's runner has been away; 0 while it is connected (null). */
export function awayFor(
  away: { since: number } | null,
  computer: { updatedAt: Date },
  now = Date.now(),
) {
  // Its status changed since (a restart, a resume): counted from then.
  return away ? Math.max(0, now - Math.max(away.since, computer.updatedAt.getTime())) : 0
}

/**
 * What Brigade does now for a computer marked running whose runner is away (recoverAway):
 * `restart` stops it with its last snapshot and starts it again, `replace` moves it to a new VM
 * (src/cloud-replace.ts), as a member's Replace cloud computer does.
 */
export type RecoveryStep = 'none' | 'recover' | 'restart' | 'replace' | 'give-up'

/**
 * From how long its runner has been away (`awayMs`), when boat last saved its disk or checked it
 * had nothing new to save (`savedAt`), its last completed snapshot (`snapshotAt`, what a forced
 * stop keeps), whether its runner said its disk is full, and how many times Brigade moved it to a
 * new VM by itself lately (`replaced`, within AUTO_REPLACE_WINDOW_MS):
 * - its runner away less than RECOVER_AFTER_MS, or boat saving it lately while its commands
 *   reach it: nothing. A machine boat still saves and runs commands on answers, and its runner is
 *   the trouble: a new VM would not help, and a runner that fails everywhere (a bad release) must
 *   not move every workspace. On Nov 7 at 11:05, one stalled for 12 minutes after a resume and
 *   came back by itself. Its commands not reaching it for UNSAVED_MS (`unreachedSince`) counts as
 *   unsaved, whatever boat's snapshots say;
 * - else boat is asked to recover it (power-cycle its machine, its disk untouched);
 * - boat cannot (`impossible`: its baremetal machines), or its runner is still away
 *   RECOVER_WAIT_MS after a power-cycle: it is stopped with its last snapshot and started again,
 *   RECOVER_LIMIT times, which keeps its whole disk;
 * - still away after that, or with no snapshot to restart from, or a full disk (boat does not
 *   start one past ~90% again): moved to a new VM, which takes its threads' folders, logins and
 *   services from Brigade's backups (src/cloud-replace.ts). The old VM is kept, stopped;
 * - boat reaches the machine though it does not save it (a full disk, say): asked again every
 *   RECOVER_AGAIN_MS, and moved once so for REACHABLE_REPLACE_MS;
 * - moved AUTO_REPLACE_LIMIT times lately: its new VMs do not stay up either, left to operators.
 * The person using it never has to act: they see it restarting, then carrying on.
 */
export function recoveryStep(
  away: RunnerAway,
  state: {
    awayMs: number
    savedAt: number | null
    snapshotAt: number | null
    diskFull: boolean
    replaced?: number
    now: number
  },
): RecoveryStep {
  const { awayMs, savedAt, snapshotAt, diskFull, now } = state
  if (awayMs < RECOVER_AFTER_MS || away.gaveUp) return 'none'
  // boat may still save a machine it no longer gets a command to (Nov 18: snapshots for 34
  // minutes after a resume whose machine never ran one): unreached that long, it is as unsaved.
  const unreached = away.unreachedSince !== undefined && now - away.unreachedSince >= UNSAVED_MS
  if (!unreached && savedAt !== null && now - savedAt < UNSAVED_MS) return 'none'
  const replace = (state.replaced ?? 0) >= AUTO_REPLACE_LIMIT ? 'give-up' : 'replace'
  const askedFor = now - (away.recoverAskedAt ?? 0)
  if (!away.recover) return 'recover'
  if (away.recover === 'reachable') {
    if (awayMs >= RECOVER_AFTER_MS + REACHABLE_REPLACE_MS) return replace
    return askedFor >= RECOVER_AGAIN_MS ? 'recover' : 'none'
  }
  if (away.recover === 'recovering' && askedFor < RECOVER_WAIT_MS) return 'none'
  if (snapshotAt !== null && !diskFull && away.restarts < RECOVER_LIMIT) return 'restart'
  return replace
}
