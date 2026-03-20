# Motif Backend

Rust API for authentication, saved content, subscriptions, inbox delivery, and recommendations.

For environment setup and Supabase configuration, see [AUTH_SETUP.md](./AUTH_SETUP.md).

## Toolchain

- Rust `1.88+` is required.
- This repo pins `rust-toolchain.toml` to `1.88.0`.
- If your environment defaults to `rustc 1.85.1`, update the toolchain before building.

## Basics

- `POST /auth/session` creates an email/password session.
- All `/me/*` routes require `Authorization: Bearer <access_token>`.
- Public response timestamps are Unix seconds.
- Compact readable text is returned in `body.blocks`.
- Favicons are fetched separately from `/me/content/{content_id}/favicon`.

## Recommended Onboarding Flow

Use this flow if you do not want the Supabase `service_role` key in the backend:

1. Call `GET /recommendations/topics`.
2. Call `POST /recommendations/sources/preview` with the user's selected `topic_slugs`.
3. Call `POST /auth/signup` with only `username`, `email`, and `password`.
4. Call `POST /auth/session`.
5. Call `PUT /me/recommendation-preferences`.
6. Call `POST /me/source-subscriptions` for each selected source.

## Endpoint Index

### Public

- `GET /`
- `GET /health`
- `POST /auth/signup`
- `POST /auth/session`
- `POST /auth/session/refresh`
- `GET /recommendations/topics`
- `POST /recommendations/sources/preview`
- `GET /profiles/{username}`

### Profile

- `GET /me`
- `PUT /me/profile`

### Saved content

- `POST /me/saved-content`
- `GET /me/saved-content`
- `GET /me/saved-content/{saved_content_id}`
- `PATCH /me/saved-content/{saved_content_id}`
- `DELETE /me/saved-content/{saved_content_id}`
- `GET /me/tags`

### Content

- `GET /me/content/{content_id}`
- `GET /me/content/{content_id}/favicon`

### Source subscriptions

- `POST /me/source-subscriptions`
- `GET /me/source-subscriptions`
- `DELETE /me/source-subscriptions/{subscription_id}`

### Inbox

- `GET /me/inbox`
- `GET /me/inbox/{inbox_item_id}`
- `PATCH /me/inbox/{inbox_item_id}`

### Recommendations

- `GET /me/recommendations/content`
- `GET /me/recommendations/sources`
- `GET /me/recommendation-preferences`
- `PUT /me/recommendation-preferences`
- `POST /me/interaction-events/batch`

Use these examples with your own base URL:

```bash
API=http://127.0.0.1:3000
EMAIL='user@example.com'
PASSWORD='your-password'
```

## Common Flow

### 1. Fetch onboarding topics

```bash
curl -sS "$API/recommendations/topics" | jq
```

### 2. Preview onboarding sources

```bash
curl -sS -X POST "$API/recommendations/sources/preview" \
  -H 'Content-Type: application/json' \
  -d '{
    "topic_slugs": ["technology", "science"],
    "language_codes": ["en"],
    "limit": 10
  }' \
  | jq
```

### 3. Create a user

```bash
curl -sS -X POST "$API/auth/signup" \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "reader01",
    "email": "'"$EMAIL"'",
    "password": "'"$PASSWORD"'"
  }' \
  | jq
```

### 4. Create a session

```bash
TOKEN=$(
  curl -sS -X POST "$API/auth/session" \
    -H 'Content-Type: application/json' \
    -d '{
      "email": "'"$EMAIL"'",
      "password": "'"$PASSWORD"'"
    }' \
  | jq -r '.session.access_token'
)
```

### 4b. Refresh a session

```bash
curl -sS -X POST "$API/auth/session/refresh" \
  -H 'Content-Type: application/json' \
  -d '{
    "refresh_token": "'"$REFRESH_TOKEN"'"
  }' \
  | jq
```

### 5. Save onboarding preferences

```bash
curl -sS -X PUT "$API/me/recommendation-preferences" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "topic_slugs": ["technology", "science"],
    "language_codes": ["en"]
  }' \
  | jq
```

### 6. Subscribe to selected sources

```bash
curl -sS -X POST "$API/me/source-subscriptions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "source_url": "https://example.com/"
  }' \
  | jq
```

### 7. Fetch the library

```bash
curl -sS "$API/me/saved-content?limit=20" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

### 8. Save a new URL

```bash
curl -sS -X POST "$API/me/saved-content" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://cra.mr/optimizing-content-for-agents/",
    "tag_slugs": ["technology"]
  }' \
  | jq
```

### 9. Read one item

```bash
SAVED_CONTENT_ID='saved-content-id'

curl -sS "$API/me/saved-content/$SAVED_CONTENT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

Readable content is in:

