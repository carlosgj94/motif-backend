create extension if not exists pgmq;
create extension if not exists pg_net;
create extension if not exists pg_cron;

alter table public.content
    add column if not exists fetch_attempt_count integer not null default 0,
    add column if not exists parse_attempt_count integer not null default 0;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'content_fetch_attempt_count_nonnegative'
    ) then
        alter table public.content
            add constraint content_fetch_attempt_count_nonnegative
            check (fetch_attempt_count >= 0);
    end if;

    if not exists (
        select 1
        from pg_constraint
        where conname = 'content_parse_attempt_count_nonnegative'
    ) then
        alter table public.content
            add constraint content_parse_attempt_count_nonnegative
            check (parse_attempt_count >= 0);
    end if;
end;
$$;

do $$
begin
    perform pgmq.create('content_processing');
exception
    when duplicate_table then
        null;
end;
$$;

create or replace function public.enqueue_content_processing(
    p_content_id uuid,
    p_trigger text default 'save',
    p_delay_seconds integer default 0
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if p_trigger not in ('save', 'retry', 'cron') then
        raise exception 'content processing trigger % is invalid', p_trigger;
    end if;

    return pgmq.send(
        queue_name => 'content_processing',
        msg => jsonb_build_object(
            'content_id', p_content_id,
            'trigger', p_trigger,
            'requested_at', timezone('utc', now())
        ),
        delay => greatest(p_delay_seconds, 0)
    );
end;
$$;

create or replace function public.dequeue_content_processing(
    p_batch_size integer default 10,
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
        queue_name => 'content_processing',
        vt => greatest(p_visibility_timeout_seconds, 1),
        qty => greatest(p_batch_size, 1)
    );
$$;

create or replace function public.archive_content_processing(
    p_msg_id bigint
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
    select pgmq.archive(
        queue_name => 'content_processing',
        msg_id => p_msg_id
    );
$$;

create or replace function public.claim_content_processing(
    p_content_id uuid,
    p_stale_after_seconds integer default 900
)
returns table (
    id uuid,
    canonical_url text,
    resolved_url text,
    host text,
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
        c.fetch_attempt_count,
        c.parse_attempt_count;
end;
$$;

create or replace function public.invoke_content_processor(
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
        url := project_url || '/functions/v1/process-content-batch',
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

revoke all on function public.enqueue_content_processing(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.dequeue_content_processing(integer, integer) from public, anon, authenticated;
revoke all on function public.archive_content_processing(bigint) from public, anon, authenticated;
revoke all on function public.claim_content_processing(uuid, integer) from public, anon, authenticated;
revoke all on function public.invoke_content_processor(jsonb) from public, anon, authenticated;

grant execute on function public.enqueue_content_processing(uuid, text, integer) to service_role;
grant execute on function public.dequeue_content_processing(integer, integer) to service_role;
grant execute on function public.archive_content_processing(bigint) to service_role;
grant execute on function public.claim_content_processing(uuid, integer) to service_role;
grant execute on function public.invoke_content_processor(jsonb) to service_role;

do $$
begin
    if exists (
        select 1
        from cron.job
        where jobname = 'process-content-batch-every-minute'
    ) then
        perform cron.unschedule('process-content-batch-every-minute');
    end if;

    perform cron.schedule(
        'process-content-batch-every-minute',
        '* * * * *',
        $job$
        select public.invoke_content_processor(jsonb_build_object('trigger', 'cron'));
        $job$
    );
end;
$$;
