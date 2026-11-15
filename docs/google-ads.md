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
   menu) lists them: `customers:listAccessibleCustomers`, then each accessible account's
   `customer_client` hierarchy. The owner or an admin ticks the accounts teammates reach; the API
   checks each against a fresh listing, records the manager it is reached through, and keeps them
   in `Connection.settings` (`{ customers: [{ id, loginCustomerId, name, currency, timeZone }] }`).
   Manager accounts hold no campaigns and are not picked. Until one is picked, every tool refuses.

Each call sends Brigade's developer token (`developer-token`, from `GOOGLE_ADS_DEVELOPER_TOKEN`)
and the picked account's `login-customer-id`. The token is Brigade's, one server secret; it is
never a customer's.

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

1. **Manager account and developer token.** Create a Google Ads manager account for Brigade, and in
   it Admin › API Center: accept the terms and get the developer token. Set it as the
   `GOOGLE_ADS_DEVELOPER_TOKEN` Worker secret of `brigade-api` (a secret, not a variable).
2. **Basic access.** A new token has Explorer (or Test) access: few operations a day on production
   accounts (or test accounts only). Apply for Basic access in API Center, with the design
   documentation Google asks for (what Brigade does with the API, the tools above).
3. **OAuth scope.** Add `https://www.googleapis.com/auth/adwords` to the Google client's consent
   screen and submit it for verification. It is a sensitive scope (not restricted): no CASA audit,
   but a demo video and justification. Until then, open the feature only to test users.
4. **Open the feature** to everyone, then remove the flag from the code in a later change.
