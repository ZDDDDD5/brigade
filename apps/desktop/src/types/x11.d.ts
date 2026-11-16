// The `x11` package (pure JavaScript X11 client) ships no types: linux/x11-input.ts uses the
// little of it it needs through its own types.
declare module 'x11' {
  const x11: {
    createClient(
      options: { display?: string },
      callback: (error: Error | null, display: unknown) => void,
    ): { on?: (event: string, listener: (error: Error) => void) => void }
  }
  export default x11
}
