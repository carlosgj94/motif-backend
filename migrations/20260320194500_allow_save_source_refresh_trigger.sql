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
    if p_trigger not in ('subscribe', 'save', 'retry', 'cron') then
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
