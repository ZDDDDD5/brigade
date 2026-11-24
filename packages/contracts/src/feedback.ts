// Give feedback: what a member sends from the sidebar's line, with files they uploaded first
// (POST /attachments/uploads, as for a message). Stored, then mailed to Brigade's team.
import { z } from 'zod'
import { ATTACHMENTS_PER_MESSAGE } from './attachments.js'

export const FEEDBACK_MAX = 5000

export const SendFeedback = z.object({
  text: z.string().trim().min(1, 'Write what happened').max(FEEDBACK_MAX),
  /** The dashboard's address it was sent from. */
  page: z.string().max(2000).default(''),
  attachmentIds: z.array(z.string()).max(ATTACHMENTS_PER_MESSAGE).default([]),
})
export type SendFeedback = z.input<typeof SendFeedback>
