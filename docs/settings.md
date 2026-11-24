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

## Profile

The first section of You (`components/settings/profile.tsx`, `apps/api/src/profile.ts`): the
person's own name, picture and email, the same in every organization they are in. The member
menu's top row (their name and email) opens it. Deleting the account is at its foot.

- **Name and picture** save on their own as they change (`PATCH /api/me/profile`), as the
  workspace's name and logo do. A picture is uploaded and kept as a logo is (`src/logos.ts`, 256
  KB at most, shrunk to 256 px), in the bucket folder of the workspace it was chosen in:
  `User.avatar` holds `<workspaceId>/<version>`, and the API gives `image` as
  `/users/<id>/avatar?v=…` (`userImageSrc` in the dashboard puts `/api` before it). Only the person
  and those who share an organization with them read it. Removing it shows their sign-in's picture
  (`User.image`, Google's) again; deleting that workspace does too, and deleting the account deletes
  the picture.
- **A sign-in with Google** puts Google's name and picture back on each sign-in
  (`overrideUserInfoOnSignIn`). A name the person chose (`User.nameChosen`) stays: a better-auth
  hook (`keepChosenName`) keeps it. A chosen picture needs nothing, since Google's goes to `image`,
  under it.
- **Email** is read only: they sign in with it. Changing it needs the new address proven first
  (better-auth's `changeEmail`), not set up yet.
