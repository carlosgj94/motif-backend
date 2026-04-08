create table if not exists public.curated_content (
    content_id uuid primary key references public.content (id) on delete cascade,
    collection text not null,
    curated_score double precision not null default 1.0,
    editorial_tags text[] not null default '{}'::text[],
    source_rank integer,
    metadata jsonb not null default '{}'::jsonb,
    curated_at timestamptz not null default timezone('utc', now()),
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint curated_content_collection_not_blank check (btrim(collection) <> ''),
    constraint curated_content_score_range check (curated_score >= 0 and curated_score <= 1),
    constraint curated_content_source_rank_nonnegative check (
        source_rank is null or source_rank >= 0
    ),
    constraint curated_content_editorial_tags_one_dimensional check (
        array_ndims(editorial_tags) is null
        or array_ndims(editorial_tags) = 1
    ),
    constraint curated_content_metadata_shape check (
        jsonb_typeof(metadata) = 'object'
    )
);

create index if not exists curated_content_collection_score_idx
    on public.curated_content (
        collection,
        curated_score desc,
        source_rank asc,
        curated_at desc,
        content_id
    );

create index if not exists curated_content_collection_content_idx
    on public.curated_content (collection, content_id);

alter table public.curated_content enable row level security;

drop trigger if exists curated_content_set_updated_at on public.curated_content;

create trigger curated_content_set_updated_at
before update on public.curated_content
for each row execute function public.set_current_timestamp_updated_at();

