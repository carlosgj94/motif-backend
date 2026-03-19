drop function if exists public.enqueue_content_processing(uuid, text, integer);

create or replace function public.enqueue_content_processing(
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
    if p_trigger not in ('save', 'retry', 'cron') then
        raise exception 'content processing trigger % is invalid', p_trigger;
    end if;

    return pgmq.send(
        queue_name => 'content_processing',
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

revoke all on function public.enqueue_content_processing(uuid, text, integer, integer)
    from public, anon, authenticated;
grant execute on function public.enqueue_content_processing(uuid, text, integer, integer)
    to service_role;

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
    return public.enqueue_content_processing(
        p_content_id,
        p_trigger,
        p_delay_seconds,
        0
    );
end;
$$;

revoke all on function public.enqueue_content_processing(uuid, text, integer)
    from public, anon, authenticated;
grant execute on function public.enqueue_content_processing(uuid, text, integer)
    to service_role;

drop function if exists public.enqueue_source_refresh(uuid, text, integer);

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
    if p_trigger not in ('subscribe', 'retry', 'cron') then
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

revoke all on function public.enqueue_source_refresh(uuid, text, integer, integer)
    from public, anon, authenticated;
grant execute on function public.enqueue_source_refresh(uuid, text, integer, integer)
    to service_role;

create or replace function public.enqueue_source_refresh(
    p_source_id uuid,
    p_trigger text default 'subscribe',
    p_delay_seconds integer default 0
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    return public.enqueue_source_refresh(
        p_source_id,
        p_trigger,
        p_delay_seconds,
        0
    );
end;
$$;

revoke all on function public.enqueue_source_refresh(uuid, text, integer)
    from public, anon, authenticated;
grant execute on function public.enqueue_source_refresh(uuid, text, integer)
    to service_role;

drop index if exists public.source_feeds_feed_url_unique_idx;

create unique index if not exists source_feeds_source_feed_url_unique_idx
    on public.source_feeds (source_id, feed_url);
