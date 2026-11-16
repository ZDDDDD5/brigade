// Keys as X keysyms, for both X11 (XTEST) and GNOME's RemoteDesktop on Wayland, which both take
// keysyms. The names are those Brigade Computer Use takes on a Mac ("return", "cmd+shift+t"), plus
// X's own keysym names ("Page_Up") and any single character.

/** Modifiers, by the names a combination may use. cmd is the Super key here, as in agent-desktop. */
const MODIFIERS: Record<string, number> = {
  shift: 0xffe1, // Shift_L
  ctrl: 0xffe3, // Control_L
  control: 0xffe3,
  alt: 0xffe9, // Alt_L
  option: 0xffe9,
  opt: 0xffe9,
  cmd: 0xffeb, // Super_L
  command: 0xffeb,
  meta: 0xffeb,
  super: 0xffeb,
  win: 0xffeb,
}

const NAMED: Record<string, number> = {
  return: 0xff0d,
  enter: 0xff0d,
  tab: 0xff09,
  space: 0x20,
  // "delete" is the Mac's: Backspace. forwarddelete is the Delete key.
  delete: 0xff08,
  backspace: 0xff08,
  forwarddelete: 0xffff,
  del: 0xffff,
  escape: 0xff1b,
  esc: 0xff1b,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  insert: 0xff63,
  menu: 0xff67,
  capslock: 0xffe5,
  printscreen: 0xff61,
  print: 0xff61,
  comma: 0x2c,
  period: 0x2e,
  slash: 0x2f,
  backslash: 0x5c,
  semicolon: 0x3b,
  quote: 0x27,
  minus: 0x2d,
  equal: 0x3d,
  plus: 0x2b,
  grave: 0x60,
  leftbracket: 0x5b,
  rightbracket: 0x5d,
  greater: 0x3e,
  less: 0x3c,
}
for (let n = 1; n <= 24; n++) NAMED[`f${n}`] = 0xffbe + n - 1

/** X's own keysym names for what NAMED lacks: "Page_Up", "KP_Enter", "XF86AudioPlay"… */
const X_NAMES: Record<string, number> = {
  Return: 0xff0d,
  BackSpace: 0xff08,
  Delete: 0xffff,
  Escape: 0xff1b,
  Tab: 0xff09,
  Page_Up: 0xff55,
  Page_Down: 0xff56,
  Prior: 0xff55,
  Next: 0xff56,
  Home: 0xff50,
  End: 0xff57,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Insert: 0xff63,
  Menu: 0xff67,
  KP_Enter: 0xff8d,
  Super_L: 0xffeb,
  Super_R: 0xffec,
  Control_L: 0xffe3,
  Control_R: 0xffe4,
  Shift_L: 0xffe1,
  Shift_R: 0xffe2,
  Alt_L: 0xffe9,
  Alt_R: 0xffea,
  Caps_Lock: 0xffe5,
  Print: 0xff61,
  XF86AudioPlay: 0x1008ff14,
  XF86AudioStop: 0x1008ff15,
  XF86AudioPrev: 0x1008ff16,
  XF86AudioNext: 0x1008ff17,
  XF86AudioMute: 0x1008ff12,
  XF86AudioLowerVolume: 0x1008ff11,
  XF86AudioRaiseVolume: 0x1008ff13,
}

export class KeyError extends Error {
  readonly code = 'invalid_argument'
}

/** The keysym that types a character: Latin-1 as itself, the rest as Unicode keysyms. */
export function charKeysym(char: string): number {
  const code = char.codePointAt(0)!
  if (char === '\n' || char === '\r') return 0xff0d
  if (char === '\t') return 0xff09
  if (char === '\b') return 0xff08
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code
  return 0x01000000 | code
}

/** A modifier's keysym, by its name. */
export function modifierKeysym(name: string): number {
  const keysym = MODIFIERS[name.trim().toLowerCase()]
  if (keysym === undefined) throw new KeyError(`unsupported modifier ${name}`)
  return keysym
}

/** A key's keysym, by its name: "return", "f5", "Page_Up", "a", "é". */
export function keyKeysym(name: string): number {
  const lower = name.toLowerCase()
  if (NAMED[lower] !== undefined) return NAMED[lower]!
  if (X_NAMES[name] !== undefined) return X_NAMES[name]!
  if (MODIFIERS[lower] !== undefined) return MODIFIERS[lower]!
  if ([...name].length === 1) return charKeysym(name)
  throw new KeyError(`unsupported key ${name}`)
}

/**
 * A combination, "cmd+shift+t" or "return": the modifiers' keysyms and the key's. A bare
 * upper-case letter is that letter with Shift (as agent-desktop reads it); with other modifiers,
 * case is ignored.
 */
export function parseCombo(combo: string): { modifiers: number[]; key: number } {
  const trimmed = combo.trim()
  // "+" alone, or a combination ending in "+" ("ctrl++"), is the plus key.
  const parts = trimmed === '+' ? ['+'] : trimmed.split('+')
  if (trimmed.endsWith('++')) parts.splice(parts.length - 2, 2, '+')
  const name = parts.pop()?.trim()
  if (!name) throw new KeyError('key is required')
  const modifiers = parts.map(modifierKeysym)
  if (/^[A-Z]$/.test(name) && !modifiers.length)
    return { modifiers: [MODIFIERS.shift!], key: name.toLowerCase().charCodeAt(0) }
  const key = /^[A-Z]$/.test(name) ? name.toLowerCase().charCodeAt(0) : keyKeysym(name)
  return { modifiers, key }
}

/** Buttons by name, as X numbers them (Wayland's evdev codes are in mutter.ts). */
export function buttonNumber(button: string) {
  switch (button) {
    case 'left':
      return 1
    case 'middle':
      return 2
    case 'right':
      return 3
    default:
      throw new KeyError(`unsupported mouse button ${button}`)
  }
}
