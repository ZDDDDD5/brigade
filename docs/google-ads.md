# Google Ads

The Google Ads App lets a workspace connect a Google account that reaches Google Ads, pick the
customer accounts its teammates work on, and give teammates reports and changes on them. It is
behind the `google_ads` feature (docs/feature-flags.md) until Google's approvals below are done.

Code: `apps/api/src/connectors/google-ads.ts` (operations), `google-oauth.ts` (scope),
`routes/connections.ts` (`/connections/:id/google-ads/customers`),
`apps/web/components/google-ads-accounts.tsx` (the picker). Tests: `apps/api/test/google-ads.test.ts`.

## How an account connects

1. **Sign in.** Like Search Console and Analytics, Google Ads signs in on Brigade's Google client
   (`GOOGLE_CLIENT_ID`), with its own consent: the `adwords` scope (Google Ads' only scope, read
   and write) and `userinfo.email`, which names the row. The account is personal by default.
2. **Pick accounts.** One Google login often reaches several Google Ads accounts, directly or
   through manager accounts (MCC). Under the row, **Pick accounts** (or **Ads accounts** in its
   menu) lists them: `customers:listAccessibleCustomers`, then each accessible account as `customer` describes it,
   and, for a manager, every account under it from `customer_client` (which exists only under
   managers). The owner or an admin ticks the accounts teammates reach; the API
   checks each against a fresh listing, records the manager it is reached through, and keeps them
   in `Connection.settings` (`{ customers: [{ id, loginCustomerId, name, currency, timeZone }] }`).
   Manager accounts hold no campaigns and are not picked. Until one is picked, every tool refuses.

Each call sends the picked account's `login-customer-id`. There is no developer token: since
2026 Google ties Google Ads API access to the Cloud project that owns the OAuth client
(`GOOGLE_CLIENT_ID`; Brigade's is `brigade-511113`) and ignores the `developer-token` header, which
a future API version will reject. The access level (Test, Explorer, Basic, Standard) shows on the
project's Google Ads API overview in Cloud Console.

## Tools

Reads: `google_ads_list_accounts`, `google_ads_campaigns`, `google_ads_ad_groups`,
`google_ads_keywords`, `google_ads_search_terms`, `google_ads_ads`,
`google_ads_negative_keywords`, and `google_ads_search` (any GAQL `SELECT`, for reports the others
do not cover). Reports take a named range (`LAST_30_DAYS`…) or `startDate`/`endDate`, in the
account's time zone, and give money in the account's currency (Google's micros divided out).

Writes, each through the usual App-write approval: `google_ads_set_campaign_budget` (refuses a
budget shared by several campaigns unless `allowShared`), `google_ads_set_status` (pause or enable
campaigns, ad groups, ads, keywords), `google_ads_add_keywords`, `google_ads_remove_keywords`,
`google_ads_add_negative_keywords`, `google_ads_remove_negative_keywords` (campaign or ad group),
and `google_ads_create_responsive_search_ad` (paused unless asked otherwise). Each mutate is atomic:
one bad keyword fails the whole call.

IDs that go into GAQL are validated as digits, so a teammate cannot widen a query through them.

## API version

`GOOGLE_ADS_VERSION` in the connector (now `v26`). Google sunsets each version about a year after
release (v26: November 2027; see developers.google.com/google-ads/api/docs/sunset-dates): move
to the latest before then, and check the release notes for changed fields.

## Before opening it to everyone

1. **Enable the API** on the OAuth client's Cloud project (`gcloud services enable
googleads.googleapis.com`). That gives Test access: test accounts only. Done for
   `brigade-511113` on 15 Nov 2026.
2. **Explorer access** (production accounts, 2,880 operations a day): apply on the project's
   [Google Ads API overview](https://console.cloud.google.com/google/ads-apis/overview); the review
   is automated. Applied for `brigade-511113` on 15 Nov 2026. A Test-access project gets
   `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` on production accounts.
3. **Basic access** (15,000 operations a day): needs the project's brand verification, then the
   same page. Projects on a free trial or with billing off may be refused.
4. **OAuth scope.** Add `https://www.googleapis.com/auth/adwords` to the Google client's consent
   screen and submit it for verification. It is a sensitive scope (not restricted): no CASA audit,
   but a demo video and justification. Until then Google shows its unverified-app warning at
   sign-in: open the feature only to the team.
5. **Open the feature** to everyone, then remove the flag from the code in a later change.

A Google Ads manager account is not needed for the API; Brigade has one (Brigade, 865-207-5274)
for its own ad accounts.
