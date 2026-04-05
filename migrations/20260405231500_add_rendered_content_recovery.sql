alter table public.content
    add column parser_recovery_stage text not null default 'static',
    add constraint content_parser_recovery_stage check (
        parser_recovery_stage in ('static', 'rendered')
    );

drop index if exists content_parser_recovery_needed_idx;

create index content_parser_recovery_needed_idx
    on public.content (parser_recovery_stage, parsed_at desc, id desc)
    where parser_recovery_status = 'needed';

create index content_parser_recovery_stage_status_idx
    on public.content (parser_recovery_stage, parser_recovery_status, parser_recovery_requested_at desc, id desc);

create or replace function public.enqueue_due_content_recoveries(
    p_limit integer default 50
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    due_content_id uuid;
    enqueued_count integer := 0;
begin
    for due_content_id in
        select c.id
        from public.content c
        where c.parsed_document is not null
          and c.parse_status = 'succeeded'
          and c.parser_recovery_stage = 'static'
          and (
              c.parser_recovery_status in ('needed', 'failed')
              or (
                  c.parser_recovery_status = 'in_progress'
                  and c.parser_recovery_last_attempt_at is not null
                  and c.parser_recovery_last_attempt_at < timezone('utc', now()) - interval '15 minutes'
              )
          )
        order by
            case coalesce(c.parser_recovery->>'priority', 'low')
                when 'high' then 0
                else 1
            end asc,
            coalesce(c.parser_recovery_requested_at, c.parsed_at, c.updated_at) asc,
            c.id asc
        limit greatest(p_limit, 1)
    loop
        perform public.enqueue_content_recovery(due_content_id, 'cron', 0, 0);
        enqueued_count := enqueued_count + 1;
    end loop;

    return enqueued_count;
end;
$$;

create or replace function public.claim_content_recovery(
    p_content_id uuid,
    p_stale_after_seconds integer default 900
)
returns table (
    id uuid,
    canonical_url text,
    resolved_url text,
    host text,
    source_kind text,
    title text,
    excerpt text,
    author text,
    published_at timestamptz,
    language_code text,
    site_name text,
    cover_image_url text,
    favicon_bytes bytea,
    favicon_mime_type text,
    favicon_source_url text,
    favicon_fetched_at timestamptz,
    parsed_document jsonb,
    parser_name text,
    parser_version text,
    parser_quality_score integer,
    parser_recovery jsonb,
    parser_recovery_status text,
    parser_recovery_stage text,
    fetch_etag text,
    fetch_last_modified text,
    parser_recovery_attempt_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    return query
    update public.content as c
    set parser_recovery_status = 'in_progress',
        parser_recovery_last_attempt_at = timezone('utc', now()),
        parser_recovery_last_error = null,
        parser_recovery_attempt_count = c.parser_recovery_attempt_count + 1
    where c.id = p_content_id
      and c.parsed_document is not null
      and c.parse_status = 'succeeded'
      and c.parser_recovery_stage = 'static'
      and (
          c.parser_recovery_status in ('needed', 'failed')
          or (
              c.parser_recovery_status = 'in_progress'
              and c.parser_recovery_last_attempt_at is not null
              and c.parser_recovery_last_attempt_at < timezone('utc', now()) - make_interval(secs => greatest(p_stale_after_seconds, 1))
          )
      )
    returning
        c.id,
        c.canonical_url,
        c.resolved_url,
        c.host,
        c.source_kind,
        c.title,
        c.excerpt,
        c.author,
        c.published_at,
        c.language_code,
        c.site_name,
        c.cover_image_url,
        c.favicon_bytes,
        c.favicon_mime_type,
        c.favicon_source_url,
        c.favicon_fetched_at,
        c.parsed_document,
        c.parser_name,
        c.parser_version,
        c.parser_quality_score,
        c.parser_recovery,
        c.parser_recovery_status,
        c.parser_recovery_stage,
        c.fetch_etag,
        c.fetch_last_modified,
        c.parser_recovery_attempt_count;
end;
$$;

do $$
begin
    perform pgmq.create('content_render_recovery');
exception
    when duplicate_table then
        null;
end;
$$;

create or replace function public.enqueue_content_render_recovery(
    p_content_id uuid,
    p_trigger text default 'save',
    p_delay_seconds integer default 0,
    p_retry_count integer default 0
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if p_trigger not in ('save', 'retry', 'cron', 'escalate') then
        raise exception 'content render recovery trigger % is invalid', p_trigger;
    end if;

    return pgmq.send(
        queue_name => 'content_render_recovery',
        msg => jsonb_build_object(
            'content_id', p_content_id,
            'trigger', p_trigger,
            'requested_at', timezone('utc', now()),
            'retry_count', greatest(p_retry_count, 0)
        ),
        delay => greatest(p_delay_seconds, 0)
    );
end;
$$;

create or replace function public.dequeue_content_render_recovery(
    p_batch_size integer default 5,
    p_visibility_timeout_seconds integer default 600
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
        queue_name => 'content_render_recovery',
        vt => greatest(p_visibility_timeout_seconds, 1),
        qty => greatest(p_batch_size, 1)
    );
$$;

create or replace function public.archive_content_render_recovery(
    p_msg_id bigint
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
    select pgmq.archive(
        queue_name => 'content_render_recovery',
        msg_id => p_msg_id
    );
$$;

create or replace function public.enqueue_due_content_render_recoveries(
    p_limit integer default 25
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    due_content_id uuid;
    enqueued_count integer := 0;
begin
    for due_content_id in
        select c.id
        from public.content c
        where c.parsed_document is not null
          and c.parse_status = 'succeeded'
          and c.parser_recovery_stage = 'rendered'
          and (
              c.parser_recovery_status in ('needed', 'failed')
              or (
                  c.parser_recovery_status = 'in_progress'
                  and c.parser_recovery_last_attempt_at is not null
                  and c.parser_recovery_last_attempt_at < timezone('utc', now()) - interval '30 minutes'
              )
          )
        order by
            case coalesce(c.parser_recovery->>'priority', 'low')
                when 'high' then 0
                else 1
            end asc,
            coalesce(c.parser_recovery_requested_at, c.parsed_at, c.updated_at) asc,
            c.id asc
        limit greatest(p_limit, 1)
    loop
        perform public.enqueue_content_render_recovery(due_content_id, 'cron', 0, 0);
        enqueued_count := enqueued_count + 1;
    end loop;

    return enqueued_count;
end;
$$;

create or replace function public.claim_content_render_recovery(
    p_content_id uuid,
    p_stale_after_seconds integer default 1800
)
returns table (
    id uuid,
    canonical_url text,
    resolved_url text,
    host text,
    source_kind text,
    title text,
    excerpt text,
    author text,
    published_at timestamptz,
    language_code text,
    site_name text,
    cover_image_url text,
    favicon_bytes bytea,
    favicon_mime_type text,
    favicon_source_url text,
    favicon_fetched_at timestamptz,
    parsed_document jsonb,
    parser_name text,
    parser_version text,
    parser_quality_score integer,
    parser_recovery jsonb,
    parser_recovery_status text,
    parser_recovery_stage text,
    fetch_etag text,
    fetch_last_modified text,
    parser_recovery_attempt_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    return query
    update public.content as c
    set parser_recovery_status = 'in_progress',
        parser_recovery_last_attempt_at = timezone('utc', now()),
        parser_recovery_last_error = null,
        parser_recovery_attempt_count = c.parser_recovery_attempt_count + 1
    where c.id = p_content_id
      and c.parsed_document is not null
      and c.parse_status = 'succeeded'
      and c.parser_recovery_stage = 'rendered'
      and (
          c.parser_recovery_status in ('needed', 'failed')
          or (
              c.parser_recovery_status = 'in_progress'
              and c.parser_recovery_last_attempt_at is not null
              and c.parser_recovery_last_attempt_at < timezone('utc', now()) - make_interval(secs => greatest(p_stale_after_seconds, 1))
          )
      )
    returning
        c.id,
        c.canonical_url,
        c.resolved_url,
        c.host,
        c.source_kind,
        c.title,
        c.excerpt,
        c.author,
        c.published_at,
        c.language_code,
        c.site_name,
        c.cover_image_url,
        c.favicon_bytes,
        c.favicon_mime_type,
        c.favicon_source_url,
        c.favicon_fetched_at,
        c.parsed_document,
        c.parser_name,
        c.parser_version,
        c.parser_quality_score,
        c.parser_recovery,
        c.parser_recovery_status,
        c.parser_recovery_stage,
        c.fetch_etag,
        c.fetch_last_modified,
        c.parser_recovery_attempt_count;
end;
$$;

create or replace function public.invoke_content_render_recovery_processor(
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
        url := project_url || '/functions/v1/process-content-render-recovery-batch',
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

revoke all on function public.enqueue_content_render_recovery(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.dequeue_content_render_recovery(integer, integer) from public, anon, authenticated;
revoke all on function public.archive_content_render_recovery(bigint) from public, anon, authenticated;
revoke all on function public.enqueue_due_content_render_recoveries(integer) from public, anon, authenticated;
revoke all on function public.claim_content_render_recovery(uuid, integer) from public, anon, authenticated;
revoke all on function public.invoke_content_render_recovery_processor(jsonb) from public, anon, authenticated;

grant execute on function public.enqueue_content_render_recovery(uuid, text, integer, integer) to service_role;
grant execute on function public.dequeue_content_render_recovery(integer, integer) to service_role;
grant execute on function public.archive_content_render_recovery(bigint) to service_role;
grant execute on function public.enqueue_due_content_render_recoveries(integer) to service_role;
grant execute on function public.claim_content_render_recovery(uuid, integer) to service_role;
grant execute on function public.invoke_content_render_recovery_processor(jsonb) to service_role;

do $$
begin
    if exists (
        select 1
        from cron.job
        where jobname = 'process-content-render-recovery-batch-every-10-minutes'
    ) then
        perform cron.unschedule('process-content-render-recovery-batch-every-10-minutes');
    end if;

    perform cron.schedule(
        'process-content-render-recovery-batch-every-10-minutes',
        '*/10 * * * *',
        $job$
        select public.invoke_content_render_recovery_processor(jsonb_build_object('trigger', 'cron'));
        $job$
    );
end;
$$;
