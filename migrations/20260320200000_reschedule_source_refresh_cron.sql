do $$
begin
    if exists (
        select 1
        from cron.job
        where jobname = 'process-source-batch-every-minute'
    ) then
        perform cron.unschedule('process-source-batch-every-minute');
    end if;

    if exists (
        select 1
        from cron.job
        where jobname = 'process-source-batch-every-30-minutes'
    ) then
        perform cron.unschedule('process-source-batch-every-30-minutes');
    end if;

    perform cron.schedule(
        'process-source-batch-every-30-minutes',
        '*/30 * * * *',
        $job$
        select public.invoke_source_processor(jsonb_build_object('trigger', 'cron'));
        $job$
    );
end;
$$;
