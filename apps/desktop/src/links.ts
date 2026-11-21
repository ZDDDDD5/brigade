// brigade:// links. brigade://link?code=…&api=…[&dashboard=…][&workspace=…], from "Open in
// Brigade" in the dashboard: connects this computer, after asking. A workspace not linked here
// yet gets a home of its own, beside the others. brigade://sign-in?code=…, from the dashboard's
// page that signs the app's windows in.
import * as capture from './capture.js'
import { ctx } from './context.js'
import { alert, confirm } from './dialogs.js'
import { runnerSupported } from './runner.js'
import * as setup from './setup.js'
import { parseLink } from './link.js'
import { takeProviderSignIn } from './provider-sign-in.js'
import { updateSettings } from './settings.js'
import { bringUp, dashboardContents, dashboardWindow } from './windows.js'
import { activeLink } from './workspaces.js'

/** Links asked about or connecting now: while one is, the computer is not free for a guest. */
let linking = 0

/** Whether a link is being asked about or connected now (the bridge's `linked`, ipc.ts). */
export const linkInProgress = () => linking > 0

export async function openLink(raw: string) {
  const link = parseLink(raw)
  if (!link) return
  if (link.kind === 'signIn') return capture.signedIn(link.code)
  if (link.kind === 'providerSignedIn') {
    if (!takeProviderSignIn(link.nonce)) return
    const result = {
      ...(link.connected && { connected: link.connected }),
      ...(link.error && { error: link.error }),
    }
    // Back to the page that waits: the dashboard window, or the new thread window.
    for (const contents of [dashboardContents(), capture.captureWindow()?.webContents])
      contents?.send('brigade:provider-signed-in', result)
    const front = dashboardWindow()
    const contents = dashboardContents()
    if (front && contents) bringUp(front, contents)
    return
  }
  if (!runnerSupported())
    return alert(
      "Teammates can't run on this computer yet",
      'Brigade runs teammates on macOS, Windows and Linux. Connect one of those, or use Brigade Cloud.',
      'warning',
    )
  // One link at a time: a second one (a guest's onboarding while the first still installs)
  // would queue a switch away from the workspace the first one links.
  if (linking > 0)
    return alert(
      'Brigade is still connecting this computer',
      'Wait until the workspace it connects is ready, then try again.',
      'warning',
    )
  linking++
  try {
    const host = new URL(link.api).host
    // One workspace runs here at a time: a link to another one stops the teammates of the
    // workspace running now (a guest's link once took a Mac from the account that linked it).
    // A link from an older API names no workspace and goes to the running one's home.
    const running = activeLink()
    const replaces =
      running && (link.workspace === undefined || running.id !== link.workspace)
        ? `\n\nThis computer runs the teammates of "${running.name}" now. They stop here until you switch back to it in the Workspace menu.`
        : ''
    // A link alone never connects this computer: its teammates would run commands here.
    const confirmed = await confirm({
      title: 'Connect this computer to Brigade?',
      message: `AI teammates of the workspace at ${host} will run on this computer: they read and change files, run commands and can use your apps when you allow it.${replaces}\n\nOnly connect a workspace you trust.`,
      ok: 'Connect',
      type: 'warning',
    })
    if (!confirmed) return
    const error = await ctx.supervisor.connect(link.api, link.code, link.workspace)
    if (error) return alert('Could not connect', error, 'error')
    if (link.dashboard)
      updateSettings((settings) => {
        settings.dashboardUrl = link.dashboard
      })
    // What's left to set up, the workspace now checked.
    setup.show()
  } finally {
    linking--
  }
}
