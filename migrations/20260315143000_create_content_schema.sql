create table public.content_sources (
    id uuid primary key default gen_random_uuid(),
    source_url text not null,
    resolved_source_url text,
    host text not null,
    title text,
    description text,
    source_kind text not null default 'website',
    refresh_status text not null default 'pending',
    last_refresh_attempt_at timestamptz,
    last_refreshed_at timestamptz,
    next_refresh_at timestamptz,
    last_refresh_error text,
    last_http_status integer,
    refresh_attempt_count integer not null default 0,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint content_sources_source_url_not_blank check (btrim(source_url) <> ''),
    constraint content_sources_host_not_blank check (btrim(host) <> ''),
    constraint content_sources_source_kind_not_blank check (btrim(source_kind) <> ''),
    constraint content_sources_refresh_status check (
        refresh_status in ('pending', 'in_progress', 'succeeded', 'failed', 'no_feed')
    ),
    constraint content_sources_last_http_status_range check (
        last_http_status is null or last_http_status between 100 and 599
    ),
    constraint content_sources_refresh_attempt_count_nonnegative check (
        refresh_attempt_count >= 0
    )
);

create unique index content_sources_source_url_unique_idx
    on public.content_sources (source_url);

create index content_sources_host_idx
    on public.content_sources (host);

create index content_sources_next_refresh_idx
    on public.content_sources (next_refresh_at);

create table public.content (
    id uuid primary key default gen_random_uuid(),
    source_id uuid references public.content_sources (id) on delete set null,
    canonical_url text not null,
    resolved_url text,
    host text not null,
    site_name text,
    source_kind text,
    title text,
    excerpt text,
    author text,
    published_at timestamptz,
    language_code text,
    cover_image_url text,
    favicon_bytes bytea,
    favicon_mime_type text,
    favicon_source_url text,
    favicon_fetched_at timestamptz,
    parsed_document jsonb,
    parsed_at timestamptz,
    parser_name text,
    parser_version text,
    fetch_status text not null default 'pending',
    parse_status text not null default 'pending',
    last_fetch_attempt_at timestamptz,
    last_parse_attempt_at timestamptz,
    last_fetch_error text,
    last_parse_error text,
    last_http_status integer,
    last_successful_fetch_at timestamptz,
    fetch_attempt_count integer not null default 0,
    parse_attempt_count integer not null default 0,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint content_canonical_url_not_blank check (btrim(canonical_url) <> ''),
    constraint content_host_not_blank check (btrim(host) <> ''),
    constraint content_source_kind_not_blank check (
        source_kind is null or btrim(source_kind) <> ''
    ),
    constraint content_language_code_length check (
        language_code is null or char_length(language_code) between 2 and 16
    ),
    constraint content_parser_name_not_blank check (
        parser_name is null or btrim(parser_name) <> ''
    ),
    constraint content_parser_version_not_blank check (
        parser_version is null or btrim(parser_version) <> ''
    ),
    constraint content_favicon_pair check (
        (favicon_bytes is null and favicon_mime_type is null)
        or (favicon_bytes is not null and favicon_mime_type is not null)
    ),
    constraint content_parsed_document_shape check (
        parsed_document is null or jsonb_typeof(parsed_document) = 'object'
    ),
    constraint content_fetch_status check (
        fetch_status in ('pending', 'in_progress', 'succeeded', 'failed')
    ),
    constraint content_parse_status check (
        parse_status in ('pending', 'in_progress', 'succeeded', 'failed')
    ),
    constraint content_last_http_status_range check (
        last_http_status is null or last_http_status between 100 and 599
    ),
    constraint content_fetch_attempt_count_nonnegative check (fetch_attempt_count >= 0),
    constraint content_parse_attempt_count_nonnegative check (parse_attempt_count >= 0)
);

create unique index content_canonical_url_unique_idx
    on public.content (canonical_url);

create index content_host_idx
    on public.content (host);

create index content_fetch_status_idx
    on public.content (fetch_status);

create index content_parse_status_idx
    on public.content (parse_status);

create index content_source_id_idx
    on public.content (source_id);

create table public.saved_content (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    content_id uuid not null references public.content (id) on delete cascade,
    submitted_url text not null,
    read_state text not null default 'unread',
    is_favorited boolean not null default false,
    archived_at timestamptz,
    last_opened_at timestamptz,
    read_completed_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint saved_content_submitted_url_not_blank check (btrim(submitted_url) <> ''),
    constraint saved_content_read_state check (
        read_state in ('unread', 'reading', 'read')
    )
);

