create or replace function public.get_user_recommendation_subtopics(
    p_user_id uuid
)
returns table (
    id uuid,
    slug text,
    label text,
    description text,
    parent_topic_slug text,
    parent_topic_label text,
    affinity_score double precision,
    last_interacted_at timestamptz,
    is_from_settings boolean,
    is_from_behavior boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with settings_topics as (
        select distinct tc.descendant_topic_id as topic_id
        from public.user_topic_preferences utp
        join public.topic_closure tc
          on tc.ancestor_topic_id = utp.topic_id
        where utp.user_id = p_user_id
    ),
    behavior_topics as (
        select distinct ct.topic_id
        from public.user_content_feedback ucf
        join public.content_topics ct on ct.content_id = ucf.content_id
        where ucf.user_id = p_user_id
          and ucf.last_interacted_at is not null

        union

        select distinct st.topic_id
        from public.user_source_affinity usa
        join public.source_topics st on st.source_id = usa.source_id
        where usa.user_id = p_user_id
          and (
              usa.last_interacted_at is not null
              or usa.signals > 0
              or usa.score <> 0
          )
    )
    select
        topic.id,
        topic.slug,
        topic.label,
        topic.description,
        parent_topic.slug as parent_topic_slug,
        parent_topic.label as parent_topic_label,
        uta.score as affinity_score,
        uta.last_interacted_at,
        exists (
            select 1
            from settings_topics st
            where st.topic_id = topic.id
        ) as is_from_settings,
        exists (
            select 1
            from behavior_topics bt
            where bt.topic_id = topic.id
        ) as is_from_behavior
    from public.user_topic_affinity uta
    join public.topics topic on topic.id = uta.topic_id
    join public.topics parent_topic on parent_topic.id = topic.parent_topic_id
    where uta.user_id = p_user_id
      and uta.score > 0
      and topic.parent_topic_id is not null
      and not exists (
          select 1
          from public.topics child
          where child.parent_topic_id = topic.id
      )
    order by
        uta.score desc,
        uta.last_interacted_at desc nulls last,
        topic.slug asc;
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
    select
        candidate.content_id,
        candidate.source_id,
        candidate.subscribed_inbox,
        candidate.discovery,
        candidate.saved_adjacent,
        candidate.trending,
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

revoke all on function public.get_user_recommendation_subtopics(uuid) from public, anon, authenticated;
revoke all on function public.get_content_recommendation_candidates_for_topic(uuid, uuid) from public, anon, authenticated;

grant execute on function public.get_user_recommendation_subtopics(uuid) to service_role;
grant execute on function public.get_content_recommendation_candidates_for_topic(uuid, uuid) to service_role;
