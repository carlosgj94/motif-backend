# Auth Setup

This backend now assumes:

- Supabase Auth is the source of truth for email/password, Google, and Apple identities.
- The browser client signs users in with Supabase and sends bearer tokens to this API.
- This API verifies Supabase access tokens against the project's JWKS endpoint.

## Environment variables

Copy `.env.example` to `.env` and set:

- `DATABASE_URL`: use the Supabase session pooler on port `5432`
- `SUPABASE_URL`: your project URL, for example `https://<project-ref>.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY`: required for `POST /auth/signup` and `POST /auth/session`
- `CORS_ALLOWED_ORIGINS`: optional comma-separated browser origins allowed to call the API; defaults include `localhost`, `127.0.0.1`, and `0.0.0.0` on ports `3000` and `3001`
- `SUPABASE_JWT_AUDIENCE`: leave as `authenticated` unless you changed your JWT audience
- `DB_MAX_CONNECTIONS`: defaults to `10`

## Supabase dashboard steps

1. Open your Supabase project.
2. In `Authentication`, enable `Email` provider.
3. Keep email confirmation enabled for production.
4. Enable `Google` and `Apple` providers.
5. Add your local and production callback URLs in the Auth redirect settings.
6. Use the `Session pooler` connection string for `DATABASE_URL`.

## Provider setup

### Google

1. Create a Web OAuth client in Google Cloud.
2. Add your frontend origin to `Authorized JavaScript origins`.
3. Add the callback URL shown in Supabase's Google provider form to `Authorized redirect URIs`.
4. Paste the Google client ID and secret into Supabase.

### Apple

1. In Apple Developer, enable `Sign in with Apple` on your App ID.
2. Create a `Services ID` for the website flow.
3. Create a Sign in with Apple key.
4. Paste the Services ID, Team ID, Key ID, and private key into Supabase's Apple provider form.

## Backend routes

- `GET /health`: liveness check
- `POST /auth/signup`: create an email/password auth user and store `username` in Supabase user metadata
- `POST /auth/session`: sign in with email/password and receive a Supabase session payload
- `POST /auth/session/refresh`: exchange a refresh token for a fresh session payload
- `POST /me/password/reauthenticate`: ask Supabase Auth to send a password-change nonce to the authenticated user
- `PUT /me/password`: change the authenticated user's password through Supabase Auth
- `GET /recommendations/topics`: list onboarding topics before the user exists, including nested subtopics
- `POST /recommendations/sources/preview`: get pre-auth source recommendations for onboarding topic or subtopic selections
- `GET /me`: returns the verified Supabase user plus any claimed app profile
- `PUT /me/profile`: create or update the authenticated user's app profile
- `GET /profiles/:username`: fetch a public profile by username

## Expected client flow

1. Sign up with `email + password` in the browser with Supabase Auth.
2. Call `GET /recommendations/topics` to populate the onboarding topic picker and any nested subtopic choices.
3. Optionally call `POST /recommendations/sources/preview` with onboarding topic or subtopic selections before the user exists.
4. Call `POST /auth/signup` with only `username`, `email`, and `password`.
5. Create a session with `POST /auth/session`.
6. Refresh sessions with `POST /auth/session/refresh` when you need a fresh access token.
7. Call `PUT /me/recommendation-preferences` with the selected `topic_slugs` and `language_codes`.
8. Call `POST /me/source-subscriptions` for each source selected during onboarding.
9. Call `PUT /me/profile` once with the returned access token to claim the username in `public.profiles`.
10. For Google and Apple, start OAuth with Supabase in the browser, then call `PUT /me/profile` if the user does not already have a profile row.
11. Send `Authorization: Bearer <access_token>` on protected API calls.

## Password change flow

Use the authenticated API routes when a signed-in user wants to change their password:

1. Call `PUT /me/password` with `new_password` when the current Supabase session is recent enough.
2. If Supabase Auth requires reauthentication, call `POST /me/password/reauthenticate`.
3. Collect the nonce delivered to the user's confirmed email or phone.
4. Retry `PUT /me/password` with both `new_password` and `nonce`.

Supabase handles the actual password policy enforcement and secure password change behavior. When secure password change is enabled, Supabase requires reauthentication for older sessions; according to the current Supabase docs, "recently signed in" means the session was created within the last 24 hours.

## Recommendation taxonomy

- `GET /recommendations/topics` now returns a nested topic tree.
- Both parent topics and subtopics are valid `topic_slugs` inputs for onboarding preview and saved preferences.
- Parent topic selections expand to matching subtopics for source recommendation preview and downstream recommendation affinity.

To seed curated `source_topics` and backfill `content_topics` in development:

```bash
source .env
psql "$DATABASE_URL" -f scripts/backfill_topic_assignments.sql
```

## Content processing setup

Saved content now queues background URL processing in Supabase instead of doing fetch/parse work inline in the Rust API.

### Supabase extensions and migrations

The database migrations now expect these managed extensions to be available:

- `pgmq` for the durable queue
- `pg_net` for the immediate post-commit function trigger
- `pg_cron` for recovery triggers

