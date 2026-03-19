alter table public.content
    add column word_count integer not null default 0,
    add column estimated_read_seconds integer not null default 0,
    add column block_count integer not null default 0,
    add column image_count integer not null default 0,
    add constraint content_word_count_nonnegative check (word_count >= 0),
    add constraint content_estimated_read_seconds_nonnegative check (estimated_read_seconds >= 0),
    add constraint content_block_count_nonnegative check (block_count >= 0),
    add constraint content_image_count_nonnegative check (image_count >= 0);

create index content_recommendable_recent_idx
    on public.content ((coalesce(published_at, created_at)) desc, source_id)
    where parse_status = 'succeeded' and parsed_document is not null;

create table public.topics (
    id uuid primary key default gen_random_uuid(),
    slug text not null,
    label text not null,
    description text,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint topics_slug_format check (slug ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    constraint topics_label_not_blank check (btrim(label) <> '')
);

create unique index topics_slug_unique_idx
    on public.topics (slug);

create table public.source_topics (
    source_id uuid not null references public.content_sources (id) on delete cascade,
    topic_id uuid not null references public.topics (id) on delete cascade,
    confidence double precision not null default 1.0,
    created_at timestamptz not null default timezone('utc', now()),
    primary key (source_id, topic_id),
    constraint source_topics_confidence_range check (confidence > 0 and confidence <= 1)
);

create index source_topics_topic_source_idx
    on public.source_topics (topic_id, source_id);

create table public.content_topics (
    content_id uuid not null references public.content (id) on delete cascade,
    topic_id uuid not null references public.topics (id) on delete cascade,
    confidence double precision not null default 1.0,
    created_at timestamptz not null default timezone('utc', now()),
    primary key (content_id, topic_id),
    constraint content_topics_confidence_range check (confidence > 0 and confidence <= 1)
);

create index content_topics_topic_content_idx
    on public.content_topics (topic_id, content_id);

create table public.user_recommendation_settings (
    user_id uuid primary key references auth.users (id) on delete cascade,
    preferred_languages text[] not null default '{}',
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint user_recommendation_settings_language_count check (
        cardinality(preferred_languages) <= 8
    )
);

create table public.user_topic_preferences (
    user_id uuid not null references auth.users (id) on delete cascade,
    topic_id uuid not null references public.topics (id) on delete cascade,
    weight double precision not null default 1.0,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    primary key (user_id, topic_id),
    constraint user_topic_preferences_weight_range check (weight > 0 and weight <= 3)
);

create index user_topic_preferences_topic_idx
    on public.user_topic_preferences (topic_id);

create table public.recommendation_serves (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    surface text not null,
    algorithm_version text not null,
    request_context jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default timezone('utc', now()),
    constraint recommendation_serves_surface check (
        surface in ('content', 'sources')
    ),
    constraint recommendation_serves_algorithm_not_blank check (btrim(algorithm_version) <> ''),
    constraint recommendation_serves_request_context_shape check (
        jsonb_typeof(request_context) = 'object'
    )
);

create index recommendation_serves_user_surface_created_idx
    on public.recommendation_serves (user_id, surface, created_at desc);

create table public.interaction_events (
    id bigint generated always as identity primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    entity_type text not null,
    content_id uuid references public.content (id) on delete cascade,
    source_id uuid references public.content_sources (id) on delete cascade,
    event_type text not null,
    surface text,
    session_id uuid,
    serve_id uuid references public.recommendation_serves (id) on delete set null,
    position integer,
    visible_ms_delta integer,
    occurred_at timestamptz not null,
    received_at timestamptz not null default timezone('utc', now()),
    client_event_id uuid,
    metadata jsonb not null default '{}'::jsonb,
    constraint interaction_events_entity_type check (
        entity_type in ('content', 'source')
    ),
    constraint interaction_events_entity_target check (
        (entity_type = 'content' and content_id is not null)
        or (entity_type = 'source' and source_id is not null and content_id is null)
    ),
    constraint interaction_events_event_type check (
        event_type in (
            'impression',
            'open',
            'heartbeat',
            'close',
            'dismiss',
            'save',
            'favorite',
            'mark_read',
            'subscribe',
            'unsubscribe'
        )
    ),
    constraint interaction_events_surface_length check (
        surface is null or char_length(surface) between 1 and 64
    ),
    constraint interaction_events_position_nonnegative check (
        position is null or position >= 0
    ),
    constraint interaction_events_visible_ms_delta_range check (
        visible_ms_delta is null or visible_ms_delta between 0 and 3600000
    ),
    constraint interaction_events_metadata_shape check (
        jsonb_typeof(metadata) = 'object'
    )
);

create unique index interaction_events_user_client_event_unique_idx
    on public.interaction_events (user_id, client_event_id)
    where client_event_id is not null;

create index interaction_events_user_occurred_idx
    on public.interaction_events (user_id, occurred_at desc, id desc);

create index interaction_events_content_occurred_idx
    on public.interaction_events (content_id, occurred_at desc, id desc)
    where content_id is not null;

create index interaction_events_source_occurred_idx
    on public.interaction_events (source_id, occurred_at desc, id desc)
    where source_id is not null;

create index interaction_events_serve_idx
    on public.interaction_events (serve_id, position)
    where serve_id is not null;

create table public.user_content_feedback (
    user_id uuid not null references auth.users (id) on delete cascade,
    content_id uuid not null references public.content (id) on delete cascade,
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
    read_ratio double precision not null default 0,
    score double precision not null default 0,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    primary key (user_id, content_id),
    constraint user_content_feedback_total_visible_ms_nonnegative check (total_visible_ms >= 0),
    constraint user_content_feedback_counts_nonnegative check (
        impression_count >= 0
        and open_count >= 0
        and heartbeat_count >= 0
        and dismiss_count >= 0
        and save_count >= 0
        and favorite_count >= 0
        and mark_read_count >= 0
    ),
    constraint user_content_feedback_read_ratio_range check (
        read_ratio >= 0 and read_ratio <= 1.5
    )
);

create index user_content_feedback_user_score_idx
    on public.user_content_feedback (user_id, score desc, last_interacted_at desc);

create index user_content_feedback_source_idx
    on public.user_content_feedback (source_id)
    where source_id is not null;

create table public.user_topic_affinity (
    user_id uuid not null references auth.users (id) on delete cascade,
    topic_id uuid not null references public.topics (id) on delete cascade,
    score double precision not null default 0,
    signals integer not null default 0,
    last_interacted_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    primary key (user_id, topic_id),
    constraint user_topic_affinity_signals_nonnegative check (signals >= 0)
);

create index user_topic_affinity_user_score_idx
    on public.user_topic_affinity (user_id, score desc, last_interacted_at desc);

create table public.user_source_affinity (
    user_id uuid not null references auth.users (id) on delete cascade,
    source_id uuid not null references public.content_sources (id) on delete cascade,
    score double precision not null default 0,
    signals integer not null default 0,
    last_interacted_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    primary key (user_id, source_id),
    constraint user_source_affinity_signals_nonnegative check (signals >= 0)
);

create index user_source_affinity_user_score_idx
    on public.user_source_affinity (user_id, score desc, last_interacted_at desc);

create table public.content_halo_daily (
    content_id uuid not null references public.content (id) on delete cascade,
    halo_date date not null,
    score double precision not null default 0,
    signals_count integer not null default 0,
    impression_count integer not null default 0,
    open_count integer not null default 0,
    dismiss_count integer not null default 0,
    save_count integer not null default 0,
    mark_read_count integer not null default 0,
    total_visible_ms bigint not null default 0,
    computed_at timestamptz not null default timezone('utc', now()),
    primary key (content_id, halo_date),
    constraint content_halo_daily_score_range check (score >= 0 and score <= 1),
    constraint content_halo_daily_counts_nonnegative check (
        signals_count >= 0
        and impression_count >= 0
        and open_count >= 0
        and dismiss_count >= 0
        and save_count >= 0
        and mark_read_count >= 0
        and total_visible_ms >= 0
    )
);

create index content_halo_daily_date_score_idx
    on public.content_halo_daily (halo_date desc, score desc);

create table public.source_halo_daily (
    source_id uuid not null references public.content_sources (id) on delete cascade,
    halo_date date not null,
    score double precision not null default 0,
    signals_count integer not null default 0,
    open_count integer not null default 0,
    dismiss_count integer not null default 0,
    save_count integer not null default 0,
    mark_read_count integer not null default 0,
    subscribe_count integer not null default 0,
    unsubscribe_count integer not null default 0,
    total_visible_ms bigint not null default 0,
    computed_at timestamptz not null default timezone('utc', now()),
    primary key (source_id, halo_date),
    constraint source_halo_daily_score_range check (score >= 0 and score <= 1),
    constraint source_halo_daily_counts_nonnegative check (
        signals_count >= 0
        and open_count >= 0
        and dismiss_count >= 0
        and save_count >= 0
        and mark_read_count >= 0
        and subscribe_count >= 0
        and unsubscribe_count >= 0
        and total_visible_ms >= 0
    )
);

create index source_halo_daily_date_score_idx
    on public.source_halo_daily (halo_date desc, score desc);

create table public.recommendation_serve_items (
    serve_id uuid not null references public.recommendation_serves (id) on delete cascade,
    position integer not null,
    entity_type text not null,
    content_id uuid references public.content (id) on delete cascade,
    source_id uuid references public.content_sources (id) on delete cascade,
    score double precision not null,
    score_breakdown jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default timezone('utc', now()),
    primary key (serve_id, position),
    constraint recommendation_serve_items_entity_type check (
        entity_type in ('content', 'source')
    ),
    constraint recommendation_serve_items_target_check check (
        (entity_type = 'content' and content_id is not null)
        or (entity_type = 'source' and source_id is not null and content_id is null)
    ),
    constraint recommendation_serve_items_position_nonnegative check (position >= 0),
    constraint recommendation_serve_items_score_breakdown_shape check (
        jsonb_typeof(score_breakdown) = 'object'
    )
);

create index recommendation_serve_items_content_idx
    on public.recommendation_serve_items (content_id)
    where content_id is not null;

create index recommendation_serve_items_source_idx
    on public.recommendation_serve_items (source_id)
    where source_id is not null;

alter table public.topics enable row level security;
alter table public.source_topics enable row level security;
alter table public.content_topics enable row level security;
alter table public.user_recommendation_settings enable row level security;
alter table public.user_topic_preferences enable row level security;
alter table public.recommendation_serves enable row level security;
alter table public.interaction_events enable row level security;
alter table public.user_content_feedback enable row level security;
alter table public.user_topic_affinity enable row level security;
alter table public.user_source_affinity enable row level security;
alter table public.content_halo_daily enable row level security;
alter table public.source_halo_daily enable row level security;
alter table public.recommendation_serve_items enable row level security;

create trigger topics_set_updated_at
before update on public.topics
for each row
execute function public.set_current_timestamp_updated_at();

create trigger user_recommendation_settings_set_updated_at
before update on public.user_recommendation_settings
for each row
execute function public.set_current_timestamp_updated_at();

create trigger user_topic_preferences_set_updated_at
before update on public.user_topic_preferences
for each row
execute function public.set_current_timestamp_updated_at();

create trigger user_content_feedback_set_updated_at
before update on public.user_content_feedback
for each row
execute function public.set_current_timestamp_updated_at();

create trigger user_topic_affinity_set_updated_at
before update on public.user_topic_affinity
for each row
execute function public.set_current_timestamp_updated_at();

create trigger user_source_affinity_set_updated_at
before update on public.user_source_affinity
for each row
execute function public.set_current_timestamp_updated_at();

insert into public.topics (slug, label, description)
values
    ('technology', 'Technology', 'Software, computing, and engineering'),
    ('science', 'Science', 'Research, discovery, and the natural sciences'),
    ('society', 'Society', 'Social issues, institutions, and communities'),
    ('business', 'Business', 'Companies, markets, and strategy'),
    ('design', 'Design', 'Product, visual, and interaction design'),
    ('culture', 'Culture', 'Arts, media, and cultural commentary'),
    ('politics', 'Politics', 'Governance, policy, and public affairs'),
    ('health', 'Health', 'Medicine, wellbeing, and public health'),
    ('finance', 'Finance', 'Investing, economics, and personal finance')
on conflict (slug) do update
set label = excluded.label,
    description = excluded.description;

do $$
begin
    perform pgmq.create('recommendation_refresh');
exception
    when duplicate_table then
        null;
end;
$$;

create or replace function public.enqueue_recommendation_refresh(
    p_user_id uuid default null,
    p_content_id uuid default null,
    p_source_id uuid default null,
    p_trigger text default 'event',
    p_delay_seconds integer default 0,
    p_retry_count integer default 0
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if p_user_id is null and p_content_id is null and p_source_id is null then
        raise exception 'recommendation refresh requires at least one target';
    end if;

    if p_trigger not in (
        'event',
        'preferences',
        'save',
        'subscribe',
        'unsubscribe',
        'cron',
        'retry'
    ) then
        raise exception 'recommendation refresh trigger % is invalid', p_trigger;
    end if;

    return pgmq.send(
        queue_name => 'recommendation_refresh',
        msg => jsonb_build_object(
            'user_id', p_user_id,
            'content_id', p_content_id,
            'source_id', p_source_id,
            'trigger', p_trigger,
            'requested_at', timezone('utc', now()),
            'retry_count', greatest(p_retry_count, 0)
        ),
        delay => greatest(p_delay_seconds, 0)
    );
end;
$$;

create or replace function public.dequeue_recommendation_refresh(
    p_batch_size integer default 25,
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
        queue_name => 'recommendation_refresh',
        vt => greatest(p_visibility_timeout_seconds, 1),
        qty => greatest(p_batch_size, 1)
    );
$$;

create or replace function public.archive_recommendation_refresh(
    p_msg_id bigint
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
    select pgmq.archive(
        queue_name => 'recommendation_refresh',
        msg_id => p_msg_id
    );
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
        e.content_id,
        coalesce(max(e.source_id), c.source_id),
        count(*) filter (where e.event_type = 'impression')::integer,
        count(*) filter (where e.event_type = 'open')::integer,
        count(*) filter (where e.event_type = 'heartbeat')::integer,
        count(*) filter (where e.event_type = 'dismiss')::integer,
        count(*) filter (where e.event_type = 'save')::integer,
        count(*) filter (where e.event_type = 'favorite')::integer,
        count(*) filter (where e.event_type = 'mark_read')::integer,
        coalesce(sum(e.visible_ms_delta), 0)::bigint,
        max(e.occurred_at),
        least(
            coalesce(sum(e.visible_ms_delta), 0)::double precision
                / greatest(coalesce(max(c.estimated_read_seconds), 1) * 1000, 1000),
            1.5
        ),
        least(
            greatest(
                (least(count(*) filter (where e.event_type = 'open')::double precision, 1) * 0.20)
                + (
                    least(
                        coalesce(sum(e.visible_ms_delta), 0)::double precision
                            / greatest(coalesce(max(c.estimated_read_seconds), 1) * 1000, 1000),
                        1.5
                    ) * 0.60
                )
                + (least(count(*) filter (where e.event_type = 'save')::double precision, 1) * 0.40)
                + (least(count(*) filter (where e.event_type = 'favorite')::double precision, 1) * 0.30)
                + (least(count(*) filter (where e.event_type = 'mark_read')::double precision, 1) * 0.40)
                - (least(count(*) filter (where e.event_type = 'dismiss')::double precision, 1) * 0.50),
                -1.0
            ),
            2.0
        )
    from public.interaction_events e
    left join public.content c on c.id = e.content_id
    where e.user_id = p_user_id
      and e.content_id is not null
      and e.occurred_at >= timezone('utc', now()) - interval '90 days'
    group by e.content_id, c.source_id
    having count(*) > 0;
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
            e.source_id,
            sum(
                (
                    case e.event_type
                        when 'subscribe' then 0.90
                        when 'unsubscribe' then -0.90
                        when 'dismiss' then -0.60
                        when 'open' then 0.15
                        when 'impression' then 0.05
                        else 0.0
                    end
                )
                * exp(
                    -ln(2.0)
                    * greatest(
                        extract(epoch from (timezone('utc', now()) - e.occurred_at)) / 86400.0,
                        0
                    )
                    / 30.0
                )
            ) as score,
            count(*)::integer as signals,
            max(e.occurred_at) as last_interacted_at
        from public.interaction_events e
        where e.user_id = p_user_id
          and e.source_id is not null
          and e.content_id is null
          and e.occurred_at >= timezone('utc', now()) - interval '90 days'
        group by e.source_id
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

create or replace function public.rebuild_content_halo_daily(
    p_content_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    delete from public.content_halo_daily
    where content_id = p_content_id;

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
    with event_days as (
        select
            e.content_id,
            timezone('utc', e.occurred_at)::date as halo_date,
            count(distinct e.user_id) filter (
                where e.event_type in ('open', 'heartbeat', 'save', 'mark_read', 'dismiss')
            )::integer as signals_count,
            count(*) filter (where e.event_type = 'impression')::integer as impression_count,
            count(*) filter (where e.event_type = 'open')::integer as open_count,
            count(*) filter (where e.event_type = 'dismiss')::integer as dismiss_count,
            count(*) filter (where e.event_type = 'save')::integer as save_count,
            count(*) filter (where e.event_type = 'mark_read')::integer as mark_read_count,
            coalesce(sum(e.visible_ms_delta), 0)::bigint as total_visible_ms,
            max(c.estimated_read_seconds) as estimated_read_seconds
        from public.interaction_events e
        join public.content c on c.id = e.content_id
        where e.content_id = p_content_id
          and e.occurred_at >= timezone('utc', now()) - interval '30 days'
        group by e.content_id, timezone('utc', e.occurred_at)::date
    )
    select
        p_content_id,
        halo_date,
        least(
            (
                (
                    greatest(
                        (
                            least(open_count::double precision, 10.0) / 10.0 * 0.15
                        )
                        + (
                            least(
                                total_visible_ms::double precision
                                    / greatest(coalesce(estimated_read_seconds, 1) * 1000, 1000),
                                1.5
                            ) / 1.5 * 0.35
                        )
                        + (
                            least(save_count::double precision, 10.0) / 10.0 * 0.25
                        )
                        + (
                            least(mark_read_count::double precision, 10.0) / 10.0 * 0.20
                        )
                        - (
                            least(dismiss_count::double precision, 10.0) / 10.0 * 0.20
                        ),
                        0.0
                    )
                    * signals_count
                )
                + (0.35 * 5.0)
            )
            / greatest(signals_count + 5, 1),
            1.0
        ) as score,
        signals_count,
        impression_count,
        open_count,
        dismiss_count,
        save_count,
        mark_read_count,
        total_visible_ms,
        timezone('utc', now())
    from event_days;
end;
$$;

create or replace function public.rebuild_source_halo_daily(
    p_source_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    delete from public.source_halo_daily
    where source_id = p_source_id;

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
    with source_content_events as (
        select
            coalesce(e.source_id, c.source_id) as source_id,
            timezone('utc', e.occurred_at)::date as halo_date,
            count(distinct e.user_id) filter (
                where e.event_type in ('open', 'heartbeat', 'save', 'mark_read', 'dismiss')
            )::integer as content_signals,
            count(*) filter (where e.event_type = 'open')::integer as open_count,
            count(*) filter (where e.event_type = 'dismiss')::integer as dismiss_count,
            count(*) filter (where e.event_type = 'save')::integer as save_count,
            count(*) filter (where e.event_type = 'mark_read')::integer as mark_read_count,
            coalesce(sum(e.visible_ms_delta), 0)::bigint as total_visible_ms
        from public.interaction_events e
        left join public.content c on c.id = e.content_id
        where coalesce(e.source_id, c.source_id) = p_source_id
          and e.occurred_at >= timezone('utc', now()) - interval '30 days'
        group by coalesce(e.source_id, c.source_id), timezone('utc', e.occurred_at)::date
    ),
    source_events as (
        select
            e.source_id,
            timezone('utc', e.occurred_at)::date as halo_date,
            count(distinct e.user_id) filter (
                where e.event_type in ('subscribe', 'unsubscribe', 'dismiss')
            )::integer as source_signals,
            count(*) filter (where e.event_type = 'subscribe')::integer as subscribe_count,
            count(*) filter (where e.event_type = 'unsubscribe')::integer as unsubscribe_count
        from public.interaction_events e
        where e.source_id = p_source_id
          and e.content_id is null
          and e.occurred_at >= timezone('utc', now()) - interval '30 days'
        group by e.source_id, timezone('utc', e.occurred_at)::date
    ),
    merged as (
        select
            p_source_id as source_id,
            d.halo_date,
            coalesce(sce.content_signals, 0) + coalesce(se.source_signals, 0) as signals_count,
            coalesce(sce.open_count, 0) as open_count,
            coalesce(sce.dismiss_count, 0) as dismiss_count,
            coalesce(sce.save_count, 0) as save_count,
            coalesce(sce.mark_read_count, 0) as mark_read_count,
            coalesce(se.subscribe_count, 0) as subscribe_count,
            coalesce(se.unsubscribe_count, 0) as unsubscribe_count,
            coalesce(sce.total_visible_ms, 0)::bigint as total_visible_ms
        from (
            select halo_date from source_content_events
            union
            select halo_date from source_events
        ) d
        left join source_content_events sce on sce.halo_date = d.halo_date
        left join source_events se on se.halo_date = d.halo_date
    )
    select
        source_id,
        halo_date,
        least(
            (
                (
                    greatest(
                        (
                            least(open_count::double precision, 20.0) / 20.0 * 0.15
                        )
                        + (
                            least(total_visible_ms::double precision, 600000.0) / 600000.0 * 0.25
                        )
                        + (
                            least(save_count::double precision, 20.0) / 20.0 * 0.20
                        )
                        + (
                            least(mark_read_count::double precision, 20.0) / 20.0 * 0.15
                        )
                        + (
                            least(subscribe_count::double precision, 10.0) / 10.0 * 0.25
                        )
                        - (
                            least(dismiss_count::double precision, 20.0) / 20.0 * 0.15
                        )
                        - (
                            least(unsubscribe_count::double precision, 10.0) / 10.0 * 0.20
                        ),
                        0.0
                    )
                    * signals_count
                )
                + (0.35 * 5.0)
            )
            / greatest(signals_count + 5, 1),
            1.0
        ) as score,
        signals_count,
        open_count,
        dismiss_count,
        save_count,
        mark_read_count,
        subscribe_count,
        unsubscribe_count,
        total_visible_ms,
        timezone('utc', now())
    from merged;
end;
$$;

create or replace function public.refresh_recommendation_state(
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
    derived_source_id uuid;
begin
    if p_user_id is not null then
        perform public.rebuild_user_content_feedback(p_user_id);
        perform public.rebuild_user_source_affinity(p_user_id);
        perform public.rebuild_user_topic_affinity(p_user_id);
    end if;

    if p_content_id is not null then
        perform public.rebuild_content_halo_daily(p_content_id);
    end if;

    derived_source_id := p_source_id;
    if derived_source_id is null and p_content_id is not null then
        select source_id
        into derived_source_id
        from public.content
        where id = p_content_id;
    end if;

    if derived_source_id is not null then
        perform public.rebuild_source_halo_daily(derived_source_id);
    end if;
end;
$$;

create or replace function public.invoke_recommendation_processor(
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
        url := project_url || '/functions/v1/process-recommendation-batch',
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

revoke all on function public.enqueue_recommendation_refresh(uuid, uuid, uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.dequeue_recommendation_refresh(integer, integer) from public, anon, authenticated;
revoke all on function public.archive_recommendation_refresh(bigint) from public, anon, authenticated;
revoke all on function public.rebuild_user_content_feedback(uuid) from public, anon, authenticated;
revoke all on function public.rebuild_user_source_affinity(uuid) from public, anon, authenticated;
revoke all on function public.rebuild_user_topic_affinity(uuid) from public, anon, authenticated;
revoke all on function public.rebuild_content_halo_daily(uuid) from public, anon, authenticated;
revoke all on function public.rebuild_source_halo_daily(uuid) from public, anon, authenticated;
revoke all on function public.refresh_recommendation_state(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.invoke_recommendation_processor(jsonb) from public, anon, authenticated;

grant execute on function public.enqueue_recommendation_refresh(uuid, uuid, uuid, text, integer, integer) to service_role;
grant execute on function public.dequeue_recommendation_refresh(integer, integer) to service_role;
grant execute on function public.archive_recommendation_refresh(bigint) to service_role;
grant execute on function public.rebuild_user_content_feedback(uuid) to service_role;
grant execute on function public.rebuild_user_source_affinity(uuid) to service_role;
grant execute on function public.rebuild_user_topic_affinity(uuid) to service_role;
grant execute on function public.rebuild_content_halo_daily(uuid) to service_role;
grant execute on function public.rebuild_source_halo_daily(uuid) to service_role;
grant execute on function public.refresh_recommendation_state(uuid, uuid, uuid) to service_role;
grant execute on function public.invoke_recommendation_processor(jsonb) to service_role;

do $$
begin
    if exists (
        select 1
        from cron.job
        where jobname = 'process-recommendation-batch-every-minute'
    ) then
        perform cron.unschedule('process-recommendation-batch-every-minute');
    end if;

    perform cron.schedule(
        'process-recommendation-batch-every-minute',
        '* * * * *',
        $job$
        select public.invoke_recommendation_processor(jsonb_build_object('trigger', 'cron'));
        $job$
    );
end;
$$;
