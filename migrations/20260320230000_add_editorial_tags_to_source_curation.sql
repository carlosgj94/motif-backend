alter table public.content_sources
    add column if not exists editorial_tags text[] not null default '{}'::text[];

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'content_sources_editorial_tags_one_dimensional'
    ) then
        alter table public.content_sources
            add constraint content_sources_editorial_tags_one_dimensional
            check (
                array_ndims(editorial_tags) is null
                or array_ndims(editorial_tags) = 1
            );
    end if;
end;
$$;

alter table public.source_candidate_reviews
    add column if not exists editorial_tags text[] not null default '{}'::text[];

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'source_candidate_reviews_editorial_tags_one_dimensional'
    ) then
        alter table public.source_candidate_reviews
            add constraint source_candidate_reviews_editorial_tags_one_dimensional
            check (
                array_ndims(editorial_tags) is null
                or array_ndims(editorial_tags) = 1
            );
    end if;
end;
$$;
