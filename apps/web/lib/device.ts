/**
 * Where this page is open: Brigade.app runs on a Mac, the runner on a Mac or Linux. Windows is
 * told so: Brigade.app runs there, but no teammate does (apps/desktop/src/runner.ts). A
 * Chromebook says X11 like Linux, but its own terminal (crosh) runs no command: the runner goes
 * in its Linux development environment, which it shows how to turn on.
 */
export type Device = 'mac' | 'linux' | 'chromeos' | 'windows' | 'other'

export function detectDevice(ua: string): Device {
  if (/iPhone|iPad|Android/.test(ua)) return 'other'
  if (/Mac/.test(ua)) return 'mac'
  if (/Windows/.test(ua)) return 'windows'
  if (/CrOS/.test(ua)) return 'chromeos'
  if (/Linux|X11/.test(ua)) return 'linux'
  return 'other'
}
