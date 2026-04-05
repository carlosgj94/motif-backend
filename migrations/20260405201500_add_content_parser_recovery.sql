alter table public.content
    add column parser_recovery jsonb,
    add column parser_recovery_status text not null default 'none',
    add column parser_recovery_requested_at timestamptz,
    add constraint content_parser_recovery_shape check (
        parser_recovery is null or jsonb_typeof(parser_recovery) = 'object'
    ),
    add constraint content_parser_recovery_status check (
        parser_recovery_status in (
            'none',
            'needed',
            'in_progress',
            'succeeded',
            'failed',
            'dismissed'
        )
    );

create index content_parser_recovery_needed_idx
    on public.content (parsed_at desc, id desc)
    where parser_recovery_status = 'needed';

comment on column public.content.parser_recovery is
    'Bounded recovery decision for low-confidence parses that should go through a stronger fallback path.';
