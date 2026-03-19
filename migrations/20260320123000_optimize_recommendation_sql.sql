alter table public.content_sources
    add column if not exists primary_feed_id uuid references public.source_feeds (id) on delete set null;

update public.content_sources cs
set primary_feed_id = sf.id
from (
    select distinct on (source_id)
        source_id,
        id
    from public.source_feeds
    where is_primary
    order by source_id, created_at asc
) sf
where cs.id = sf.source_id
  and cs.primary_feed_id is distinct from sf.id;

create or replace function public.sync_content_source_primary_feed_id()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
    replacement_feed_id uuid;
    target_source_id uuid;
    target_feed_id uuid;
    current_primary_feed_id uuid;
begin
    target_source_id := coalesce(new.source_id, old.source_id);
    target_feed_id := coalesce(new.id, old.id);

    select primary_feed_id
    into current_primary_feed_id
    from public.content_sources
    where id = target_source_id;

    if tg_op <> 'DELETE' and new.is_primary then
        update public.content_sources
        set primary_feed_id = new.id
        where id = new.source_id;
        return coalesce(new, old);
    end if;

    if current_primary_feed_id is distinct from target_feed_id then
        return coalesce(new, old);
    end if;

    select sf.id
    into replacement_feed_id
    from public.source_feeds sf
    where sf.source_id = target_source_id
      and sf.id <> target_feed_id
      and sf.is_primary
    order by sf.created_at asc
    limit 1;

    if replacement_feed_id is null then
        select sf.id
        into replacement_feed_id
        from public.source_feeds sf
        where sf.source_id = target_source_id
          and sf.id <> target_feed_id
        order by sf.is_primary desc, sf.created_at asc
        limit 1;
    end if;

    update public.content_sources
    set primary_feed_id = replacement_feed_id
    where id = target_source_id;

    return coalesce(new, old);
end;
$$;

drop trigger if exists source_feeds_sync_primary_feed_id on public.source_feeds;

create trigger source_feeds_sync_primary_feed_id
after insert or update or delete on public.source_feeds
for each row
execute function public.sync_content_source_primary_feed_id();

drop index if exists public.content_recommendable_recent_idx;
drop index if exists public.saved_content_user_updated_idx;
drop index if exists public.subscription_inbox_user_delivered_idx;
drop index if exists public.saved_content_tags_tag_idx;

create index content_recommendable_recent_idx
    on public.content ((coalesce(published_at, created_at)) desc, id desc)
    where parse_status = 'succeeded' and parsed_document is not null;

create index content_recommendable_source_recent_idx
    on public.content (source_id, (coalesce(published_at, created_at)) desc, id desc)
    where parse_status = 'succeeded' and parsed_document is not null and source_id is not null;

create index saved_content_active_user_updated_idx
    on public.saved_content (user_id, updated_at desc, id desc)
    where archived_at is null;

create index saved_content_active_user_content_idx
    on public.saved_content (user_id, content_id)
    where archived_at is null;

create index subscription_inbox_active_user_delivered_idx
    on public.subscription_inbox (user_id, delivered_at desc, id desc)
    where dismissed_at is null;

create index subscription_inbox_active_user_subscription_delivered_idx
    on public.subscription_inbox (user_id, subscription_id, delivered_at desc, id desc)
    where dismissed_at is null;

create index saved_content_tags_tag_saved_content_idx
    on public.saved_content_tags (tag_id, saved_content_id);

create index user_content_feedback_user_content_dismissed_idx
    on public.user_content_feedback (user_id, content_id)
    where dismiss_count > 0;

create table if not exists public.recommendation_rollup_state (
    name text primary key,
    last_event_id bigint not null default 0,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint recommendation_rollup_state_name_not_blank check (btrim(name) <> '')
);

insert into public.recommendation_rollup_state (name, last_event_id)
values ('interaction_events', 0)
on conflict (name) do nothing;

drop trigger if exists recommendation_rollup_state_set_updated_at on public.recommendation_rollup_state;

create trigger recommendation_rollup_state_set_updated_at
before update on public.recommendation_rollup_state
for each row
execute function public.set_current_timestamp_updated_at();

create table if not exists public.user_content_feedback_daily (
    user_id uuid not null references auth.users (id) on delete cascade,
    content_id uuid not null references public.content (id) on delete cascade,
    signal_date date not null,
    source_id uuid references public.content_sources (id) on delete set null,
    impression_count integer not null default 0,
    open_count integer not null default 0,
    heartbeat_count integer not null default 0,
    dismiss_count integer not null default 0,
    save_count integer not null default 0,
    favorite_count integer not null default 0,
    mark_read_count integer not null default 0,
    total_visible_ms bigint not null default 0,
    last_interacted_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    primary key (user_id, content_id, signal_date),
    constraint user_content_feedback_daily_counts_nonnegative check (
        impression_count >= 0
        and open_count >= 0
        and heartbeat_count >= 0
        and dismiss_count >= 0
        and save_count >= 0
        and favorite_count >= 0
        and mark_read_count >= 0
        and total_visible_ms >= 0
    )
);

create index if not exists user_content_feedback_daily_user_date_idx
    on public.user_content_feedback_daily (user_id, signal_date desc, content_id);

create index if not exists user_content_feedback_daily_content_date_idx
    on public.user_content_feedback_daily (content_id, signal_date desc);

drop trigger if exists user_content_feedback_daily_set_updated_at on public.user_content_feedback_daily;

create trigger user_content_feedback_daily_set_updated_at
before update on public.user_content_feedback_daily
for each row
execute function public.set_current_timestamp_updated_at();

create table if not exists public.user_source_signals_daily (
    user_id uuid not null references auth.users (id) on delete cascade,
    source_id uuid not null references public.content_sources (id) on delete cascade,
    signal_date date not null,
    impression_count integer not null default 0,
    open_count integer not null default 0,
    dismiss_count integer not null default 0,
    subscribe_count integer not null default 0,
    unsubscribe_count integer not null default 0,
    total_visible_ms bigint not null default 0,
    last_interacted_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    primary key (user_id, source_id, signal_date),
    constraint user_source_signals_daily_counts_nonnegative check (
        impression_count >= 0
        and open_count >= 0
        and dismiss_count >= 0
        and subscribe_count >= 0
        and unsubscribe_count >= 0
        and total_visible_ms >= 0
    )
);

create index if not exists user_source_signals_daily_user_date_idx
    on public.user_source_signals_daily (user_id, signal_date desc, source_id);