create unique index saved_content_user_content_unique_idx
    on public.saved_content (user_id, content_id);

create index saved_content_user_updated_idx
    on public.saved_content (user_id, updated_at desc);

create index saved_content_content_idx
    on public.saved_content (content_id);

create table public.tags (
    id uuid primary key default gen_random_uuid(),
    owner_user_id uuid references auth.users (id) on delete cascade,
    scope text not null,
    slug text not null,
    label text not null,
    description text,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint tags_scope check (scope in ('system', 'custom')),
    constraint tags_scope_owner check (
        (scope = 'system' and owner_user_id is null)
        or (scope = 'custom' and owner_user_id is not null)
    ),
    constraint tags_slug_format check (slug ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    constraint tags_label_not_blank check (btrim(label) <> '')
);

create unique index tags_system_slug_unique_idx
    on public.tags (slug)
    where owner_user_id is null;

create unique index tags_custom_owner_slug_unique_idx
    on public.tags (owner_user_id, slug)
    where owner_user_id is not null;

create index tags_scope_idx
    on public.tags (scope);

create table public.saved_content_tags (
    saved_content_id uuid not null references public.saved_content (id) on delete cascade,
    tag_id uuid not null references public.tags (id) on delete cascade,
    created_at timestamptz not null default timezone('utc', now()),
    primary key (saved_content_id, tag_id)
);

create index saved_content_tags_tag_idx
    on public.saved_content_tags (tag_id);

create or replace function public.validate_saved_content_tag_scope()
returns trigger
language plpgsql
as $$
declare
    saved_content_user_id uuid;
    tag_owner_user_id uuid;
    tag_scope text;
begin
    select user_id
    into saved_content_user_id
    from public.saved_content
    where id = new.saved_content_id;

    select owner_user_id, scope
    into tag_owner_user_id, tag_scope
    from public.tags
    where id = new.tag_id;

    if tag_scope is null then
        raise exception 'tag % does not exist', new.tag_id;
    end if;

    if saved_content_user_id is null then
        raise exception 'saved content % does not exist', new.saved_content_id;
    end if;

    if tag_scope = 'custom' and tag_owner_user_id <> saved_content_user_id then
        raise exception 'custom tags may only be attached to the owning user''s saved content';
    end if;

    return new;
end;
$$;

create table public.source_feeds (
    id uuid primary key default gen_random_uuid(),
    source_id uuid not null references public.content_sources (id) on delete cascade,
    feed_url text not null,
    feed_kind text not null default 'unknown',
    discovery_method text not null,
    is_primary boolean not null default false,
    title text,
    etag text,
    last_modified text,
    refresh_status text not null default 'pending',
    last_refresh_attempt_at timestamptz,
    last_refreshed_at timestamptz,
    next_refresh_at timestamptz,
    last_refresh_error text,
    last_http_status integer,
    refresh_attempt_count integer not null default 0,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint source_feeds_feed_url_not_blank check (btrim(feed_url) <> ''),
    constraint source_feeds_feed_kind check (feed_kind in ('rss', 'atom', 'jsonfeed', 'unknown')),
    constraint source_feeds_discovery_method check (
        discovery_method in ('provided', 'html_link', 'common_path')
    ),
    constraint source_feeds_refresh_status check (
        refresh_status in ('pending', 'in_progress', 'succeeded', 'failed')
    ),
    constraint source_feeds_last_http_status_range check (
        last_http_status is null or last_http_status between 100 and 599
    ),
    constraint source_feeds_refresh_attempt_count_nonnegative check (
        refresh_attempt_count >= 0
    )
);

create unique index source_feeds_source_feed_url_unique_idx
    on public.source_feeds (source_id, feed_url);

create unique index source_feeds_primary_unique_idx
    on public.source_feeds (source_id)
    where is_primary;

create index source_feeds_source_idx
    on public.source_feeds (source_id);

create index source_feeds_next_refresh_idx
    on public.source_feeds (next_refresh_at);

create table public.source_feed_entries (
    id uuid primary key default gen_random_uuid(),
    feed_id uuid not null references public.source_feeds (id) on delete cascade,
    entry_key text not null,
    entry_guid text,
    entry_url text not null,
    content_id uuid not null references public.content (id) on delete cascade,
    title text,
    published_at timestamptz,
    raw_payload jsonb,
    first_seen_at timestamptz not null default timezone('utc', now()),
    last_seen_at timestamptz not null default timezone('utc', now()),
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint source_feed_entries_entry_key_not_blank check (btrim(entry_key) <> ''),
    constraint source_feed_entries_entry_url_not_blank check (btrim(entry_url) <> ''),
    constraint source_feed_entries_raw_payload_shape check (
        raw_payload is null or jsonb_typeof(raw_payload) = 'object'
    )
);

create unique index source_feed_entries_feed_entry_key_unique_idx
    on public.source_feed_entries (feed_id, entry_key);

create index source_feed_entries_feed_published_idx
    on public.source_feed_entries (feed_id, published_at desc, first_seen_at desc);

create index source_feed_entries_content_idx
    on public.source_feed_entries (content_id);

create table public.source_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    source_id uuid not null references public.content_sources (id) on delete cascade,
    last_backfilled_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

create unique index source_subscriptions_user_source_unique_idx
    on public.source_subscriptions (user_id, source_id);

create index source_subscriptions_user_updated_idx
    on public.source_subscriptions (user_id, updated_at desc);

create index source_subscriptions_source_idx
    on public.source_subscriptions (source_id);

create table public.subscription_inbox (
    id uuid primary key default gen_random_uuid(),
    subscription_id uuid not null references public.source_subscriptions (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    content_id uuid not null references public.content (id) on delete cascade,
    delivered_at timestamptz not null default timezone('utc', now()),
    read_state text not null default 'unread',
    read_at timestamptz,
    dismissed_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint subscription_inbox_read_state check (
        read_state in ('unread', 'reading', 'read')
    )
);

create unique index subscription_inbox_subscription_content_unique_idx
    on public.subscription_inbox (subscription_id, content_id);

create index subscription_inbox_user_delivered_idx
    on public.subscription_inbox (user_id, delivered_at desc, id desc);

create index subscription_inbox_user_content_idx
    on public.subscription_inbox (user_id, content_id);

create index subscription_inbox_subscription_idx
    on public.subscription_inbox (subscription_id);

alter table public.content enable row level security;
alter table public.saved_content enable row level security;
alter table public.tags enable row level security;
alter table public.saved_content_tags enable row level security;
alter table public.content_sources enable row level security;
alter table public.source_feeds enable row level security;
alter table public.source_feed_entries enable row level security;
alter table public.source_subscriptions enable row level security;
alter table public.subscription_inbox enable row level security;

create trigger content_set_updated_at
before update on public.content
for each row
execute function public.set_current_timestamp_updated_at();

create trigger saved_content_set_updated_at
before update on public.saved_content
for each row
execute function public.set_current_timestamp_updated_at();

create trigger tags_set_updated_at
before update on public.tags
for each row
execute function public.set_current_timestamp_updated_at();

create trigger saved_content_tags_validate_scope
before insert or update on public.saved_content_tags
for each row
execute function public.validate_saved_content_tag_scope();

create trigger content_sources_set_updated_at
before update on public.content_sources
for each row
execute function public.set_current_timestamp_updated_at();

create trigger source_feeds_set_updated_at
before update on public.source_feeds
for each row
execute function public.set_current_timestamp_updated_at();

create trigger source_feed_entries_set_updated_at
before update on public.source_feed_entries
for each row
execute function public.set_current_timestamp_updated_at();

create trigger source_subscriptions_set_updated_at
before update on public.source_subscriptions
for each row
execute function public.set_current_timestamp_updated_at();

create trigger subscription_inbox_set_updated_at
before update on public.subscription_inbox
for each row
execute function public.set_current_timestamp_updated_at();

insert into public.tags (scope, slug, label, description)
values
    ('system', 'technology', 'Technology', 'Computing, software, internet, and engineering'),
    ('system', 'science', 'Science', 'Research, discovery, and scientific thinking'),
    ('system', 'society', 'Society', 'Communities, institutions, and social change'),
    ('system', 'business', 'Business', 'Companies, markets, and strategy'),
    ('system', 'design', 'Design', 'Product, visual, and interaction design'),
    ('system', 'culture', 'Culture', 'Art, media, entertainment, and cultural trends'),
    ('system', 'politics', 'Politics', 'Government, public policy, and civic affairs'),
    ('system', 'health', 'Health', 'Medicine, wellbeing, and public health'),
    ('system', 'finance', 'Finance', 'Investing, economics, and financial systems');
