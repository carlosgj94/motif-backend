create or replace function public.rebuild_user_content_feedback(
    p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    delete from public.user_content_feedback
    where user_id = p_user_id;

    insert into public.user_content_feedback (
        user_id,
        content_id,
        source_id,
        impression_count,
        open_count,
        heartbeat_count,
        dismiss_count,
        save_count,
        favorite_count,
        mark_read_count,
        total_visible_ms,
        last_interacted_at,
        read_ratio,
        score
    )
    select
        p_user_id,
        d.content_id,
        coalesce(
            (array_agg(d.source_id) filter (where d.source_id is not null))[1],
            c.source_id
        ),
        sum(d.impression_count)::integer,
        sum(d.open_count)::integer,
        sum(d.heartbeat_count)::integer,
        sum(d.dismiss_count)::integer,
        sum(d.save_count)::integer,
        sum(d.favorite_count)::integer,
        sum(d.mark_read_count)::integer,
        sum(d.total_visible_ms)::bigint,
        max(d.last_interacted_at),
        least(
            sum(d.total_visible_ms)::double precision
                / greatest(coalesce(max(c.estimated_read_seconds), 1) * 1000, 1000),
            1.5
        ),
        least(
            greatest(
                (least(sum(d.open_count)::double precision, 1.0) * 0.20)
                + (
                    least(
                        sum(d.total_visible_ms)::double precision
                            / greatest(coalesce(max(c.estimated_read_seconds), 1) * 1000, 1000),
                        1.5
                    ) * 0.60
                )
                + (least(sum(d.save_count)::double precision, 1.0) * 0.40)
                + (least(sum(d.favorite_count)::double precision, 1.0) * 0.30)
                + (least(sum(d.mark_read_count)::double precision, 1.0) * 0.40)
                - (least(sum(d.dismiss_count)::double precision, 1.0) * 0.50),
                -1.0
            ),
            2.0
        )
    from public.user_content_feedback_daily d
    left join public.content c on c.id = d.content_id
    where d.user_id = p_user_id
      and d.signal_date >= current_date - 90
    group by d.content_id, c.source_id
    having
        sum(d.impression_count)
        + sum(d.open_count)
        + sum(d.heartbeat_count)
        + sum(d.dismiss_count)
        + sum(d.save_count)
        + sum(d.favorite_count)
        + sum(d.mark_read_count) > 0;
end;
$$;
