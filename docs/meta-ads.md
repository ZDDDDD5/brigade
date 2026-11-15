# Meta Ads

The Meta Ads App lets a workspace connect a Facebook account that reaches Meta ad accounts, pick
the ad accounts its teammates work on, and give teammates reports and changes on them (Facebook
and Instagram ads). It is behind the `meta_ads` feature (docs/feature-flags.md) until Meta's
approvals below are done.

Code: `apps/api/src/connectors/meta-ads.ts` (operations), `meta-oauth.ts` (sign-in),
`routes/connections.ts` (`POST /connections/meta`, `/oauth/meta/callback`,
`/connections/:id/meta-ads/accounts`), `apps/web/components/meta-ads-accounts.tsx` (the picker).
Tests: `apps/api/test/meta-ads.test.ts`.

## Why not Meta's MCP server

Meta has an official Ads MCP server (`https://mcp.facebook.com/ads`, open beta since April 2026).
Its authorization server advertises dynamic client registration, but registers only the clients
Meta approved (Claude, ChatGPT…): it answers Brigade's registration with "Dynamic registration is
not available for this client" (checked 15 Nov 2026). So Brigade calls the Marketing API itself,
on its own Meta app. If Meta ever approves Brigade, the App could move to that server.

## Brigade's Meta app

- App **Brigade**, ID `1166582399637501`, on developers.facebook.com, owned by Georges's Facebook
  account. Use case: _Create & manage ads with Marketing API_. No business portfolio yet.
- Facebook Login for Business, valid OAuth redirect URI
  `https://api.brigade.lol/api/connections/oauth/meta/callback`.
- Configuration **Brigade Meta Ads** (ID `1539361281448726`): a user access token with
  `ads_read`, `ads_management` and `business_management`.
- The API reads `META_APP_ID`, `META_APP_SECRET` (a Worker secret; in the vault as "Meta app
  secret (Brigade Meta Ads App)") and `META_LOGIN_CONFIG_ID`. Without the first two, the App shows
  as not configured.

## How an account connects

1. **Sign in.** `POST /connections/meta` sends the member to Meta's dialog with the
   configuration's `config_id`; Meta asks which businesses and ad accounts Brigade may reach. The
   callback exchanges the code for a token, then for a long-lived one (60 days), and names the row
   after the Facebook user (`GET /me?fields=id,name`). Meta gives no refresh token: once the token
   expires or Meta refuses it (OAuthException 190), the account shows as needing a reconnect.
2. **Pick ad accounts.** One Facebook user often reaches ad accounts of several businesses, not all
   of which its teammates should touch. Under the row, **Pick accounts** lists
   `GET /me/adaccounts`; the owner or an admin ticks those teammates reach, checked again against
   a fresh listing, kept in `Connection.settings` (`{ accounts: [{ id, name, currency, timeZone,
business }] }`). Until one is picked, every tool refuses.

Disconnecting deletes the token from the vault. It does not revoke Brigade's permissions on
Facebook, which other connections of the same Facebook user would lose too; a person removes the
app in Facebook's Business Integrations settings.

## Tools

Reads: `meta_ads_list_accounts`, `meta_ads_campaigns`, `meta_ads_ad_sets`, `meta_ads_ads`
(creative title, body, link, thumbnail) and `meta_ads_insights` (any level, breakdowns such as
age, gender, country or placement, by day or week). Reports take a `datePreset` (`last_30d`…) or
`since`/`until`, in the ad account's time zone, with spend in the account currency and actions
(purchases, leads, link clicks…) as `{ type: count }`.

Writes, each through the usual App-write approval: `meta_ads_set_status` (pause or activate a
campaign, ad set or ad) and `meta_ads_set_budget` (a campaign's or ad set's daily or lifetime
budget). Each first reads the object's `account_id` and refuses one outside the picked ad
accounts, so a teammate cannot reach another account by naming an ID. Budgets are sent in the
currency's smallest unit (hundredths, or whole units for JPY, KRW and the other currencies Meta
counts that way).

## API version

`GRAPH_VERSION` in `meta-oauth.ts` (now `v27.0`). Meta keeps each version about two years: move to
the latest before then.

## Before opening it to everyone

1. **Business portfolio.** Create a Brigade business portfolio and connect the app to it (App
   settings › Basic), then complete Meta's business verification.
2. **App Review.** Request Advanced Access to `ads_read`, `ads_management` and
   `business_management`, with a screencast of the sign-in and of a teammate using the tools.
   Until then, only people with a role on the app (App roles) can sign in.
3. **Publish** the app (switch to Live), then open the feature to everyone and later remove the
   flag from the code.
