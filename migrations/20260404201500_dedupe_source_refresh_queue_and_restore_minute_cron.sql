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
declare
    existing_msg_id bigint;
begin
    if p_trigger not in ('subscribe', 'save', 'seed', 'retry', 'cron') then
        raise exception 'source refresh trigger % is invalid', p_trigger;
    end if;

    select q.msg_id
    into existing_msg_id
    from pgmq.q_source_refresh q
    where (q.message->>'source_id')::uuid = p_source_id
    order by q.msg_id desc
    limit 1;

    if existing_msg_id is not null then
        return existing_msg_id;
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

create or replace function public.enqueue_due_source_refreshes(
    p_limit integer default 50
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    due_source_id uuid;
    enqueued_count integer := 0;
begin
    for due_source_id in
        select cs.id
        from public.content_sources cs
        where (
            cs.next_refresh_at is null
            or cs.next_refresh_at <= timezone('utc', now())
            or exists (
                select 1
                from public.source_subscriptions ss
                where ss.source_id = cs.id
                  and ss.last_backfilled_at is null
            )
        )
          and not (
              cs.refresh_status = 'in_progress'
              and cs.last_refresh_attempt_at is not null
              and cs.last_refresh_attempt_at >= timezone('utc', now()) - interval '15 minutes'
          )
          and not exists (
              select 1
              from pgmq.q_source_refresh q
              where (q.message->>'source_id')::uuid = cs.id
          )
        order by coalesce(cs.next_refresh_at, timezone('utc', now())) asc, cs.created_at asc
        limit greatest(p_limit, 1)
    loop
        perform public.enqueue_source_refresh(due_source_id, 'cron', 0, 0);
        enqueued_count := enqueued_count + 1;
    end loop;

    return enqueued_count;
end;
$$;

do $$
begin
    if exists (
        select 1
        from cron.job
        where jobname = 'process-source-batch-every-30-minutes'
    ) then
        perform cron.unschedule('process-source-batch-every-30-minutes');
    end if;

    if exists (
        select 1
        from cron.job
        where jobname = 'process-source-batch-every-minute'
    ) then
        perform cron.unschedule('process-source-batch-every-minute');
    end if;

    perform cron.schedule(
        'process-source-batch-every-minute',
        '* * * * *',
        $job$
        select public.invoke_source_processor(jsonb_build_object('trigger', 'cron'));
        $job$
    );
end;
$$;