### Edge Function

Deploy the Supabase function at `supabase/functions/process-content-batch`.

Deploy the source refresh function at `supabase/functions/process-source-batch`.

Set this Edge Function secret:

- `CONTENT_PROCESSOR_SECRET`: shared secret required on the internal function request header

Optional function tuning secrets:

- `CONTENT_PROCESSING_BATCH_SIZE` defaults to `10`
- `CONTENT_PROCESSING_VISIBILITY_TIMEOUT_SECONDS` defaults to `300`
- `CONTENT_PROCESSING_STALE_AFTER_SECONDS` defaults to `900`
- `CONTENT_PROCESSING_RETRY_LIMIT` defaults to `3`
- `CONTENT_PROCESSING_HTTP_TIMEOUT_MS` defaults to `15000`
- `CONTENT_PROCESSING_MAX_REDIRECTS` defaults to `5`
- `CONTENT_PROCESSING_MAX_HTML_BYTES` defaults to `2097152`
- `CONTENT_PROCESSING_MAX_OEMBED_BYTES` defaults to `131072`
- `CONTENT_PROCESSING_FAVICON_MAX_BYTES` defaults to `262144`
- `CONTENT_PROCESSING_MAX_PARSED_BLOCKS` defaults to `128`
- `CONTENT_PROCESSING_MAX_TEXT_CHARS` defaults to `4000`
- `CONTENT_PROCESSING_MAX_CODE_CHARS` defaults to `16000`
- `CONTENT_PROCESSING_MAX_LIST_ITEMS` defaults to `50`
- `CONTENT_PROCESSING_MAX_LIST_ITEM_CHARS` defaults to `500`
- `CONTENT_PROCESSING_MAX_PARSED_DOCUMENT_BYTES` defaults to `262144`

Optional source refresh tuning secrets:

- `SOURCE_REFRESH_BATCH_SIZE` defaults to `10`
- `SOURCE_REFRESH_VISIBILITY_TIMEOUT_SECONDS` defaults to `300`
- `SOURCE_REFRESH_STALE_AFTER_SECONDS` defaults to `900`
- `SOURCE_REFRESH_RETRY_LIMIT` defaults to `3`
- `SOURCE_REFRESH_MAX_DISCOVERY_BYTES` defaults to `1048576`
- `SOURCE_REFRESH_MAX_FEED_BYTES` defaults to `1048576`
- `SOURCE_REFRESH_MAX_DISCOVERY_CANDIDATES` defaults to `8`
- `SOURCE_REFRESH_BACKFILL_LIMIT` defaults to `30`
- `SOURCE_REFRESH_MAX_FEED_ENTRIES` defaults to `100`
- `SOURCE_REFRESH_INTERVAL_SECONDS` defaults to `3600`
- `SOURCE_REFRESH_NO_FEED_RETRY_SECONDS` defaults to `21600`

### Vault secrets for pg_net / cron

The database helper `public.invoke_content_processor(...)` reads these secrets from Supabase Vault:

- `project_url`
- `anon_key` preferred, or `service_role_key` only as a fallback for the `Authorization` bearer token
- `publishable_key`
- `content_processor_secret`

Create them in SQL with values from your project:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<your-anon-key>', 'anon_key');
select vault.create_secret('<your-publishable-key>', 'publishable_key');
select vault.create_secret('<same-secret-as-edge-function>', 'content_processor_secret');
```

If you do not have an `anon_key` available in Vault and need a temporary fallback, you can store the service-role key instead:

```sql
select vault.create_secret('<your-service-role-key>', 'service_role_key');
```

The publishable key is only used for the `apikey` header. It is not sufficient for the `Authorization` bearer token on its own. Prefer the anon key here so the function invocation does not depend on admin credentials.

Once those exist, saves will enqueue processing jobs and the database will immediately kick the Edge Function after commit using `Authorization: Bearer ...`, the optional `apikey` header, and the shared `x-content-processor-secret`. `pg_cron` also invokes the content processor every minute as a recovery path.

Source subscriptions use the same Vault secrets and shared secret. The database helper `public.invoke_source_processor(...)` invokes `process-source-batch` with the same `project_url`, bearer auth token, optional `publishable_key`, and `content_processor_secret` values. The source refresh recovery cron runs every minute.

## Recommendation rollups

Recommendation aggregation no longer uses a separate Supabase Edge Function.

- Raw recommendation telemetry is stored in `public.interaction_events`.
- The database migration creates Postgres-native rollup jobs with `pg_cron`.
- `public.rollup_interaction_events(...)` runs on an hourly schedule.
- `public.refresh_dirty_recommendation_aggregates(...)` runs on a daily schedule.
- Explicit user actions such as saves, favorites, mark-read events, and subscriptions are refreshed synchronously by the Rust API.

If you want to backfill the current dev database immediately after deploying the migration, run:

```sql
select public.rollup_interaction_events(50000);
select public.refresh_dirty_recommendation_aggregates(5000, 5000, 5000);
```
