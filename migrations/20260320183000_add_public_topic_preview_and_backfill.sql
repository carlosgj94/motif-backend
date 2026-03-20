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
    similarity_score double precision
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
        0.0::double precision as similarity_score
    from matched_topic_sources mts
    join public.content_sources cs on cs.id = mts.source_id
    left join public.source_feeds sf on sf.id = cs.primary_feed_id
    left join recent_activity ra on ra.source_id = mts.source_id
    left join source_halo sh on sh.source_id = mts.source_id
    where coalesce(ra.recent_activity_count, 0) > 0
    order by
        mts.topic_score desc,
        coalesce(sh.source_halo_score, 0.0) desc,
        coalesce(ra.recent_activity_count, 0) desc,
        cs.id asc;
$$;

create or replace function public.backfill_content_topics_from_source_topics(
    p_source_ids uuid[] default null,
    p_content_ids uuid[] default null,
    p_overwrite boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_inserted integer := 0;
begin
    if p_overwrite then
        delete from public.content_topics ct
        using public.content c
        where c.id = ct.content_id
          and (
              p_source_ids is null
              or c.source_id = any(p_source_ids)
          )
          and (
              p_content_ids is null
              or c.id = any(p_content_ids)
          );
    end if;

    with inserted as (
        insert into public.content_topics (
            content_id,
            topic_id,
            confidence
        )
        select
            c.id as content_id,
            st.topic_id,
            least(st.confidence * 0.8, 1.0) as confidence
        from public.content c
        join public.source_topics st on st.source_id = c.source_id
        where c.source_id is not null
          and (
              p_source_ids is null
              or c.source_id = any(p_source_ids)
          )
          and (
              p_content_ids is null
              or c.id = any(p_content_ids)
          )
        on conflict (content_id, topic_id) do nothing
        returning 1
    )
    select count(*)::integer
    into v_inserted
    from inserted;

    return v_inserted;
end;
$$;

revoke all on function public.get_public_source_recommendation_candidates(uuid[], text[]) from public, anon, authenticated;
revoke all on function public.backfill_content_topics_from_source_topics(uuid[], uuid[], boolean) from public, anon, authenticated;

grant execute on function public.get_public_source_recommendation_candidates(uuid[], text[]) to service_role;
grant execute on function public.backfill_content_topics_from_source_topics(uuid[], uuid[], boolean) to service_role;