- `.content.body.kind`
- `.content.body.blocks`

### 10. Fetch recommendations

```bash
curl -sS "$API/me/recommendations/content?limit=10" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

### 11. Report reading telemetry

```bash
SERVE_ID='recommendation-serve-id'
CONTENT_ID='content-id'

curl -sS -X POST "$API/me/interaction-events/batch" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "events": [
      {
        "event_type": "open",
        "content_id": "'"$CONTENT_ID"'",
        "surface": "recommendations_content",
        "serve_id": "'"$SERVE_ID"'",
        "position": 0,
        "occurred_at": 1774000000,
        "client_event_id": "11111111-1111-1111-1111-111111111111"
      },
      {
        "event_type": "heartbeat",
        "content_id": "'"$CONTENT_ID"'",
        "surface": "recommendations_content",
        "serve_id": "'"$SERVE_ID"'",
        "position": 0,
        "visible_ms_delta": 15000,
        "occurred_at": 1774000015,
        "client_event_id": "22222222-2222-2222-2222-222222222222"
      }
    ]
  }' \
  | jq
```

## Endpoint Reference

### Public routes

#### `GET /`

Health check.

Example:

```bash
curl -sS "$API/" | jq
```

#### `GET /health`

Health check.

Example:

```bash
curl -sS "$API/health" | jq
```

#### `POST /auth/signup`

Create an email/password user.

Request body:

```json
{
  "username": "reader01",
  "email": "user@example.com",
  "password": "your-password"
}
```

Signup is auth-only. Apply onboarding preferences and source subscriptions after `POST /auth/session` with:

- `PUT /me/recommendation-preferences`
- `POST /me/source-subscriptions`

Older clients can still send extra onboarding keys in the signup payload; they are ignored.

#### `POST /auth/session`

Create an email/password session.

Request body:

```json
{
  "email": "user@example.com",
  "password": "your-password"
}
```

#### `POST /auth/session/refresh`

Exchange a refresh token for a new session.

Request body:

```json
{
  "refresh_token": "supabase-refresh-token"
}
```

#### `GET /recommendations/topics`

List the public recommendation topics available for onboarding.

Example:

```bash
curl -sS "$API/recommendations/topics" | jq
```

#### `GET /profiles/{username}`

Get a public profile by username.

Example:

```bash
curl -sS "$API/profiles/reader01" | jq
```

### Authenticated profile routes

#### `GET /me`

Return the current auth user plus optional profile row.

Example:

```bash
curl -sS "$API/me" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

#### `PUT /me/profile`

Create or update the user profile.

Request body:

```json
{
  "username": "reader01",
  "display_name": "Reader 01",
  "avatar_url": "https://example.com/avatar.png"
}
```

### Authenticated saved-content routes

#### `POST /me/saved-content`

Save a URL to the user library and trigger background processing.

Request body:

```json
{
  "url": "https://cra.mr/optimizing-content-for-agents/",
  "tag_slugs": ["technology"]
}
```

#### `GET /me/saved-content`

List saved content summaries.

Query parameters:

- `limit`
- `cursor`
- `read_state`
- `favorited`
- `archived`
- `tag`

Example:

```bash
curl -sS "$API/me/saved-content?limit=20&archived=false" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

#### `GET /me/saved-content/{saved_content_id}`

Return one saved item with compact body text.

Example:

```bash
curl -sS "$API/me/saved-content/$SAVED_CONTENT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

#### `PATCH /me/saved-content/{saved_content_id}`

Update saved-content state.

Request body accepts any non-empty subset of:

```json
{
  "read_state": "read",
  "is_favorited": true,
  "is_archived": false,
  "tag_slugs": ["technology", "science"]
}
```

#### `DELETE /me/saved-content/{saved_content_id}`

Delete one saved-content row.

Example:

```bash
curl -sS -X DELETE "$API/me/saved-content/$SAVED_CONTENT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -i
```

#### `GET /me/tags`

List system tags plus the user’s custom tags.

Example:

```bash
curl -sS "$API/me/tags" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

### Authenticated content routes

#### `GET /me/content/{content_id}`

Return content by `content_id` without requiring it to already be saved. This is the main detail route for recommended content.

Example:

```bash
CONTENT_ID='content-id'

curl -sS "$API/me/content/$CONTENT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

#### `GET /me/content/{content_id}/favicon`

Return favicon bytes for a content row when available.

Example:

```bash
curl -sS "$API/me/content/$CONTENT_ID/favicon" \
  -H "Authorization: Bearer $TOKEN" \
  --output favicon.bin
```

### Authenticated source subscription routes

#### `POST /me/source-subscriptions`

Subscribe to a source homepage. `feed_url` is optional.

Request body:

```json
{
  "source_url": "https://cra.mr/",
  "feed_url": "https://cra.mr/feed.xml"
}
```