create or replace function public.seed_content_halo_score(
    p_content_id uuid,
    p_halo_date date default current_date,
    p_score double precision default 1.0
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if p_score < 0 or p_score > 1 then
        raise exception 'content halo score % is invalid', p_score;
    end if;

    insert into public.content_halo_daily (
        content_id,
        halo_date,
        score,
        computed_at
    )
    values (
        p_content_id,
        coalesce(p_halo_date, current_date),
        p_score,
        timezone('utc', now())
    )
    on conflict (content_id, halo_date) do update
    set score = greatest(public.content_halo_daily.score, excluded.score),
        computed_at = timezone('utc', now());
end;
$$;

create or replace function public.replace_curated_content_topics(
    p_content_id uuid,
    p_topic_ids uuid[],
    p_confidence double precision default 0.95
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_inserted integer := 0;
begin
    if p_confidence <= 0 or p_confidence > 1 then
        raise exception 'content topic confidence % is invalid', p_confidence;
    end if;

    delete from public.content_topics
    where content_id = p_content_id
      and confidence = p_confidence
      and (
          p_topic_ids is null
          or cardinality(p_topic_ids) = 0
          or topic_id <> all(p_topic_ids)
      );

    with inserted as (
        insert into public.content_topics (
            content_id,
            topic_id,
            confidence
        )
        select
            p_content_id,
            topic_ids.topic_id,
            p_confidence
        from unnest(coalesce(p_topic_ids, '{}'::uuid[])) as topic_ids(topic_id)
        on conflict (content_id, topic_id) do nothing
        returning 1
    )
    select count(*)::integer
    into v_inserted
    from inserted;

    return v_inserted;
end;
$$;

drop function if exists public.get_content_recommendation_candidates_for_topic(uuid, uuid);
drop function if exists public.get_content_recommendation_candidates(uuid);

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
    evergreen boolean,
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
    editorial_score double precision,
    curated_score double precision,
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
            false as trending,
            false as evergreen
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
            false as trending,
            false as evergreen
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
            false as trending,
            false as evergreen
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
            true as trending,
            false as evergreen
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
    evergreen_bucket as (
        select
            c.id as content_id,
            false as subscribed_inbox,
            false as discovery,
            false as saved_adjacent,
            false as trending,
            true as evergreen
        from public.curated_content cc
        join public.content c on c.id = cc.content_id
        cross join ctx
        where cc.curated_score > 0
          and c.parse_status = 'succeeded'
          and c.parsed_document is not null
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
        order by
            cc.curated_score desc,
            cc.source_rank asc nulls last,
            coalesce(c.published_at, c.created_at) desc,
            c.id desc
        limit 200
    ),
    all_candidates as (
        select
            content_id,
            bool_or(subscribed_inbox) as subscribed_inbox,
            bool_or(discovery) as discovery,
            bool_or(saved_adjacent) as saved_adjacent,
            bool_or(trending) as trending,
            bool_or(evergreen) as evergreen
        from (
            select * from subscribed_bucket
            union all
            select * from discovery_bucket
            union all
            select * from saved_adjacent_bucket
            union all
            select * from trending_bucket
            union all
            select * from evergreen_bucket
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
        ac.evergreen,
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
        coalesce(cs.editorial_score, 0.0) as editorial_score,
        coalesce(cc.curated_score, 0.0) as curated_score,
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
    left join public.curated_content cc on cc.content_id = c.id
    left join public.user_content_feedback ucf
      on ucf.user_id = p_user_id
     and ucf.content_id = c.id
    order by
        ac.subscribed_inbox desc,
        ac.saved_adjacent desc,
        ac.discovery desc,
        ac.trending desc,
        ac.evergreen desc,
        coalesce(c.published_at, c.created_at) desc,
        c.id desc;
$$;

create or replace function public.get_content_recommendation_candidates_for_topic(
    p_user_id uuid,
    p_topic_id uuid
)
returns table (
    content_id uuid,
    source_id uuid,
    subscribed_inbox boolean,
    discovery boolean,
    saved_adjacent boolean,
    trending boolean,
    evergreen boolean,
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
    editorial_score double precision,
    curated_score double precision,
    dismiss_count integer,
    mark_read_count integer,
    read_ratio double precision
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select
        candidate.content_id,
        candidate.source_id,
        candidate.subscribed_inbox,
        candidate.discovery,
        candidate.saved_adjacent,
        candidate.trending,
        candidate.evergreen,
        candidate.canonical_url,
        candidate.resolved_url,
        candidate.host,
        candidate.site_name,
        candidate.source_kind,
        candidate.title,
        candidate.excerpt,
        candidate.author,
        candidate.published_at,
        candidate.language_code,
        candidate.has_favicon,
        candidate.fetch_status,
        candidate.parse_status,
        candidate.parsed_at,
        candidate.created_at,
        candidate.source_url,
        candidate.resolved_source_url,
        candidate.source_host,
        candidate.source_title,
        candidate.source_kind_label,
        candidate.primary_feed_url,
        candidate.topic_score,
        candidate.primary_topic_slug,
        candidate.source_affinity_score,
        candidate.content_halo_score,
        candidate.source_halo_score,
        candidate.editorial_score,
        candidate.curated_score,
        candidate.dismiss_count,
        candidate.mark_read_count,
        candidate.read_ratio
    from public.get_content_recommendation_candidates(p_user_id) candidate
    where exists (
        select 1
        from public.content_topics ct
        where ct.content_id = candidate.content_id
          and ct.topic_id = p_topic_id
    )
    or exists (
        select 1
        from public.source_topics st
        where st.source_id = candidate.source_id
          and st.topic_id = p_topic_id
    );
$$;

revoke all on function public.get_content_recommendation_candidates(uuid) from public, anon, authenticated;
revoke all on function public.get_content_recommendation_candidates_for_topic(uuid, uuid) from public, anon, authenticated;
revoke all on function public.seed_content_halo_score(uuid, date, double precision) from public, anon, authenticated;
revoke all on function public.replace_curated_content_topics(uuid, uuid[], double precision) from public, anon, authenticated;

grant execute on function public.get_content_recommendation_candidates(uuid) to service_role;
grant execute on function public.get_content_recommendation_candidates_for_topic(uuid, uuid) to service_role;
grant execute on function public.seed_content_halo_score(uuid, date, double precision) to service_role;
grant execute on function public.replace_curated_content_topics(uuid, uuid[], double precision) to service_role;
