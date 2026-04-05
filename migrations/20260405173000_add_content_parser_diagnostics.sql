alter table public.content
    add column parser_diagnostics jsonb;

alter table public.content
    add constraint content_parser_diagnostics_shape check (
        parser_diagnostics is null or jsonb_typeof(parser_diagnostics) = 'object'
    );

comment on column public.content.parser_diagnostics is
    'Bounded parser diagnostics used for internal extraction review and byte-budget triage.';
