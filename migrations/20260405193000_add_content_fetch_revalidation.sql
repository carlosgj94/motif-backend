alter table public.content
    add column fetch_etag text,
    add column fetch_last_modified text,
    add column parser_quality_score integer;

create or replace function public.claim_content_processing(
    p_content_id uuid,
    p_stale_after_seconds integer default 900
)
returns table (
    id uuid,
    canonical_url text,
    resolved_url text,
    host text,
    fetch_etag text,
    fetch_last_modified text,
    has_parsed_document boolean,
    fetch_attempt_count integer,
    parse_attempt_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    return query
    update public.content as c
    set fetch_status = 'in_progress',
        parse_status = 'in_progress',
        last_fetch_attempt_at = timezone('utc', now()),
        last_parse_attempt_at = timezone('utc', now()),
        last_fetch_error = null,
        last_parse_error = null,
        fetch_attempt_count = c.fetch_attempt_count + 1,
        parse_attempt_count = c.parse_attempt_count + 1
    where c.id = p_content_id
      and (
          c.fetch_status in ('pending', 'failed')
          or c.parse_status in ('pending', 'failed')
          or c.parsed_document is null
          or c.last_successful_fetch_at is null
          or (
              c.fetch_status = 'in_progress'
              and c.last_fetch_attempt_at is not null
              and c.last_fetch_attempt_at < timezone('utc', now()) - make_interval(secs => greatest(p_stale_after_seconds, 1))
          )
      )
    returning
        c.id,
        c.canonical_url,
        c.resolved_url,
        c.host,
        c.fetch_etag,
        c.fetch_last_modified,
        (c.parsed_document is not null) as has_parsed_document,
        c.fetch_attempt_count,
        c.parse_attempt_count;
end;
$$;
