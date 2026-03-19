create table if not exists public.content_sources (
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

create unique index if not exists content_sources_source_url_unique_idx
    on public.content_sources (source_url);

create index if not exists content_sources_host_idx
    on public.content_sources (host);

create index if not exists content_sources_next_refresh_idx
    on public.content_sources (next_refresh_at);

create table if not exists public.source_feeds (
    id uuid primary key default gen_random_uuid(),
    source_id uuid not null references public.content_sources (id) on delete cascade,
    feed_url text not null,
    feed_kind text not null default 'rss',
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

create unique index if not exists source_feeds_feed_url_unique_idx
    on public.source_feeds (feed_url);

create unique index if not exists source_feeds_primary_unique_idx
    on public.source_feeds (source_id)
    where is_primary;

create index if not exists source_feeds_source_idx
    on public.source_feeds (source_id);

create index if not exists source_feeds_next_refresh_idx
    on public.source_feeds (next_refresh_at);

create table if not exists public.source_feed_entries (
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

create unique index if not exists source_feed_entries_feed_entry_key_unique_idx
    on public.source_feed_entries (feed_id, entry_key);

create index if not exists source_feed_entries_feed_published_idx
    on public.source_feed_entries (feed_id, published_at desc, first_seen_at desc);

create index if not exists source_feed_entries_content_idx
    on public.source_feed_entries (content_id);

create table if not exists public.source_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    source_id uuid not null references public.content_sources (id) on delete cascade,
    last_backfilled_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists source_subscriptions_user_source_unique_idx
    on public.source_subscriptions (user_id, source_id);

create index if not exists source_subscriptions_user_updated_idx
    on public.source_subscriptions (user_id, updated_at desc);

create index if not exists source_subscriptions_source_idx
    on public.source_subscriptions (source_id);

create table if not exists public.subscription_inbox (
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

create unique index if not exists subscription_inbox_subscription_content_unique_idx
    on public.subscription_inbox (subscription_id, content_id);

create index if not exists subscription_inbox_user_delivered_idx
    on public.subscription_inbox (user_id, delivered_at desc, id desc);

create index if not exists subscription_inbox_user_content_idx
    on public.subscription_inbox (user_id, content_id);

create index if not exists subscription_inbox_subscription_idx
    on public.subscription_inbox (subscription_id);

alter table public.content
    add column if not exists source_id uuid references public.content_sources (id) on delete set null;

create index if not exists content_source_id_idx
    on public.content (source_id);

alter table public.content_sources enable row level security;
alter table public.source_feeds enable row level security;
alter table public.source_feed_entries enable row level security;
alter table public.source_subscriptions enable row level security;
alter table public.subscription_inbox enable row level security;

drop trigger if exists content_sources_set_updated_at on public.content_sources;

create trigger content_sources_set_updated_at
before update on public.content_sources
for each row
execute function public.set_current_timestamp_updated_at();

drop trigger if exists source_feeds_set_updated_at on public.source_feeds;

create trigger source_feeds_set_updated_at
before update on public.source_feeds
for each row
execute function public.set_current_timestamp_updated_at();

drop trigger if exists source_feed_entries_set_updated_at on public.source_feed_entries;

create trigger source_feed_entries_set_updated_at
before update on public.source_feed_entries
for each row
execute function public.set_current_timestamp_updated_at();

drop trigger if exists source_subscriptions_set_updated_at on public.source_subscriptions;

create trigger source_subscriptions_set_updated_at
before update on public.source_subscriptions
for each row
execute function public.set_current_timestamp_updated_at();

drop trigger if exists subscription_inbox_set_updated_at on public.subscription_inbox;

create trigger subscription_inbox_set_updated_at
before update on public.subscription_inbox
for each row
execute function public.set_current_timestamp_updated_at();

do $$
begin
    perform pgmq.create('source_refresh');
exception
    when duplicate_table then
        null;
end;
$$;

create or replace function public.enqueue_source_refresh(
    p_source_id uuid,
    p_trigger text default 'subscribe',
    p_delay_seconds integer default 0
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if p_trigger not in ('subscribe', 'retry', 'cron') then
        raise exception 'source refresh trigger % is invalid', p_trigger;
    end if;

    return pgmq.send(
        queue_name => 'source_refresh',
        msg => jsonb_build_object(
            'source_id', p_source_id,
            'trigger', p_trigger,
            'requested_at', timezone('utc', now())
        ),
        delay => greatest(p_delay_seconds, 0)
    );
end;
$$;

create or replace function public.dequeue_source_refresh(
    p_batch_size integer default 10,
    p_visibility_timeout_seconds integer default 300
)
returns table (
    msg_id bigint,
    read_ct integer,
    enqueued_at timestamptz,
    vt timestamptz,
    message jsonb
)
language sql
security definer
set search_path = public, pg_temp
as $$
    select
        msg_id,
        read_ct,
        enqueued_at,
        vt,
        message
    from pgmq.read(
        queue_name => 'source_refresh',
        vt => greatest(p_visibility_timeout_seconds, 1),
        qty => greatest(p_batch_size, 1)
    );
$$;

create or replace function public.archive_source_refresh(
    p_msg_id bigint
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
    select pgmq.archive(
        queue_name => 'source_refresh',
        msg_id => p_msg_id
    );
$$;

create or replace function public.enqueue_due_source_refreshes(
    p_limit integer default 50
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    due_source_id uuid;
    enqueued_count integer := 0;
begin
    for due_source_id in
        select cs.id
        from public.content_sources cs
        where (
            cs.next_refresh_at is null
            or cs.next_refresh_at <= timezone('utc', now())
            or exists (
                select 1
                from public.source_subscriptions ss
                where ss.source_id = cs.id
                  and ss.last_backfilled_at is null
            )
        )
          and not (
              cs.refresh_status = 'in_progress'
              and cs.last_refresh_attempt_at is not null
              and cs.last_refresh_attempt_at >= timezone('utc', now()) - interval '15 minutes'
          )
        order by coalesce(cs.next_refresh_at, timezone('utc', now())) asc, cs.created_at asc
        limit greatest(p_limit, 1)
    loop
        perform public.enqueue_source_refresh(due_source_id, 'cron', 0);
        enqueued_count := enqueued_count + 1;
    end loop;

    return enqueued_count;
end;
$$;

create or replace function public.claim_source_refresh(
    p_source_id uuid,
    p_stale_after_seconds integer default 900
)
returns table (
    id uuid,
    source_url text,
    resolved_source_url text,
    host text,
    refresh_status text,
    refresh_attempt_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    return query
    update public.content_sources as cs
    set refresh_status = 'in_progress',
        last_refresh_attempt_at = timezone('utc', now()),
        last_refresh_error = null,
        refresh_attempt_count = cs.refresh_attempt_count + 1
    where cs.id = p_source_id
      and (
          cs.next_refresh_at is null
          or cs.next_refresh_at <= timezone('utc', now())
          or cs.refresh_status in ('pending', 'failed', 'no_feed')
          or exists (
              select 1
              from public.source_subscriptions ss
              where ss.source_id = cs.id
                and ss.last_backfilled_at is null
          )
          or (
              cs.refresh_status = 'in_progress'
              and cs.last_refresh_attempt_at is not null
              and cs.last_refresh_attempt_at < timezone('utc', now()) - make_interval(secs => greatest(p_stale_after_seconds, 1))
          )
      )
    returning
        cs.id,
        cs.source_url,
        cs.resolved_source_url,
        cs.host,
        cs.refresh_status,
        cs.refresh_attempt_count;
end;
$$;

create or replace function public.invoke_source_processor(
    p_payload jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    project_url text;
    publishable_key text;
    processor_secret text;
begin
    select decrypted_secret
    into project_url
    from vault.decrypted_secrets
    where name = 'project_url'
    order by created_at desc
    limit 1;

    select decrypted_secret
    into publishable_key
    from vault.decrypted_secrets
    where name = 'publishable_key'
    order by created_at desc
    limit 1;

    select decrypted_secret
    into processor_secret
    from vault.decrypted_secrets
    where name = 'content_processor_secret'
    order by created_at desc
    limit 1;

    if coalesce(project_url, '') = ''
        or coalesce(publishable_key, '') = ''
        or coalesce(processor_secret, '') = '' then
        return null;
    end if;

    return net.http_post(
        url := project_url || '/functions/v1/process-source-batch',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || publishable_key,
            'x-content-processor-secret', processor_secret
        ),
        body := coalesce(p_payload, '{}'::jsonb),
        timeout_milliseconds := 1000
    );
end;
$$;

revoke all on function public.enqueue_source_refresh(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.dequeue_source_refresh(integer, integer) from public, anon, authenticated;
revoke all on function public.archive_source_refresh(bigint) from public, anon, authenticated;
revoke all on function public.enqueue_due_source_refreshes(integer) from public, anon, authenticated;
revoke all on function public.claim_source_refresh(uuid, integer) from public, anon, authenticated;
revoke all on function public.invoke_source_processor(jsonb) from public, anon, authenticated;

grant execute on function public.enqueue_source_refresh(uuid, text, integer) to service_role;
grant execute on function public.dequeue_source_refresh(integer, integer) to service_role;
grant execute on function public.archive_source_refresh(bigint) to service_role;
grant execute on function public.enqueue_due_source_refreshes(integer) to service_role;
grant execute on function public.claim_source_refresh(uuid, integer) to service_role;
grant execute on function public.invoke_source_processor(jsonb) to service_role;

do $$
begin
    if exists (
        select 1
        from cron.job
        where jobname = 'process-source-batch-every-minute'
    ) then
        perform cron.unschedule('process-source-batch-every-minute');
    end if;

    perform cron.schedule(
        'process-source-batch-every-minute',
        '* * * * *',
        $job$
        select public.invoke_source_processor(jsonb_build_object('trigger', 'cron'));
        $job$
    );
end;
$$;
