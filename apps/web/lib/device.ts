/**
 * Where this page is open: Brigade.app runs on a Mac, the runner on a Mac or Linux. Windows is
 * told so: Brigade.app runs there, but no teammate does (apps/desktop/src/runner.ts).
 */
export type Device = 'mac' | 'linux' | 'windows' | 'other'

export function detectDevice(ua: string): Device {
  if (/iPhone|iPad|Android/.test(ua)) return 'other'
  if (/Mac/.test(ua)) return 'mac'
  if (/Windows/.test(ua)) return 'windows'
  if (/Linux|X11/.test(ua)) return 'linux'
  return 'other'
}
