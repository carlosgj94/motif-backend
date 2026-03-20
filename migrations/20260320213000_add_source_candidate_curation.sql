alter table public.content_sources
    add column if not exists curated_at timestamptz,
    add column if not exists curation_summary text,
    add column if not exists curation_rubric jsonb;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'content_sources_curation_rubric_shape'
    ) then
        alter table public.content_sources
            add constraint content_sources_curation_rubric_shape
            check (
                curation_rubric is null
                or jsonb_typeof(curation_rubric) = 'object'
            );
    end if;
end;
$$;

create table public.source_candidates (
    id uuid primary key default gen_random_uuid(),
    submitted_url text not null,
    normalized_url text not null,
    source_url text,
    feed_url_hint text,
    host text not null,
    provenance text not null default 'seed',
    discovery_depth integer not null default 0,
    topic_hint_slugs text[] not null default '{}'::text[],
    seed_name text,
    status text not null default 'pending',
    status_reason text,
    promoted_source_id uuid references public.content_sources (id) on delete set null,
    duplicate_of_candidate_id uuid references public.source_candidates (id) on delete set null,
    duplicate_of_source_id uuid references public.content_sources (id) on delete set null,
    review_count integer not null default 0,
    last_reviewed_at timestamptz,
    last_error_at timestamptz,
    expanded_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint source_candidates_submitted_url_not_blank check (btrim(submitted_url) <> ''),
    constraint source_candidates_normalized_url_not_blank check (btrim(normalized_url) <> ''),
    constraint source_candidates_source_url_not_blank check (
        source_url is null or btrim(source_url) <> ''
    ),
    constraint source_candidates_feed_url_hint_not_blank check (
        feed_url_hint is null or btrim(feed_url_hint) <> ''
    ),
    constraint source_candidates_host_not_blank check (btrim(host) <> ''),
    constraint source_candidates_provenance check (
        provenance in ('seed', 'expansion')
    ),
    constraint source_candidates_depth_range check (
        discovery_depth between 0 and 1
    ),
    constraint source_candidates_status check (
        status in ('pending', 'approved', 'rejected', 'no_feed', 'error', 'duplicate')
    ),
    constraint source_candidates_review_count_nonnegative check (
        review_count >= 0
    ),
    constraint source_candidates_topic_hint_slugs_one_dimensional check (
        array_ndims(topic_hint_slugs) is null
        or array_ndims(topic_hint_slugs) = 1
    )
);

create unique index source_candidates_normalized_url_unique_idx
    on public.source_candidates (normalized_url);

create index source_candidates_status_created_idx
    on public.source_candidates (status, created_at asc, id asc);

create index source_candidates_source_url_idx
    on public.source_candidates (source_url)
    where source_url is not null;

create index source_candidates_feed_url_hint_idx
    on public.source_candidates (feed_url_hint)
    where feed_url_hint is not null;

create index source_candidates_promoted_source_idx
    on public.source_candidates (promoted_source_id)
    where promoted_source_id is not null;

create table public.source_candidate_reviews (
    id uuid primary key default gen_random_uuid(),
    candidate_id uuid not null references public.source_candidates (id) on delete cascade,
    decision text not null,
    sampled_posts jsonb not null,
    inferred_topics jsonb not null,
    rubric jsonb not null,
    overall_quality_tier smallint not null,
    summary text not null,
    review_provider text not null,
    review_model text not null,
    created_at timestamptz not null default timezone('utc', now()),
    constraint source_candidate_reviews_decision check (
        decision in ('approve', 'reject', 'no_feed')
    ),
    constraint source_candidate_reviews_sampled_posts_shape check (
        jsonb_typeof(sampled_posts) = 'array'
    ),
    constraint source_candidate_reviews_inferred_topics_shape check (
        jsonb_typeof(inferred_topics) = 'array'
    ),
    constraint source_candidate_reviews_rubric_shape check (
        jsonb_typeof(rubric) = 'object'
    ),
    constraint source_candidate_reviews_quality_tier_range check (
        overall_quality_tier between 1 and 5
    ),
    constraint source_candidate_reviews_summary_not_blank check (
        btrim(summary) <> ''
    ),
    constraint source_candidate_reviews_provider_not_blank check (
        btrim(review_provider) <> ''
    ),
    constraint source_candidate_reviews_model_not_blank check (
        btrim(review_model) <> ''
    )
);

create index source_candidate_reviews_candidate_created_idx
    on public.source_candidate_reviews (candidate_id, created_at desc, id desc);

alter table public.source_candidates enable row level security;
alter table public.source_candidate_reviews enable row level security;

drop trigger if exists source_candidates_set_updated_at on public.source_candidates;

create trigger source_candidates_set_updated_at
before update on public.source_candidates
for each row execute function public.set_current_timestamp_updated_at();

create or replace function public.enqueue_source_refresh(
    p_source_id uuid,
    p_trigger text default 'subscribe',
    p_delay_seconds integer default 0,
    p_retry_count integer default 0
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if p_trigger not in ('subscribe', 'save', 'seed', 'retry', 'cron') then
        raise exception 'source refresh trigger % is invalid', p_trigger;
    end if;

    return pgmq.send(
        queue_name => 'source_refresh',
        msg => jsonb_build_object(
            'source_id', p_source_id,
            'trigger', p_trigger,
            'requested_at', timezone('utc', now()),
            'retry_count', greatest(p_retry_count, 0)
        ),
        delay => greatest(p_delay_seconds, 0)
    );
end;
$$;