#### `GET /me/source-subscriptions`

List current source subscriptions.

Example:

```bash
curl -sS "$API/me/source-subscriptions" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

#### `DELETE /me/source-subscriptions/{subscription_id}`

Unsubscribe from a source. Existing inbox rows are kept.

Example:

```bash
SUBSCRIPTION_ID='source-subscription-id'

curl -sS -X DELETE "$API/me/source-subscriptions/$SUBSCRIPTION_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -i
```

### Authenticated inbox routes

#### `GET /me/inbox`

List subscription-delivered posts.

Query parameters:

- `limit`
- `cursor`
- `read_state`
- `dismissed`
- `subscription_id`

Example:

```bash
curl -sS "$API/me/inbox?limit=20" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

#### `GET /me/inbox/{inbox_item_id}`

Return one inbox item with the same compact body contract used by saved content.

Example:

```bash
INBOX_ITEM_ID='inbox-item-id'

curl -sS "$API/me/inbox/$INBOX_ITEM_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

#### `PATCH /me/inbox/{inbox_item_id}`

Update inbox state.

Request body accepts any non-empty subset of:

```json
{
  "read_state": "read",
  "is_dismissed": true
}
```

### Authenticated recommendation routes

#### `GET /me/recommendations/content`

Return a ranked content feed plus a `serve_id` for telemetry attribution.

Query parameters:

- `limit`

Example:

```bash
curl -sS "$API/me/recommendations/content?limit=10" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

Example shape:

```json
{
  "serve_id": "recommendation-serve-id",
  "content": [
    {
      "position": 0,
      "is_saved": false,
      "is_subscribed_source": true,
      "content": {
        "id": "content-id",
        "canonical_url": "https://example.com/article",
        "host": "example.com",
        "title": "Example Article",
        "has_favicon": true,
        "favicon_href": "/me/content/content-id/favicon",
        "fetch_status": "succeeded",
        "parse_status": "succeeded"
      },
      "source": {
        "id": "source-id",
        "source_url": "https://example.com/",
        "host": "example.com",
        "title": "Example Source"
      }
    }
  ]
}
```

#### `GET /me/recommendations/sources`

Return ranked source suggestions plus a `serve_id`.

Query parameters:

- `limit`

Example:

```bash
curl -sS "$API/me/recommendations/sources?limit=10" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

#### `POST /recommendations/sources/preview`

Get public source recommendations for onboarding before a user exists.

Request body:

```json
{
  "topic_slugs": ["technology", "science"],
  "language_codes": ["en"],
  "limit": 10
}
```

#### `PUT /me/recommendation-preferences`

Set onboarding-style recommendation preferences.

Request body:

```json
{
  "topic_slugs": ["technology", "science"],
  "language_codes": ["en"]
}
```

#### `GET /me/recommendation-preferences`

Read the authenticated user's current recommendation preferences.

```bash
curl -sS "$API/me/recommendation-preferences" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

#### `POST /me/interaction-events/batch`

Batch-read telemetry for recommendations or other surfaces.

Request body:

```json
{
  "events": [
    {
      "event_type": "impression",
      "content_id": "content-id",
      "surface": "recommendations_content",
      "serve_id": "recommendation-serve-id",
      "position": 0,
      "occurred_at": 1774000000,
      "client_event_id": "11111111-1111-1111-1111-111111111111"
    },
    {
      "event_type": "heartbeat",
      "content_id": "content-id",
      "surface": "recommendations_content",
      "serve_id": "recommendation-serve-id",
      "position": 0,
      "visible_ms_delta": 15000,
      "occurred_at": 1774000015,
      "client_event_id": "22222222-2222-2222-2222-222222222222"
    }
  ]
}
```

Supported public event types:

- `impression`
- `open`
- `heartbeat`
- `close`
- `dismiss`

Event fields:

- `content_id` or `source_id` is required
- `client_event_id` is required
- `heartbeat` requires `visible_ms_delta`
- `surface`, `session_id`, `serve_id`, `position`, `occurred_at`, and `metadata` are optional

## Notes For Device Clients

- Use list endpoints for summary views and detail endpoints only when the user opens one item.
- The compact body contract is intentionally minimal:
  - heading: `{ "t": "h", "l": 2, "x": "Heading" }`
  - paragraph: `{ "t": "p", "x": "Paragraph text" }`
  - quote: `{ "t": "q", "x": "Quoted text" }`
  - list: `{ "t": "l", "o": false, "i": ["A", "B"] }`
  - code: `{ "t": "c", "x": "code", "lang": "rust" }`
- Processing is asynchronous. Newly saved or newly delivered content can be `pending` before text is ready.
- Recommendation telemetry should be batched instead of sent one request per event.
