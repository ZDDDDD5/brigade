'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { BrigadeMark } from '@/components/brigade-mark'
import { EmailSignIn } from '@/components/email-sign-in'
import { GoogleSignIn } from '@/components/google-sign-in'
import { AuthLink } from '@/components/landing/auth-link'
import { LegalConsent } from '@/components/legal-consent'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { authClient } from '@/lib/auth-client'
import { inCaptureWindow, inDesktopApp, signInWithBrowser } from '@/lib/brigade-app'
import { computerTaken, guestOffered, startAsGuest } from '@/lib/guest'
import { afterSignIn, markSignedIn, signedInBefore } from '@/lib/signed-in'

export default function SignIn() {
  const router = useRouter()
  const [error, setError] = useState<string>()
  // In Brigade.app's windows, the browser signs in (lib/brigade-app.ts): its own session is
  // out of reach here. 'waiting': the browser is open; 'form': the form here after all.
  const [app, setApp] = useState<'browser' | 'waiting' | 'form'>()
  // In Brigade.app, with guests open (docs/guests.md): a window nobody ever signed in to starts
  // as a guest at once ('starting'); one someone signed out of offers it ('offered').
  const [guest, setGuest] = useState<'offered' | 'starting'>()
  // The workspace Brigade.app already runs teammates for (its bridge's `linked`): an account
  // linked this computer, often from the website's onboarding a moment ago. Its window signs in
  // to it rather than starting a guest, whose own link would stop that workspace's teammates.
  const [linked, setLinked] = useState<string>()
  // A link of this computer is being asked about or installing: the same, before it has a name.
  const [linking, setLinking] = useState(false)
  // 'Already have an account?' while it starts: the sign-in stays, whatever the start does.
  const signingIn = useRef(false)
  // Back from Google with ?error=: the API names what went wrong. With ?signed, signed in
  // with Google on the way to ?next=. In Brigade.app's window, with ?desktop_code= and
  // ?verifier=: the browser's sign-in, brought back by the app.
  useEffect(() => {
    const query = new URLSearchParams(location.search)
    if (query.has('signed')) {
      markSignedIn()
      return location.replace(afterSignIn())
    }
    const failed = query.get('error')
    if (failed) setError(`Could not sign in with Google (${failed.replaceAll('_', ' ')})`)
    if (!inDesktopApp()) return
    setApp('browser')
    const code = query.get('desktop_code')
    const verifier = query.get('verifier')
    void Promise.all([guestOffered(), computerTaken()])
      .then(([offered, taken]) => {
        if (taken.linked) setLinked(taken.linked)
        else if (taken.linking) setLinking(true)
        if (!offered) return
        // Offered, never started on its own: someone was signed in here, a sign-in is coming
        // back from the browser, or this computer runs or is linking a workspace already.
        if (signedInBefore() || (code && verifier) || taken.linked || taken.linking)
          return setGuest((was) => was ?? 'offered')
        void startWithoutAccount()
      })
      .catch(() => {})
    if (!code || !verifier) return
    history.replaceState(null, '', '/sign-in')
    void authClient
      .$fetch('/desktop/redeem', { method: 'POST', body: { code, verifier } })
      .then(({ error }) => {
        if (error) return setError(error.message ?? 'Could not sign in')
        markSignedIn()
        location.replace(inCaptureWindow() ? '/app/capture' : afterSignIn())
      })
      .catch(() => setError('Could not reach Brigade. Check your connection and try again.'))
  }, [])

  async function browser() {
    setError(undefined)
    try {
      await signInWithBrowser()
      setApp('waiting')
    } catch {
      setError('Could not open your browser.')
    }
  }

  async function startWithoutAccount() {
    // Asked for now (the button, or the first launch): whatever was chosen before gives way.
    signingIn.current = false
    setError(undefined)
    setGuest('starting')
    try {
      await startAsGuest()
      if (!signingIn.current) location.replace('/onboarding')
    } catch (e) {
      setError((e as Error).message)
      setGuest('offered')
    }
  }

  function signedIn() {
    markSignedIn()
    const next = afterSignIn()
    if (next === '/app') router.push(next)
    else location.assign(next)
  }

  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-sm flex-col gap-7">
        <div className="flex flex-col items-center gap-4 text-center">
          <BrigadeMark className="size-14" />
          <div className="flex flex-col gap-1.5">
            <h1 className="text-3xl font-extrabold tracking-tight">
              {guest ? 'Welcome to Brigade' : 'Sign in to Brigade'}
            </h1>
            <p className="text-sm text-muted-foreground">Your AI teammates are waiting.</p>
          </div>
        </div>
        {guest === 'starting' && !signingIn.current ? (
          <Card>
            <CardContent className="flex flex-col gap-5">
              <p className="text-center text-sm text-muted-foreground">
                Getting your workspace ready…
              </p>
              <button
                type="button"
                onClick={() => {
                  signingIn.current = true
                  setGuest('offered')
                }}
                className="self-center text-sm text-muted-foreground underline-offset-4 hover:underline"
              >
                Already have an account? Sign in
              </button>
            </CardContent>
          </Card>
        ) : app === 'browser' || app === 'waiting' ? (
          <Card>
            <CardContent className="flex flex-col gap-5">
              {linked ? (
                <p className="text-sm text-muted-foreground">
                  This computer already runs the teammates of{' '}
                  <span className="font-medium text-foreground">{linked}</span>. Sign in to its
                  account to see them.
                </p>
              ) : (
                linking && (
                  <p className="text-sm text-muted-foreground">
                    This computer is being connected to a workspace. Sign in to its account to see
                    its teammates.
                  </p>
                )
              )}
              {guest && !linked && !linking && (
                <>
                  <Button
                    size="lg"
                    className="w-full"
                    disabled={guest === 'starting'}
                    onClick={() => void startWithoutAccount()}
                  >
                    {guest === 'starting' ? 'Starting…' : 'Start without an account'}
                  </Button>
                  <p className="text-sm text-muted-foreground">
                    Your teammates run on this computer, with the Claude or ChatGPT login on it.
                    Save your account with your email whenever you like.
                  </p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    or
                    <span className="h-px flex-1 bg-border" />
                  </div>
                </>
              )}
              <Button
                size="lg"
                variant={guest && !linked && !linking ? 'outline' : 'default'}
                className="w-full"
                onClick={browser}
              >
                Sign in with your browser
              </Button>
              <p className="text-sm text-muted-foreground">
                {app === 'waiting'
                  ? 'Finish in your browser: Brigade.app signs in once you choose Open Brigade.app there.'
                  : 'Already signed in to Brigade in your browser? Nothing to type.'}
              </p>
              {error && <p className="text-sm text-destructive-text">{error}</p>}
              <button
                type="button"
                onClick={() => setApp('form')}
                className="self-center text-sm text-muted-foreground underline-offset-4 hover:underline"
              >
                Sign in here instead
              </button>
              {guest && (linked || linking) && (
                <button
                  type="button"
                  disabled={guest === 'starting'}
                  onClick={() => void startWithoutAccount()}
                  className="self-center text-sm text-muted-foreground underline-offset-4 hover:underline"
                >
                  {guest === 'starting' ? 'Starting…' : 'Start without an account instead'}
                </button>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex flex-col gap-5">
              <GoogleSignIn onError={setError} />
              {error && <p className="text-sm text-destructive-text">{error}</p>}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
              <EmailSignIn withPassword submitLabel="Sign in" onSignedIn={signedIn} />
              <LegalConsent />
            </CardContent>
          </Card>
        )}
        <p className="text-center text-sm text-muted-foreground">
          New here?{' '}
          <AuthLink
            passOn
            href="/sign-up"
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            Create an account
          </AuthLink>
        </p>
      </div>
    </main>
  )
}
