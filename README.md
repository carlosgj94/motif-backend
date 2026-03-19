# Motif Backend

Rust API for authentication, saved content, and background URL processing.

For environment setup and Supabase configuration, see [AUTH_SETUP.md](./AUTH_SETUP.md).

## API Workflow

This API is designed around bearer-token authenticated requests.

- `POST /auth/session` creates a session for an email/password user.
- All `/me/*` routes require `Authorization: Bearer <access_token>`.
- `GET /me/saved-content` returns summary rows for the user library.
- `GET /me/saved-content/{saved_content_id}` returns one saved record with the compact text body the device can render.
- `POST /me/saved-content` saves a new URL and kicks background processing.

Use these examples with your own base URL:

```bash
API=http://127.0.0.1:3000
EMAIL='user@example.com'
PASSWORD='your-password'
```

### 1. Optional: Create an email/password user

If the user does not exist yet:

```bash
curl -sS -X POST "$API/auth/signup" \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "reader01",
    "email": "'"$EMAIL"'",
    "password": "'"$PASSWORD"'"
  }'
```

### 2. Create a session

Get a bearer token:

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

If your device already has a valid Supabase access token, you can skip this step and use that token directly.

Optional sanity check:

```bash
curl -sS "$API/me" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

### 3. Read the saved-content list

This is the lightweight library view. It does not include the full article body.

```bash
curl -sS "$API/me/saved-content?limit=20" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

Example shape:

```json
{
  "content": [
    {
      "id": "saved-content-id",
      "submitted_url": "https://example.com/",
      "read_state": "unread",
      "is_favorited": false,
      "created_at": 1773771640,
      "updated_at": 1773771640,
      "tags": [],
      "content": {
        "id": "content-id",
        "canonical_url": "https://example.com/",
        "host": "example.com",
        "title": "Example Domain",
        "excerpt": "This domain is for use in documentation examples...",
        "has_favicon": false,
        "fetch_status": "succeeded",
        "parse_status": "succeeded"
      }
    }
  ],
  "next_cursor": null
}
```

### 4. Read one saved article or thread

Use the `saved_content_id` from the list response:

```bash
SAVED_CONTENT_ID='saved-content-id'

curl -sS "$API/me/saved-content/$SAVED_CONTENT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | jq
```

The device-readable text is in:

- `.content.body.kind`
- `.content.body.blocks`

Example detail shape:

```json
{
  "id": "saved-content-id",
  "submitted_url": "https://example.com/",
  "read_state": "unread",
  "is_favorited": false,
  "created_at": 1773771640,
  "updated_at": 1773771640,
  "tags": [],
  "content": {
    "id": "content-id",
    "canonical_url": "https://example.com/",
    "resolved_url": "https://example.com/",
    "host": "example.com",
    "site_name": "example.com",
    "source_kind": "article",
    "title": "Example Domain",
    "excerpt": "This domain is for use in documentation examples...",
    "language_code": "en",
    "has_favicon": false,
    "fetch_status": "succeeded",
    "parse_status": "succeeded",
    "parsed_at": 1773771642,
    "body": {
      "kind": "article",
      "blocks": [
        { "t": "p", "x": "This domain is for use in documentation examples without needing permission. Avoid use in operations." },
        { "t": "p", "x": "Learn more" }
      ]
    }
  }
}
```

### 5. Save a new article

Submit a URL:

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

The immediate response is a summary row. New saves usually start as:

- `fetch_status: "pending"`
- `parse_status: "pending"`

Then the content processor fills in metadata and parsed text asynchronously.

### 6. Poll until processing finishes

After saving, keep calling the detail endpoint until the item reaches either:

- `fetch_status: "succeeded"` and `parse_status: "succeeded"`
- `fetch_status: "failed"` and `parse_status: "failed"`

Example poll:

```bash
SAVED_CONTENT_ID='saved-content-id'

curl -sS "$API/me/saved-content/$SAVED_CONTENT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '{id, content: {fetch_status, parse_status, title, body}}'
```

### 7. Optional: Read the favicon

If `has_favicon` is `true`, the summary/detail response will include:

- `favicon_href`, for example `/me/content/<content_id>/favicon`

Fetch it like this:

```bash
CONTENT_ID='content-id'

curl -sS "$API/me/content/$CONTENT_ID/favicon" \
  -H "Authorization: Bearer $TOKEN" \
  --output favicon.bin
```

## Minimal Embedded Flow

For a low-resource device, the normal flow is:

1. Create a session with `POST /auth/session`.
2. Call `GET /me/saved-content` to show the library.
3. Call `GET /me/saved-content/{saved_content_id}` only when the user opens one item.
4. Read `content.body.blocks` and render that compact text representation.
5. Use `POST /me/saved-content` when the user saves a new URL.
6. Poll the detail endpoint until processing completes.
