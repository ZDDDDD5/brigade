# Settings

Settings is a dialog over the page the member is on, not a page of its own: its sections in
three groups on the left (You, Workspace, Teammates), with a search over them (`/` focuses it),
and the section on the right, scrolling on its own. Esc or ✕ closes it, back on the page as it
was; on a phone it takes the whole screen, its sections in a row above.

- Opened from the member's menu, ⌘, (Ctrl+, elsewhere), the app's search, or any link to a
  section inside the app (`clickSettings`, `openSettings` in `apps/web/lib/settings-dialog.ts`).
  Moving to another page (a thread, a page a section links to) closes it.
- Each section keeps its address, `/app/<section>` (`/app/settings` is the first). Loaded on its
  own (a new tab, a provider's or Stripe's redirect, Brigade.app's menu, an email), it opens the
  dialog over Today, and the address becomes `/app`. What followed `?` goes to the section
  (`useSettingsParams`): `/app/connections?app=…`, `?connected=…`, `/app/billing?subscribed=1`,
  `/app/computers?desktop=1`. The sign-in tab's last page, `/app/connections?popup=1`, stays a
  page, which closes the tab.
- The sections are in `apps/web/components/settings/`, the dialog in
  `apps/web/components/settings-dialog.tsx`; their list, labels and search words in
  `SETTINGS_SECTIONS`, which the app's search reads too.
