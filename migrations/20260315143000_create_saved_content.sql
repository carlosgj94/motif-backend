create table if not exists public.content_items (
    id uuid primary key default gen_random_uuid(),
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
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint content_items_canonical_url_not_blank check (btrim(canonical_url) <> ''),
    constraint content_items_host_not_blank check (btrim(host) <> ''),
    constraint content_items_source_kind_not_blank check (
        source_kind is null or btrim(source_kind) <> ''
    ),
    constraint content_items_language_code_length check (
        language_code is null or char_length(language_code) between 2 and 16
    ),
    constraint content_items_parser_name_not_blank check (
        parser_name is null or btrim(parser_name) <> ''
    ),
    constraint content_items_parser_version_not_blank check (
        parser_version is null or btrim(parser_version) <> ''
    ),
    constraint content_items_favicon_pair check (
        (favicon_bytes is null and favicon_mime_type is null)
        or (favicon_bytes is not null and favicon_mime_type is not null)
    ),
    constraint content_items_parsed_document_shape check (
        parsed_document is null or jsonb_typeof(parsed_document) = 'object'
    ),
    constraint content_items_fetch_status check (
        fetch_status in ('pending', 'in_progress', 'succeeded', 'failed')
    ),
    constraint content_items_parse_status check (
        parse_status in ('pending', 'in_progress', 'succeeded', 'failed')
    ),
    constraint content_items_last_http_status_range check (
        last_http_status is null or last_http_status between 100 and 599
    )
);

create unique index if not exists content_items_canonical_url_unique_idx
    on public.content_items (canonical_url);

create index if not exists content_items_host_idx
    on public.content_items (host);

create index if not exists content_items_fetch_status_idx
    on public.content_items (fetch_status);

create index if not exists content_items_parse_status_idx
    on public.content_items (parse_status);

create table if not exists public.saved_items (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    content_item_id uuid not null references public.content_items (id) on delete cascade,
    submitted_url text not null,
    read_state text not null default 'unread',
    is_favorited boolean not null default false,
    archived_at timestamptz,
    last_opened_at timestamptz,
    read_completed_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint saved_items_submitted_url_not_blank check (btrim(submitted_url) <> ''),
    constraint saved_items_read_state check (
        read_state in ('unread', 'reading', 'read')
    )
);

create unique index if not exists saved_items_user_content_unique_idx
    on public.saved_items (user_id, content_item_id);

create index if not exists saved_items_user_updated_idx
    on public.saved_items (user_id, updated_at desc);

create index if not exists saved_items_content_item_idx
    on public.saved_items (content_item_id);

create table if not exists public.tags (
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

create unique index if not exists tags_system_slug_unique_idx
    on public.tags (slug)
    where owner_user_id is null;

create unique index if not exists tags_custom_owner_slug_unique_idx
    on public.tags (owner_user_id, slug)
    where owner_user_id is not null;

create index if not exists tags_scope_idx
    on public.tags (scope);

create table if not exists public.saved_item_tags (
    saved_item_id uuid not null references public.saved_items (id) on delete cascade,
    tag_id uuid not null references public.tags (id) on delete cascade,
    created_at timestamptz not null default timezone('utc', now()),
    primary key (saved_item_id, tag_id)
);

create index if not exists saved_item_tags_tag_idx
    on public.saved_item_tags (tag_id);

create or replace function public.validate_saved_item_tag_scope()
returns trigger
language plpgsql
as $$
declare
    saved_item_user_id uuid;
    tag_owner_user_id uuid;
    tag_scope text;
begin
    select user_id
    into saved_item_user_id
    from public.saved_items
    where id = new.saved_item_id;

    select owner_user_id, scope
    into tag_owner_user_id, tag_scope
    from public.tags
    where id = new.tag_id;

    if tag_scope is null then
        raise exception 'tag % does not exist', new.tag_id;
    end if;

    if saved_item_user_id is null then
        raise exception 'saved item % does not exist', new.saved_item_id;
    end if;

    if tag_scope = 'custom' and tag_owner_user_id <> saved_item_user_id then
        raise exception 'custom tags may only be attached to the owning user''s saved items';
    end if;

    return new;
end;
$$;

drop trigger if exists content_items_set_updated_at on public.content_items;

create trigger content_items_set_updated_at
before update on public.content_items
for each row
execute function public.set_current_timestamp_updated_at();

drop trigger if exists saved_items_set_updated_at on public.saved_items;

create trigger saved_items_set_updated_at
before update on public.saved_items
for each row
execute function public.set_current_timestamp_updated_at();

drop trigger if exists tags_set_updated_at on public.tags;

create trigger tags_set_updated_at
before update on public.tags
for each row
execute function public.set_current_timestamp_updated_at();

drop trigger if exists saved_item_tags_validate_scope on public.saved_item_tags;

create trigger saved_item_tags_validate_scope
before insert or update on public.saved_item_tags
for each row
execute function public.validate_saved_item_tag_scope();

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
    ('system', 'finance', 'Finance', 'Investing, economics, and financial systems')
on conflict do nothing;
