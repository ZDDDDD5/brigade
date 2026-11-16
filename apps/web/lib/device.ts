/**
 * Where this page is open: Brigade.app runs teammates on a Mac or a Windows PC (from the release
 * that does there: windows-app.ts), the runner alone on Linux.
 */
export type Device = 'mac' | 'linux' | 'windows' | 'other'

export function detectDevice(ua: string): Device {
  if (/iPhone|iPad|Android/.test(ua)) return 'other'
  if (/Mac/.test(ua)) return 'mac'
  if (/Windows/.test(ua)) return 'windows'
  if (/Linux|X11/.test(ua)) return 'linux'
  return 'other'
}
