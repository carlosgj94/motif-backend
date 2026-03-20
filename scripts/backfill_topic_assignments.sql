\set ON_ERROR_STOP on

begin;

with curated_host_topics (host, topic_slug, confidence) as (
    values
        ('daringfireball.net', 'technology', 1.00::double precision),
        ('daringfireball.net', 'programming', 0.90::double precision),
        ('daringfireball.net', 'devices', 0.95::double precision)
),
upserted_source_topics as (
    insert into public.source_topics (source_id, topic_id, confidence)
    select
        cs.id as source_id,
        t.id as topic_id,
        curated.confidence
    from curated_host_topics curated
    join public.content_sources cs on cs.host = curated.host
    join public.topics t on t.slug = curated.topic_slug
    on conflict (source_id, topic_id) do update
    set confidence = excluded.confidence
    returning source_id, topic_id
)
select count(*) as seeded_source_topic_links
from upserted_source_topics;

select public.backfill_content_topics_from_source_topics(null, null, false)
    as seeded_content_topic_links;

commit;