create index if not exists user_source_signals_daily_source_date_idx
    on public.user_source_signals_daily (source_id, signal_date desc);

drop trigger if exists user_source_signals_daily_set_updated_at on public.user_source_signals_daily;

create trigger user_source_signals_daily_set_updated_at
before update on public.user_source_signals_daily
for each row
execute function public.set_current_timestamp_updated_at();

create table if not exists public.dirty_recommendation_users (
    user_id uuid primary key references auth.users (id) on delete cascade,
    first_marked_at timestamptz not null default timezone('utc', now()),
    last_marked_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.dirty_recommendation_content (
    content_id uuid primary key references public.content (id) on delete cascade,
    first_marked_at timestamptz not null default timezone('utc', now()),
    last_marked_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.dirty_recommendation_sources (
    source_id uuid primary key references public.content_sources (id) on delete cascade,
    first_marked_at timestamptz not null default timezone('utc', now()),
    last_marked_at timestamptz not null default timezone('utc', now())
);

alter table public.recommendation_rollup_state enable row level security;
alter table public.user_content_feedback_daily enable row level security;
alter table public.user_source_signals_daily enable row level security;
alter table public.dirty_recommendation_users enable row level security;
alter table public.dirty_recommendation_content enable row level security;
alter table public.dirty_recommendation_sources enable row level security;

create or replace function public.mark_recommendation_targets_dirty(
    p_user_id uuid default null,
    p_content_id uuid default null,
    p_source_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    derived_source_id uuid := p_source_id;
begin
    if derived_source_id is null and p_content_id is not null then
        select source_id
        into derived_source_id
        from public.content
        where id = p_content_id;
    end if;

    if p_user_id is not null then
        insert into public.dirty_recommendation_users (user_id)
        values (p_user_id)
        on conflict (user_id) do update
        set last_marked_at = timezone('utc', now());
    end if;

    if p_content_id is not null then
        insert into public.dirty_recommendation_content (content_id)
        values (p_content_id)
        on conflict (content_id) do update
        set last_marked_at = timezone('utc', now());
    end if;

    if derived_source_id is not null then
        insert into public.dirty_recommendation_sources (source_id)
        values (derived_source_id)
        on conflict (source_id) do update
        set last_marked_at = timezone('utc', now());
    end if;
end;
$$;

create or replace function public.rollup_interaction_events(
    p_limit integer default 50000
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_last_event_id bigint;
    v_max_event_id bigint;
    v_processed_count integer := 0;
begin
    insert into public.recommendation_rollup_state (name, last_event_id)
    values ('interaction_events', 0)
    on conflict (name) do nothing;

    select last_event_id
    into v_last_event_id
    from public.recommendation_rollup_state
    where name = 'interaction_events'
    for update;

    select max(id), count(*)::integer
    into v_max_event_id, v_processed_count
    from (
        select id
        from public.interaction_events
        where id > v_last_event_id
        order by id asc
        limit greatest(p_limit, 1)
    ) pending;

    if v_max_event_id is null then
        return 0;
    end if;

    with new_events as (
        select
            e.user_id,
            e.content_id,
            coalesce(e.source_id, c.source_id) as source_id,
            timezone('utc', e.occurred_at)::date as signal_date,
            count(*) filter (where e.event_type = 'impression')::integer as impression_count,
            count(*) filter (where e.event_type = 'open')::integer as open_count,
            count(*) filter (where e.event_type = 'heartbeat')::integer as heartbeat_count,
            count(*) filter (where e.event_type = 'dismiss')::integer as dismiss_count,
            count(*) filter (where e.event_type = 'save')::integer as save_count,
            count(*) filter (where e.event_type = 'favorite')::integer as favorite_count,
            count(*) filter (where e.event_type = 'mark_read')::integer as mark_read_count,
            coalesce(sum(e.visible_ms_delta), 0)::bigint as total_visible_ms,
            max(e.occurred_at) as last_interacted_at
        from public.interaction_events e
        left join public.content c on c.id = e.content_id
        where e.id > v_last_event_id
          and e.id <= v_max_event_id
          and e.content_id is not null
        group by
            e.user_id,
            e.content_id,
            coalesce(e.source_id, c.source_id),
            timezone('utc', e.occurred_at)::date
    )
    insert into public.user_content_feedback_daily (
        user_id,
        content_id,
        signal_date,
        source_id,
        impression_count,
        open_count,
        heartbeat_count,
        dismiss_count,
        save_count,
        favorite_count,
        mark_read_count,
        total_visible_ms,
        last_interacted_at
    )
    select
        user_id,
        content_id,
        signal_date,
        source_id,
        impression_count,
        open_count,
        heartbeat_count,
        dismiss_count,
        save_count,
        favorite_count,
        mark_read_count,
        total_visible_ms,
        last_interacted_at
    from new_events
    on conflict (user_id, content_id, signal_date) do update
    set source_id = coalesce(excluded.source_id, public.user_content_feedback_daily.source_id),
        impression_count = public.user_content_feedback_daily.impression_count + excluded.impression_count,
        open_count = public.user_content_feedback_daily.open_count + excluded.open_count,
        heartbeat_count = public.user_content_feedback_daily.heartbeat_count + excluded.heartbeat_count,
        dismiss_count = public.user_content_feedback_daily.dismiss_count + excluded.dismiss_count,
        save_count = public.user_content_feedback_daily.save_count + excluded.save_count,
        favorite_count = public.user_content_feedback_daily.favorite_count + excluded.favorite_count,
        mark_read_count = public.user_content_feedback_daily.mark_read_count + excluded.mark_read_count,
        total_visible_ms = public.user_content_feedback_daily.total_visible_ms + excluded.total_visible_ms,
        last_interacted_at = case
            when public.user_content_feedback_daily.last_interacted_at is null then excluded.last_interacted_at
            when excluded.last_interacted_at is null then public.user_content_feedback_daily.last_interacted_at
            else greatest(public.user_content_feedback_daily.last_interacted_at, excluded.last_interacted_at)
        end;

    with new_events as (
        select
            e.user_id,
            e.source_id,
            timezone('utc', e.occurred_at)::date as signal_date,
            count(*) filter (where e.event_type = 'impression')::integer as impression_count,
            count(*) filter (where e.event_type = 'open')::integer as open_count,
            count(*) filter (where e.event_type = 'dismiss')::integer as dismiss_count,
            count(*) filter (where e.event_type = 'subscribe')::integer as subscribe_count,
            count(*) filter (where e.event_type = 'unsubscribe')::integer as unsubscribe_count,
            coalesce(sum(e.visible_ms_delta), 0)::bigint as total_visible_ms,
            max(e.occurred_at) as last_interacted_at
        from public.interaction_events e
        where e.id > v_last_event_id
          and e.id <= v_max_event_id
          and e.source_id is not null
          and e.content_id is null
        group by
            e.user_id,
            e.source_id,
            timezone('utc', e.occurred_at)::date
    )
    insert into public.user_source_signals_daily (
        user_id,
        source_id,
        signal_date,
        impression_count,
        open_count,
        dismiss_count,
        subscribe_count,
        unsubscribe_count,
        total_visible_ms,
        last_interacted_at
    )
    select
        user_id,
        source_id,
        signal_date,
        impression_count,
        open_count,
        dismiss_count,
        subscribe_count,
        unsubscribe_count,
        total_visible_ms,
        last_interacted_at
    from new_events
    on conflict (user_id, source_id, signal_date) do update
    set impression_count = public.user_source_signals_daily.impression_count + excluded.impression_count,
        open_count = public.user_source_signals_daily.open_count + excluded.open_count,
        dismiss_count = public.user_source_signals_daily.dismiss_count + excluded.dismiss_count,
        subscribe_count = public.user_source_signals_daily.subscribe_count + excluded.subscribe_count,
        unsubscribe_count = public.user_source_signals_daily.unsubscribe_count + excluded.unsubscribe_count,
        total_visible_ms = public.user_source_signals_daily.total_visible_ms + excluded.total_visible_ms,
        last_interacted_at = case
            when public.user_source_signals_daily.last_interacted_at is null then excluded.last_interacted_at
            when excluded.last_interacted_at is null then public.user_source_signals_daily.last_interacted_at
            else greatest(public.user_source_signals_daily.last_interacted_at, excluded.last_interacted_at)
        end;

    with new_events as (
        select
            e.content_id,
            timezone('utc', e.occurred_at)::date as halo_date,
            count(*) filter (
                where e.event_type in ('open', 'heartbeat', 'save', 'mark_read', 'dismiss')
            )::integer as signals_count,
            count(*) filter (where e.event_type = 'impression')::integer as impression_count,
            count(*) filter (where e.event_type = 'open')::integer as open_count,
            count(*) filter (where e.event_type = 'dismiss')::integer as dismiss_count,
            count(*) filter (where e.event_type = 'save')::integer as save_count,
            count(*) filter (where e.event_type = 'mark_read')::integer as mark_read_count,
            coalesce(sum(e.visible_ms_delta), 0)::bigint as total_visible_ms
        from public.interaction_events e
        where e.id > v_last_event_id
          and e.id <= v_max_event_id
          and e.content_id is not null
        group by e.content_id, timezone('utc', e.occurred_at)::date
    )
    insert into public.content_halo_daily (
        content_id,
        halo_date,
        score,
        signals_count,
        impression_count,
        open_count,
        dismiss_count,
        save_count,
        mark_read_count,
        total_visible_ms,
        computed_at
    )
    select
        content_id,
        halo_date,
        0.0,
        signals_count,
        impression_count,
        open_count,
        dismiss_count,
        save_count,
        mark_read_count,
        total_visible_ms,
        timezone('utc', now())
    from new_events
    on conflict (content_id, halo_date) do update
    set signals_count = public.content_halo_daily.signals_count + excluded.signals_count,
        impression_count = public.content_halo_daily.impression_count + excluded.impression_count,
        open_count = public.content_halo_daily.open_count + excluded.open_count,
        dismiss_count = public.content_halo_daily.dismiss_count + excluded.dismiss_count,
        save_count = public.content_halo_daily.save_count + excluded.save_count,
        mark_read_count = public.content_halo_daily.mark_read_count + excluded.mark_read_count,
        total_visible_ms = public.content_halo_daily.total_visible_ms + excluded.total_visible_ms,
        computed_at = timezone('utc', now());

    with new_events as (
        select
            coalesce(e.source_id, c.source_id) as source_id,
            timezone('utc', e.occurred_at)::date as halo_date,
            count(*) filter (
                where e.event_type in (
                    'open',
                    'heartbeat',
                    'save',
                    'mark_read',
                    'dismiss',
                    'subscribe',
                    'unsubscribe'
                )
            )::integer as signals_count,
            count(*) filter (where e.event_type = 'open')::integer as open_count,
            count(*) filter (where e.event_type = 'dismiss')::integer as dismiss_count,
            count(*) filter (where e.event_type = 'save')::integer as save_count,
            count(*) filter (where e.event_type = 'mark_read')::integer as mark_read_count,
            count(*) filter (where e.event_type = 'subscribe')::integer as subscribe_count,
            count(*) filter (where e.event_type = 'unsubscribe')::integer as unsubscribe_count,
            coalesce(sum(e.visible_ms_delta), 0)::bigint as total_visible_ms
        from public.interaction_events e
        left join public.content c on c.id = e.content_id
        where e.id > v_last_event_id
          and e.id <= v_max_event_id
          and coalesce(e.source_id, c.source_id) is not null
        group by
            coalesce(e.source_id, c.source_id),
            timezone('utc', e.occurred_at)::date
    )
    insert into public.source_halo_daily (
        source_id,
        halo_date,
        score,
        signals_count,
        open_count,
        dismiss_count,
        save_count,
        mark_read_count,
        subscribe_count,
        unsubscribe_count,
        total_visible_ms,
        computed_at
    )
    select
        source_id,
        halo_date,
        0.0,
        signals_count,
        open_count,
        dismiss_count,
        save_count,
        mark_read_count,
        subscribe_count,
        unsubscribe_count,
        total_visible_ms,
        timezone('utc', now())
    from new_events
    on conflict (source_id, halo_date) do update
    set signals_count = public.source_halo_daily.signals_count + excluded.signals_count,
        open_count = public.source_halo_daily.open_count + excluded.open_count,
        dismiss_count = public.source_halo_daily.dismiss_count + excluded.dismiss_count,
        save_count = public.source_halo_daily.save_count + excluded.save_count,
        mark_read_count = public.source_halo_daily.mark_read_count + excluded.mark_read_count,
        subscribe_count = public.source_halo_daily.subscribe_count + excluded.subscribe_count,
        unsubscribe_count = public.source_halo_daily.unsubscribe_count + excluded.unsubscribe_count,
        total_visible_ms = public.source_halo_daily.total_visible_ms + excluded.total_visible_ms,
        computed_at = timezone('utc', now());

    with distinct_users as (
        select distinct e.user_id
        from public.interaction_events e
        where e.id > v_last_event_id
          and e.id <= v_max_event_id
    )
    insert into public.dirty_recommendation_users (user_id)
    select user_id
    from distinct_users
    on conflict (user_id) do update
    set last_marked_at = timezone('utc', now());

    with distinct_content as (
        select distinct e.content_id
        from public.interaction_events e
        where e.id > v_last_event_id
          and e.id <= v_max_event_id
          and e.content_id is not null
    )
    insert into public.dirty_recommendation_content (content_id)
    select content_id
    from distinct_content
    on conflict (content_id) do update
    set last_marked_at = timezone('utc', now());

    with distinct_sources as (
        select distinct coalesce(e.source_id, c.source_id) as source_id
        from public.interaction_events e
        left join public.content c on c.id = e.content_id
        where e.id > v_last_event_id
          and e.id <= v_max_event_id
          and coalesce(e.source_id, c.source_id) is not null
    )
    insert into public.dirty_recommendation_sources (source_id)
    select source_id
    from distinct_sources
    on conflict (source_id) do update
    set last_marked_at = timezone('utc', now());

    update public.recommendation_rollup_state
    set last_event_id = v_max_event_id
    where name = 'interaction_events';

    return v_processed_count;
end;
$$;

create or replace function public.rebuild_user_content_feedback(
    p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    delete from public.user_content_feedback
    where user_id = p_user_id;

    insert into public.user_content_feedback (
        user_id,
        content_id,
        source_id,
        impression_count,
        open_count,
        heartbeat_count,
        dismiss_count,
        save_count,
        favorite_count,
        mark_read_count,
        total_visible_ms,
        last_interacted_at,
        read_ratio,
        score
    )
    select
        p_user_id,
        d.content_id,
        coalesce(max(d.source_id), c.source_id),
        sum(d.impression_count)::integer,
        sum(d.open_count)::integer,
        sum(d.heartbeat_count)::integer,
        sum(d.dismiss_count)::integer,
        sum(d.save_count)::integer,
        sum(d.favorite_count)::integer,
        sum(d.mark_read_count)::integer,
        sum(d.total_visible_ms)::bigint,
        max(d.last_interacted_at),
        least(
            sum(d.total_visible_ms)::double precision
                / greatest(coalesce(max(c.estimated_read_seconds), 1) * 1000, 1000),
            1.5
        ),
        least(
            greatest(
                (least(sum(d.open_count)::double precision, 1.0) * 0.20)
                + (
                    least(
                        sum(d.total_visible_ms)::double precision
                            / greatest(coalesce(max(c.estimated_read_seconds), 1) * 1000, 1000),
                        1.5
                    ) * 0.60
                )
                + (least(sum(d.save_count)::double precision, 1.0) * 0.40)
                + (least(sum(d.favorite_count)::double precision, 1.0) * 0.30)
                + (least(sum(d.mark_read_count)::double precision, 1.0) * 0.40)
                - (least(sum(d.dismiss_count)::double precision, 1.0) * 0.50),
                -1.0
            ),
            2.0
        )
    from public.user_content_feedback_daily d
    left join public.content c on c.id = d.content_id
    where d.user_id = p_user_id
      and d.signal_date >= current_date - 90
    group by d.content_id, c.source_id
    having
        sum(d.impression_count)
        + sum(d.open_count)
        + sum(d.heartbeat_count)
        + sum(d.dismiss_count)
        + sum(d.save_count)
        + sum(d.favorite_count)
        + sum(d.mark_read_count) > 0;
end;
$$;

create or replace function public.rebuild_user_source_affinity(
    p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    delete from public.user_source_affinity
    where user_id = p_user_id;

    insert into public.user_source_affinity (
        user_id,
        source_id,
        score,
        signals,
        last_interacted_at
    )
    with content_feedback as (
        select
            p_user_id as user_id,
            coalesce(ucf.source_id, c.source_id) as source_id,
            sum(
                ucf.score
                * exp(
                    -ln(2.0)
                    * greatest(
                        extract(epoch from (timezone('utc', now()) - ucf.last_interacted_at)) / 86400.0,
                        0
                    )
                    / 30.0
                )
            ) as score,
            count(*)::integer as signals,
            max(ucf.last_interacted_at) as last_interacted_at
        from public.user_content_feedback ucf
        left join public.content c on c.id = ucf.content_id
        where ucf.user_id = p_user_id
          and coalesce(ucf.source_id, c.source_id) is not null
          and ucf.last_interacted_at is not null
        group by coalesce(ucf.source_id, c.source_id)
    ),
    source_events as (
        select
            p_user_id as user_id,
            usd.source_id,
            sum(
                (
                    case
                        when usd.subscribe_count > 0 then 0.90 * usd.subscribe_count
                        else 0.0
                    end
                    + case
                        when usd.unsubscribe_count > 0 then -0.90 * usd.unsubscribe_count
                        else 0.0
                    end
                    + case
                        when usd.dismiss_count > 0 then -0.60 * usd.dismiss_count
                        else 0.0
                    end
                    + (usd.open_count * 0.15)
                    + (usd.impression_count * 0.05)
                )
                * exp(
                    -ln(2.0)
                    * greatest(
                        extract(epoch from (timezone('utc', now()) - coalesce(usd.last_interacted_at, timezone('utc', now())))) / 86400.0,
                        0
                    )
                    / 30.0
                )
            ) as score,
            sum(
                usd.impression_count
                + usd.open_count
                + usd.dismiss_count
                + usd.subscribe_count
                + usd.unsubscribe_count
            )::integer as signals,
            max(usd.last_interacted_at) as last_interacted_at
        from public.user_source_signals_daily usd
        where usd.user_id = p_user_id
          and usd.signal_date >= current_date - 90
        group by usd.source_id
    ),
    subscription_boosts as (
        select
            ss.user_id,
            ss.source_id,
            0.25::double precision as score,
            1::integer as signals,
            timezone('utc', now()) as last_interacted_at
        from public.source_subscriptions ss
        where ss.user_id = p_user_id
    ),
    combined as (
        select * from content_feedback
        union all
        select * from source_events
        union all
        select * from subscription_boosts
    )
    select
        p_user_id,
        source_id,
        sum(score),
        sum(signals),
        max(last_interacted_at)
    from combined
    where source_id is not null
    group by source_id;
end;
$$;

create or replace function public.rebuild_user_topic_affinity(
    p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    delete from public.user_topic_affinity
    where user_id = p_user_id;

    insert into public.user_topic_affinity (
        user_id,
        topic_id,
        score,
        signals,
        last_interacted_at
    )
    with preference_topics as (
        select
            utp.user_id,
            utp.topic_id,
            utp.weight * 2.0 as score,
            1::integer as signals,
            timezone('utc', now()) as last_interacted_at
        from public.user_topic_preferences utp
        where utp.user_id = p_user_id
    ),
    content_topics as (
        select
            p_user_id as user_id,
            ct.topic_id,
            sum(
                ucf.score
                * ct.confidence
                * exp(
                    -ln(2.0)
                    * greatest(
                        extract(epoch from (timezone('utc', now()) - ucf.last_interacted_at)) / 86400.0,
                        0
                    )
                    / 30.0
                )
            ) as score,
            count(*)::integer as signals,
            max(ucf.last_interacted_at) as last_interacted_at
        from public.user_content_feedback ucf
        join public.content_topics ct on ct.content_id = ucf.content_id
        where ucf.user_id = p_user_id
          and ucf.last_interacted_at is not null
        group by ct.topic_id
    ),
    source_affinity_topics as (
        select
            p_user_id as user_id,
            st.topic_id,
            sum(usa.score * st.confidence) as score,
            count(*)::integer as signals,
            max(usa.last_interacted_at) as last_interacted_at
        from public.user_source_affinity usa
        join public.source_topics st on st.source_id = usa.source_id
        where usa.user_id = p_user_id
        group by st.topic_id
    ),
    combined as (
        select * from preference_topics
        union all
        select * from content_topics
        union all
        select * from source_affinity_topics
    )
    select
        p_user_id,
        topic_id,
        sum(score),
        sum(signals),
        max(last_interacted_at)
    from combined
    group by topic_id;
end;
$$;

create or replace function public.recompute_content_halo_scores(
    p_content_id uuid
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
    update public.content_halo_daily chd
    set score = least(
            (
                (
                    greatest(
                        (
                            least(chd.open_count::double precision, 10.0) / 10.0 * 0.15
                        )
                        + (
                            least(
                                chd.total_visible_ms::double precision
                                    / greatest(coalesce(c.estimated_read_seconds, 1) * 1000, 1000),
                                1.5
                            ) / 1.5 * 0.35
                        )
                        + (
                            least(chd.save_count::double precision, 10.0) / 10.0 * 0.25
                        )
                        + (
                            least(chd.mark_read_count::double precision, 10.0) / 10.0 * 0.20
                        )
                        - (
                            least(chd.dismiss_count::double precision, 10.0) / 10.0 * 0.20
                        ),
                        0.0
                    )
                    * chd.signals_count
                )
                + (0.35 * 5.0)
            )
            / greatest(chd.signals_count + 5, 1),
            1.0
        ),
        computed_at = timezone('utc', now())
    from public.content c
    where chd.content_id = p_content_id
      and c.id = chd.content_id;
$$;

create or replace function public.recompute_source_halo_scores(
    p_source_id uuid
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
    update public.source_halo_daily shd
    set score = least(
            (
                (
                    greatest(
                        (
                            least(shd.open_count::double precision, 20.0) / 20.0 * 0.15
                        )
                        + (
                            least(shd.total_visible_ms::double precision, 600000.0) / 600000.0 * 0.25
                        )
                        + (
                            least(shd.save_count::double precision, 20.0) / 20.0 * 0.20
                        )
                        + (
                            least(shd.mark_read_count::double precision, 20.0) / 20.0 * 0.15
                        )
                        + (
                            least(shd.subscribe_count::double precision, 10.0) / 10.0 * 0.25
                        )
                        - (
                            least(shd.dismiss_count::double precision, 20.0) / 20.0 * 0.15
                        )
                        - (
                            least(shd.unsubscribe_count::double precision, 10.0) / 10.0 * 0.20
                        ),
                        0.0
                    )
                    * shd.signals_count
                )
                + (0.35 * 5.0)
            )
            / greatest(shd.signals_count + 5, 1),
            1.0
        ),
        computed_at = timezone('utc', now())
    where shd.source_id = p_source_id;
$$;

create or replace function public.refresh_recommendation_targets(
    p_user_id uuid default null,
    p_content_id uuid default null,
    p_source_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    derived_source_id uuid := p_source_id;
begin
    if derived_source_id is null and p_content_id is not null then
        select source_id
        into derived_source_id
        from public.content
        where id = p_content_id;
    end if;

    if p_user_id is not null then
        perform public.rebuild_user_content_feedback(p_user_id);
        perform public.rebuild_user_source_affinity(p_user_id);
        perform public.rebuild_user_topic_affinity(p_user_id);
        delete from public.dirty_recommendation_users
        where user_id = p_user_id;
    end if;

    if p_content_id is not null then
        perform public.recompute_content_halo_scores(p_content_id);
        delete from public.dirty_recommendation_content
        where content_id = p_content_id;
    end if;

    if derived_source_id is not null then
        perform public.recompute_source_halo_scores(derived_source_id);
        delete from public.dirty_recommendation_sources
        where source_id = derived_source_id;
    end if;
end;
$$;

create or replace function public.refresh_dirty_recommendation_aggregates(
    p_user_limit integer default 5000,
    p_content_limit integer default 5000,
    p_source_limit integer default 5000
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid;
    v_content_id uuid;
    v_source_id uuid;
    v_user_count integer := 0;
    v_content_count integer := 0;
    v_source_count integer := 0;
begin
    for v_user_id in
        select user_id
        from public.dirty_recommendation_users
        order by first_marked_at asc
        limit greatest(p_user_limit, 0)
    loop
        perform public.refresh_recommendation_targets(v_user_id, null, null);
        v_user_count := v_user_count + 1;
    end loop;

    for v_content_id in
        select content_id
        from public.dirty_recommendation_content
        order by first_marked_at asc
        limit greatest(p_content_limit, 0)
    loop
        perform public.refresh_recommendation_targets(null, v_content_id, null);
        v_content_count := v_content_count + 1;
    end loop;

    for v_source_id in
        select source_id
        from public.dirty_recommendation_sources
        order by first_marked_at asc
        limit greatest(p_source_limit, 0)
    loop
        perform public.refresh_recommendation_targets(null, null, v_source_id);
        v_source_count := v_source_count + 1;
    end loop;

    return jsonb_build_object(
        'users', v_user_count,
        'content', v_content_count,
        'sources', v_source_count
    );
end;
$$;

create or replace function public.get_user_recommendation_context(
    p_user_id uuid
)
returns table (
    preferred_languages text[],
    subscribed_source_ids uuid[],
    top_topic_ids uuid[],
    top_source_ids uuid[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select
        coalesce(
            (
                select urs.preferred_languages
                from public.user_recommendation_settings urs
                where urs.user_id = p_user_id
            ),
            '{}'::text[]
        ) as preferred_languages,
        coalesce(
            array(
                select ss.source_id
                from public.source_subscriptions ss
                where ss.user_id = p_user_id
                order by ss.source_id
            ),
            '{}'::uuid[]
        ) as subscribed_source_ids,
        coalesce(
            array(
                select uta.topic_id
                from public.user_topic_affinity uta
                where uta.user_id = p_user_id
                  and uta.score > 0
                order by uta.score desc, uta.topic_id asc
                limit 10
            ),
            '{}'::uuid[]
        ) as top_topic_ids,
        coalesce(
            array(
                select usa.source_id
                from public.user_source_affinity usa
                where usa.user_id = p_user_id
                  and usa.score > 0
                order by usa.score desc, usa.source_id asc
                limit 10
            ),
            '{}'::uuid[]
        ) as top_source_ids;
$$;

create or replace function public.get_content_recommendation_candidates(
    p_user_id uuid
)
returns table (
    content_id uuid,
    source_id uuid,
    subscribed_inbox boolean,
    discovery boolean,
    saved_adjacent boolean,
    trending boolean,
    canonical_url text,
    resolved_url text,
    host text,
    site_name text,
    source_kind text,
    title text,
    excerpt text,
    author text,
    published_at timestamptz,
    language_code text,
    has_favicon boolean,
    fetch_status text,
    parse_status text,
    parsed_at timestamptz,
    created_at timestamptz,
    source_url text,
    resolved_source_url text,
    source_host text,
    source_title text,
    source_kind_label text,
    primary_feed_url text,
    topic_score double precision,
    primary_topic_slug text,
    source_affinity_score double precision,
    content_halo_score double precision,
    source_halo_score double precision,
    dismiss_count integer,
    mark_read_count integer,
    read_ratio double precision
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with ctx as (
        select *
        from public.get_user_recommendation_context(p_user_id)
    ),
    subscribed_bucket as (
        select
            i.content_id,
            true as subscribed_inbox,
            false as discovery,
            false as saved_adjacent,
            false as trending
        from public.subscription_inbox i
        join public.content c on c.id = i.content_id
        where i.user_id = p_user_id
          and i.dismissed_at is null
          and c.parse_status = 'succeeded'
          and c.parsed_document is not null
          and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '30 days'
          and not exists (
              select 1
              from public.saved_content sc
              where sc.user_id = p_user_id
                and sc.content_id = i.content_id
                and sc.archived_at is null
          )
          and not exists (
              select 1
              from public.user_content_feedback ucf
              where ucf.user_id = p_user_id
                and ucf.content_id = i.content_id
                and ucf.dismiss_count > 0
          )
        order by i.delivered_at desc, i.id desc
        limit 200
    ),
    discovery_bucket as (
        select
            c.id as content_id,
            false as subscribed_inbox,
            true as discovery,
            false as saved_adjacent,
            false as trending
        from public.content c
        cross join ctx
        where c.parse_status = 'succeeded'
          and c.parsed_document is not null
          and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '30 days'
          and not exists (
              select 1
              from public.source_subscriptions ss
              where ss.user_id = p_user_id
                and ss.source_id = c.source_id
          )
          and not exists (
              select 1
              from public.saved_content sc
              where sc.user_id = p_user_id
                and sc.content_id = c.id
                and sc.archived_at is null
          )
          and not exists (
              select 1
              from public.user_content_feedback ucf
              where ucf.user_id = p_user_id
                and ucf.content_id = c.id
                and ucf.dismiss_count > 0
          )
          and (
              cardinality(ctx.preferred_languages) = 0
              or c.language_code is null
              or c.language_code = any(ctx.preferred_languages)
          )
        order by coalesce(c.published_at, c.created_at) desc, c.id desc
        limit 200
    ),
    saved_adjacent_bucket as (
        select
            c.id as content_id,
            false as subscribed_inbox,
            false as discovery,
            true as saved_adjacent,
            false as trending
        from public.content c
        cross join ctx
        where c.parse_status = 'succeeded'
          and c.parsed_document is not null
          and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '60 days'
          and (
              (
                  cardinality(ctx.top_topic_ids) > 0
                  and (
                      exists (
                          select 1
                          from public.content_topics ct
                          where ct.content_id = c.id
                            and ct.topic_id = any(ctx.top_topic_ids)
                      )
                      or exists (
                          select 1
                          from public.source_topics st
                          where st.source_id = c.source_id
                            and st.topic_id = any(ctx.top_topic_ids)
                      )
                  )
              )
              or (
                  cardinality(ctx.top_source_ids) > 0
                  and c.source_id = any(ctx.top_source_ids)
              )
          )
          and not exists (
              select 1
              from public.saved_content sc
              where sc.user_id = p_user_id
                and sc.content_id = c.id
                and sc.archived_at is null
          )
          and not exists (
              select 1
              from public.user_content_feedback ucf
              where ucf.user_id = p_user_id
                and ucf.content_id = c.id
                and ucf.dismiss_count > 0
          )
        order by coalesce(c.published_at, c.created_at) desc, c.id desc
        limit 200
    ),
    trending_bucket as (
        with halo as (
            select
                content_id,
                avg(score) as average_score
            from public.content_halo_daily
            where halo_date >= current_date - 14
            group by content_id
        )
        select
            c.id as content_id,
            false as subscribed_inbox,
            false as discovery,
            false as saved_adjacent,
            true as trending
        from halo
        join public.content c on c.id = halo.content_id
        cross join ctx
        where c.parse_status = 'succeeded'
          and c.parsed_document is not null
          and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '14 days'
          and not exists (
              select 1
              from public.saved_content sc
              where sc.user_id = p_user_id
                and sc.content_id = c.id
                and sc.archived_at is null
          )
          and not exists (
              select 1
              from public.user_content_feedback ucf
              where ucf.user_id = p_user_id
                and ucf.content_id = c.id
                and ucf.dismiss_count > 0
          )
          and (
              cardinality(ctx.preferred_languages) = 0
              or c.language_code is null
              or c.language_code = any(ctx.preferred_languages)
          )
        order by halo.average_score desc, coalesce(c.published_at, c.created_at) desc, c.id desc
        limit 200
    ),
    all_candidates as (
        select
            content_id,
            bool_or(subscribed_inbox) as subscribed_inbox,
            bool_or(discovery) as discovery,
            bool_or(saved_adjacent) as saved_adjacent,
            bool_or(trending) as trending
        from (
            select * from subscribed_bucket
            union all
            select * from discovery_bucket
            union all
            select * from saved_adjacent_bucket
            union all
            select * from trending_bucket
        ) buckets
        group by content_id
    ),
    topic_matches as (
        select
            ct.content_id,
            t.slug,
            greatest(uta.score, 0) * ct.confidence as weighted_score
        from all_candidates ac
        join public.content_topics ct on ct.content_id = ac.content_id
        join public.user_topic_affinity uta
          on uta.topic_id = ct.topic_id
         and uta.user_id = p_user_id
        join public.topics t on t.id = ct.topic_id

        union all

        select
            c.id as content_id,
            t.slug,
            greatest(uta.score, 0) * st.confidence * 0.75 as weighted_score
        from all_candidates ac
        join public.content c on c.id = ac.content_id
        join public.source_topics st on st.source_id = c.source_id
        join public.user_topic_affinity uta
          on uta.topic_id = st.topic_id
         and uta.user_id = p_user_id
        join public.topics t on t.id = st.topic_id
    ),
    topic_scores as (
        select
            content_id,
            max(weighted_score) as topic_score,
            (array_agg(slug order by weighted_score desc, slug asc))[1] as primary_topic_slug
        from topic_matches
        group by content_id
    ),
    content_halo as (
        select
            chd.content_id,
            avg(chd.score) as content_halo_score
        from public.content_halo_daily chd
        join all_candidates ac on ac.content_id = chd.content_id
        where chd.halo_date >= current_date - 30
        group by chd.content_id
    ),
    source_halo as (
        select
            c.source_id,
            avg(shd.score) as source_halo_score
        from all_candidates ac
        join public.content c on c.id = ac.content_id
        join public.source_halo_daily shd on shd.source_id = c.source_id
        where c.source_id is not null
          and shd.halo_date >= current_date - 30
        group by c.source_id
    )
    select
        c.id as content_id,
        c.source_id,
        ac.subscribed_inbox,
        ac.discovery,
        ac.saved_adjacent,
        ac.trending,
        c.canonical_url,
        c.resolved_url,
        c.host,
        c.site_name,
        c.source_kind,
        c.title,
        c.excerpt,
        c.author,
        c.published_at,
        c.language_code,
        (c.favicon_bytes is not null and c.favicon_mime_type is not null) as has_favicon,
        c.fetch_status,
        c.parse_status,
        c.parsed_at,
        c.created_at,
        cs.source_url,
        cs.resolved_source_url,
        cs.host as source_host,
        cs.title as source_title,
        cs.source_kind as source_kind_label,
        sf.feed_url as primary_feed_url,
        coalesce(ts.topic_score, 0.0) as topic_score,
        ts.primary_topic_slug,
        coalesce(usa.score, 0.0) as source_affinity_score,
        coalesce(ch.content_halo_score, 0.0) as content_halo_score,
        coalesce(sh.source_halo_score, 0.0) as source_halo_score,
        coalesce(ucf.dismiss_count, 0) as dismiss_count,
        coalesce(ucf.mark_read_count, 0) as mark_read_count,
        coalesce(ucf.read_ratio, 0.0) as read_ratio
    from all_candidates ac
    join public.content c on c.id = ac.content_id
    left join public.content_sources cs on cs.id = c.source_id
    left join public.source_feeds sf on sf.id = cs.primary_feed_id
    left join topic_scores ts on ts.content_id = c.id
    left join public.user_source_affinity usa
      on usa.user_id = p_user_id
     and usa.source_id = c.source_id
    left join content_halo ch on ch.content_id = c.id
    left join source_halo sh on sh.source_id = c.source_id
    left join public.user_content_feedback ucf
      on ucf.user_id = p_user_id
     and ucf.content_id = c.id
    order by
        ac.subscribed_inbox desc,
        ac.saved_adjacent desc,
        ac.discovery desc,
        ac.trending desc,
        coalesce(c.published_at, c.created_at) desc,
        c.id desc;
$$;

create or replace function public.get_source_recommendation_candidates(
    p_user_id uuid
)
returns table (
    source_id uuid,
    source_url text,
    resolved_source_url text,
    source_host text,
    source_title text,
    source_description text,
    source_kind text,
    refresh_status text,
    last_refreshed_at timestamptz,
    primary_feed_url text,
    topic_score double precision,
    primary_topic_slug text,
    source_halo_score double precision,
    recent_activity_count bigint,
    similarity_score double precision
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with ctx as (
        select *
        from public.get_user_recommendation_context(p_user_id)
    ),
    topic_sources as (
        select distinct st.source_id
        from public.source_topics st
        cross join ctx
        where cardinality(ctx.top_topic_ids) > 0
          and st.topic_id = any(ctx.top_topic_ids)
        limit 200
    ),
    recent_sources as (
        select c.source_id
        from public.content c
        cross join ctx
        where c.source_id is not null
          and c.parse_status = 'succeeded'
          and c.parsed_document is not null
          and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '30 days'
          and not exists (
              select 1
              from public.source_subscriptions ss
              where ss.user_id = p_user_id
                and ss.source_id = c.source_id
          )
          and (
              cardinality(ctx.preferred_languages) = 0
              or c.language_code is null
              or c.language_code = any(ctx.preferred_languages)
          )
        group by c.source_id
        order by max(coalesce(c.published_at, c.created_at)) desc, c.source_id asc
        limit 200
    ),
    similar_sources as (
        with engaged_topics as (
            select distinct st.topic_id
            from public.user_source_affinity usa
            join public.source_topics st on st.source_id = usa.source_id
            where usa.user_id = p_user_id
              and usa.score > 0
        )
        select distinct st.source_id
        from public.source_topics st
        join engaged_topics et on et.topic_id = st.topic_id
        cross join ctx
        where st.source_id <> all(ctx.top_source_ids)
        limit 200
    ),
    candidate_sources as (
        select source_id
        from topic_sources
        union
        select source_id
        from recent_sources
        union
        select source_id
        from similar_sources
    ),
    filtered_sources as (
        select cs.source_id
        from candidate_sources cs
        where not exists (
            select 1
            from public.source_subscriptions ss
            where ss.user_id = p_user_id
              and ss.source_id = cs.source_id
        )
    ),
    topic_scores as (
        select
            st.source_id,
            max(greatest(uta.score, 0) * st.confidence) as topic_score,
            (array_agg(t.slug order by greatest(uta.score, 0) * st.confidence desc, t.slug asc))[1] as primary_topic_slug
        from public.source_topics st
        join public.user_topic_affinity uta
          on uta.topic_id = st.topic_id
         and uta.user_id = p_user_id
        join public.topics t on t.id = st.topic_id
        where st.source_id in (select source_id from filtered_sources)
        group by st.source_id
    ),
    source_halo as (
        select
            shd.source_id,
            avg(shd.score) as source_halo_score
        from public.source_halo_daily shd
        where shd.source_id in (select source_id from filtered_sources)
          and shd.halo_date >= current_date - 30
        group by shd.source_id
    ),
    recent_activity as (
        select
            c.source_id,
            count(*)::bigint as recent_activity_count
        from public.content c
        where c.source_id in (select source_id from filtered_sources)
          and c.parse_status = 'succeeded'
          and c.parsed_document is not null
          and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '30 days'
        group by c.source_id
    ),
    similarity_scores as (
        with engaged_topics as (
            select
                st.topic_id,
                max(greatest(usa.score, 0)) as affinity_score
            from public.user_source_affinity usa
            join public.source_topics st on st.source_id = usa.source_id
            where usa.user_id = p_user_id
              and usa.score > 0
            group by st.topic_id
        )
        select
            st.source_id,
            coalesce(avg(least(et.affinity_score * st.confidence, 2.0)), 0.0) as similarity_score
        from public.source_topics st
        join engaged_topics et on et.topic_id = st.topic_id
        where st.source_id in (select source_id from filtered_sources)
        group by st.source_id
    )
    select
        cs.id as source_id,
        cs.source_url,
        cs.resolved_source_url,
        cs.host as source_host,
        cs.title as source_title,
        cs.description as source_description,
        cs.source_kind,
        cs.refresh_status,
        cs.last_refreshed_at,
        sf.feed_url as primary_feed_url,
        coalesce(ts.topic_score, 0.0) as topic_score,
        ts.primary_topic_slug,
        coalesce(sh.source_halo_score, 0.0) as source_halo_score,
        coalesce(ra.recent_activity_count, 0)::bigint as recent_activity_count,
        coalesce(ssim.similarity_score, 0.0) as similarity_score
    from filtered_sources fs
    join public.content_sources cs on cs.id = fs.source_id
    left join public.source_feeds sf on sf.id = cs.primary_feed_id
    left join topic_scores ts on ts.source_id = cs.id
    left join source_halo sh on sh.source_id = cs.id
    left join recent_activity ra on ra.source_id = cs.id
    left join similarity_scores ssim on ssim.source_id = cs.id
    order by
        coalesce(ts.topic_score, 0.0) desc,
        coalesce(sh.source_halo_score, 0.0) desc,
        coalesce(ra.recent_activity_count, 0) desc,
        cs.id asc;
$$;

do $$
begin
    if exists (
        select 1
        from cron.job
        where jobname = 'process-recommendation-batch-every-minute'
    ) then
        perform cron.unschedule('process-recommendation-batch-every-minute');
    end if;

    if exists (
        select 1
        from cron.job
        where jobname = 'rollup-recommendation-events-hourly'
    ) then
        perform cron.unschedule('rollup-recommendation-events-hourly');
    end if;

    if exists (
        select 1
        from cron.job
        where jobname = 'refresh-dirty-recommendation-aggregates-daily'
    ) then
        perform cron.unschedule('refresh-dirty-recommendation-aggregates-daily');
    end if;

    perform cron.schedule(
        'rollup-recommendation-events-hourly',
        '5 * * * *',
        $job$
        select public.rollup_interaction_events(50000);
        $job$
    );

    perform cron.schedule(
        'refresh-dirty-recommendation-aggregates-daily',
        '15 3 * * *',
        $job$
        select public.refresh_dirty_recommendation_aggregates(5000, 5000, 5000);
        $job$
    );
end;
$$;

drop function if exists public.enqueue_recommendation_refresh(uuid, uuid, uuid, text, integer, integer);
drop function if exists public.dequeue_recommendation_refresh(integer, integer);
drop function if exists public.archive_recommendation_refresh(bigint);
drop function if exists public.refresh_recommendation_state(uuid, uuid, uuid);
drop function if exists public.invoke_recommendation_processor(jsonb);

revoke all on function public.mark_recommendation_targets_dirty(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.rollup_interaction_events(integer) from public, anon, authenticated;
revoke all on function public.rebuild_user_content_feedback(uuid) from public, anon, authenticated;
revoke all on function public.rebuild_user_source_affinity(uuid) from public, anon, authenticated;
revoke all on function public.rebuild_user_topic_affinity(uuid) from public, anon, authenticated;
revoke all on function public.recompute_content_halo_scores(uuid) from public, anon, authenticated;
revoke all on function public.recompute_source_halo_scores(uuid) from public, anon, authenticated;
revoke all on function public.refresh_recommendation_targets(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.refresh_dirty_recommendation_aggregates(integer, integer, integer) from public, anon, authenticated;
revoke all on function public.get_user_recommendation_context(uuid) from public, anon, authenticated;
revoke all on function public.get_content_recommendation_candidates(uuid) from public, anon, authenticated;
revoke all on function public.get_source_recommendation_candidates(uuid) from public, anon, authenticated;

grant execute on function public.mark_recommendation_targets_dirty(uuid, uuid, uuid) to service_role;
grant execute on function public.rollup_interaction_events(integer) to service_role;
grant execute on function public.rebuild_user_content_feedback(uuid) to service_role;
grant execute on function public.rebuild_user_source_affinity(uuid) to service_role;
grant execute on function public.rebuild_user_topic_affinity(uuid) to service_role;
grant execute on function public.recompute_content_halo_scores(uuid) to service_role;
grant execute on function public.recompute_source_halo_scores(uuid) to service_role;
grant execute on function public.refresh_recommendation_targets(uuid, uuid, uuid) to service_role;
grant execute on function public.refresh_dirty_recommendation_aggregates(integer, integer, integer) to service_role;
grant execute on function public.get_user_recommendation_context(uuid) to service_role;
grant execute on function public.get_content_recommendation_candidates(uuid) to service_role;
grant execute on function public.get_source_recommendation_candidates(uuid) to service_role;
