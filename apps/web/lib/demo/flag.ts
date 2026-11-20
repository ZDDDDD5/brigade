/**
 * The public demo (demo.brigade.lol): the real dashboard on recorded data, built with
 * NEXT_PUBLIC_DEMO=1. Nothing in it reaches an API: requests to DEMO_API never leave the
 * browser (lib/demo/install.ts answers them), and the address does not exist besides.
 */
export const DEMO = process.env.NEXT_PUBLIC_DEMO === '1'
export const DEMO_API = 'https://api.demo.invalid'
/** Where the demo's visitor goes to start for real. */
export const SIGN_UP_URL = 'https://www.brigade.lol/sign-up'
/** How the ids of threads started in the demo begin (lib/demo/server.ts): none outlives a reload. */
export const DEMO_THREAD = 'demo-thread-'

/** Where the landing page shows the demo in a frame (components/landing/live-demo.tsx). */
export const DEMO_URL = 'https://demo.brigade.lol'

/** What the landing and the demo in its frame say to each other: the frame asks whether its
 * screen is in focus yet (the landing's focus pull, live-demo.tsx), the landing answers, then
 * says so again once it is. The walkthrough waits for it. */
export const FOCUS_ASK = 'brigade-demo:focus?'
export const FOCUS_SAY = 'brigade-demo:focus'

/** Whether this page is in a frame: the demo shown on the landing page, which has its own sign. */
export const framed = () => typeof window !== 'undefined' && window.self !== window.top

/** Goes to sign up for real, out of the frame when the demo is in one (a click allows it). */
export function signUp() {
  window.open(SIGN_UP_URL, '_top')
}
