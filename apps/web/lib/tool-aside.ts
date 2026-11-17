// A tool in the document panel stays open from page to page. Below wide screens it covers the
// page (the whole screen on a phone): when another page shows (Ask or Select opened its thread,
// or the person went elsewhere), it minimizes into the panel's button, as a document does, so
// that page shows. Wide, it stays beside the page.

export type ToolAside = {
  /** Shown by the document panel (components/document-panel.tsx), which can minimize it. */
  inDocuments: boolean
  /** Already out of sight: minimized, or kept hidden. */
  hidden: boolean
  /** At least 1280px wide: beside the page, not over it. */
  wide: boolean
  /** The address it was shown at, and the one now. */
  shownAt: string
  pathname: string
}

export const minimizesOnPageChange = (t: ToolAside) =>
  t.inDocuments && !t.hidden && !t.wide && t.shownAt !== t.pathname
