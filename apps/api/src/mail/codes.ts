// A one-time code that could not be mailed, for want of a mail service (RESEND_API_KEY):
// locally and in previews it goes to the API's log, where whoever runs it reads it
// (MAIL_CODES_IN_LOG). Anywhere else the log only says it was not sent: a code in a log is
// a way into the account for anyone who reads the logs.
import { env } from '../config.js'

/** Where the code went when no mail can leave: logged when allowed, else only noted. */
export function unmailedCode(what: string, email: string, code: string) {
  if (env.MAIL_CODES_IN_LOG) return console.log(`${what} for ${email}: ${code}`)
  console.error(`${what} for ${email} not sent: no mail service (RESEND_API_KEY)`)
}
