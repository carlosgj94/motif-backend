create or replace function public.source_quality_score_from_tier(
    p_quality_tier smallint
)
returns double precision
language sql
immutable
as $$
    select case p_quality_tier
        when 5 then 1.00::double precision
        when 4 then 0.80::double precision
        when 3 then 0.60::double precision
        when 2 then 0.35::double precision
        else 0.10::double precision
    end
$$;

alter table public.content_sources
    add column if not exists is_curated boolean not null default false,
    add column if not exists quality_tier smallint not null default 3;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'content_sources_quality_tier_range'
    ) then
        alter table public.content_sources
            add constraint content_sources_quality_tier_range
            check (quality_tier between 1 and 5);
    end if;
end;
$$;

alter table public.content_sources
    add column if not exists editorial_score double precision
    generated always as (public.source_quality_score_from_tier(quality_tier)) stored;

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
        coalesce(cs.editorial_score, 0.0) as editorial_score,
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

drop function if exists public.get_source_recommendation_candidates(uuid);

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
    similarity_score double precision,
    editorial_score double precision
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
        from public.user_topic_affinity uta
        join public.source_topics st on st.topic_id = uta.topic_id
        where uta.user_id = p_user_id
          and uta.score > 0
        limit 200
    ),
    recent_sources as (
        select
            c.source_id
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
        select source_id from topic_sources
        union
        select source_id from recent_sources
        union
        select source_id from similar_sources
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
        coalesce(ssim.similarity_score, 0.0) as similarity_score,
        cs.editorial_score
    from filtered_sources fs
    join public.content_sources cs on cs.id = fs.source_id
    left join public.source_feeds sf on sf.id = cs.primary_feed_id
    left join topic_scores ts on ts.source_id = cs.id
    left join source_halo sh on sh.source_id = cs.id
    left join recent_activity ra on ra.source_id = cs.id
    left join similarity_scores ssim on ssim.source_id = cs.id
    order by
        coalesce(ts.topic_score, 0.0) desc,
        cs.editorial_score desc,
        coalesce(sh.source_halo_score, 0.0) desc,
        coalesce(ra.recent_activity_count, 0) desc,
        cs.id asc;
$$;

drop function if exists public.get_public_source_recommendation_candidates(uuid[], text[]);

create or replace function public.get_public_source_recommendation_candidates(
    p_topic_ids uuid[],
    p_language_codes text[] default '{}'::text[]
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
    similarity_score double precision,
    editorial_score double precision
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with selected_topics as (
        select
            tc.descendant_topic_id as topic_id,
            min(tc.depth) as selected_depth
        from public.topic_closure tc
        where tc.ancestor_topic_id = any(coalesce(p_topic_ids, '{}'::uuid[]))
        group by tc.descendant_topic_id
    ),
    matched_topic_sources as (
        select
            st.source_id,
            least(
                sum(
                    st.confidence
                    * power(0.85::double precision, selected_topics.selected_depth::double precision)
                ),
                2.0
            ) as topic_score,
            (
                array_agg(
                    t.slug
                    order by
                        st.confidence
                        * power(0.85::double precision, selected_topics.selected_depth::double precision) desc,
                        t.slug asc
                )
            )[1] as primary_topic_slug
        from public.source_topics st
        join selected_topics on selected_topics.topic_id = st.topic_id
        join public.topics t on t.id = st.topic_id
        group by st.source_id
    ),
    recent_activity as (
        select
            c.source_id,
            count(*)::bigint as recent_activity_count
        from public.content c
        where c.source_id in (select source_id from matched_topic_sources)
          and c.parse_status = 'succeeded'
          and c.parsed_document is not null
          and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '30 days'
          and (
              cardinality(coalesce(p_language_codes, '{}'::text[])) = 0
              or c.language_code is null
              or c.language_code = any(coalesce(p_language_codes, '{}'::text[]))
          )
        group by c.source_id
    ),
    source_halo as (
        select
            shd.source_id,
            avg(shd.score) as source_halo_score
        from public.source_halo_daily shd
        where shd.source_id in (select source_id from matched_topic_sources)
          and shd.halo_date >= current_date - 30
        group by shd.source_id
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
        mts.topic_score,
        mts.primary_topic_slug,
        coalesce(sh.source_halo_score, 0.0) as source_halo_score,
        coalesce(ra.recent_activity_count, 0)::bigint as recent_activity_count,
        0.0::double precision as similarity_score,
        cs.editorial_score
    from matched_topic_sources mts
    join public.content_sources cs on cs.id = mts.source_id
    left join public.source_feeds sf on sf.id = cs.primary_feed_id
    left join recent_activity ra on ra.source_id = mts.source_id
    left join source_halo sh on sh.source_id = mts.source_id
    where coalesce(ra.recent_activity_count, 0) > 0
    order by
        mts.topic_score desc,
        cs.editorial_score desc,
        coalesce(sh.source_halo_score, 0.0) desc,
        coalesce(ra.recent_activity_count, 0) desc,
        cs.id asc;
$$;

revoke all on function public.get_content_recommendation_candidates(uuid) from public, anon, authenticated;
revoke all on function public.get_source_recommendation_candidates(uuid) from public, anon, authenticated;
revoke all on function public.get_public_source_recommendation_candidates(uuid[], text[]) from public, anon, authenticated;

grant execute on function public.get_content_recommendation_candidates(uuid) to service_role;
grant execute on function public.get_source_recommendation_candidates(uuid) to service_role;
grant execute on function public.get_public_source_recommendation_candidates(uuid[], text[]) to service_role;
