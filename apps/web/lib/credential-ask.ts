import { bareToolName } from '@brigade/contracts'

/**
 * A teammate's ask to use a vault credential (use_credential, fill_credential): which one, and
 * why when it said so. Undefined for any other tool's approval.
 */
export function credentialAsked(
  toolName: string,
  input: unknown,
): { credentialId: string; purpose?: string } | undefined {
  if (!/^(use|fill)_credential$/.test(bareToolName(toolName))) return undefined
  const i = (input ?? {}) as Record<string, unknown>
  if (typeof i.credentialId !== 'string' || !i.credentialId) return undefined
  const purpose = typeof i.purpose === 'string' ? i.purpose.trim() : ''
  return { credentialId: i.credentialId, ...(purpose ? { purpose } : {}) }
}
