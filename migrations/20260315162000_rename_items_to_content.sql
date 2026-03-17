alter table public.content_items rename to content;
alter table public.saved_items rename to saved_content;
alter table public.saved_item_tags rename to saved_content_tags;

alter table public.saved_content rename column content_item_id to content_id;
alter table public.saved_content_tags rename column saved_item_id to saved_content_id;

alter table public.content rename constraint content_items_pkey to content_pkey;
alter table public.content rename constraint content_items_canonical_url_not_blank to content_canonical_url_not_blank;
alter table public.content rename constraint content_items_host_not_blank to content_host_not_blank;
alter table public.content rename constraint content_items_source_kind_not_blank to content_source_kind_not_blank;
alter table public.content rename constraint content_items_language_code_length to content_language_code_length;
alter table public.content rename constraint content_items_parser_name_not_blank to content_parser_name_not_blank;
alter table public.content rename constraint content_items_parser_version_not_blank to content_parser_version_not_blank;
alter table public.content rename constraint content_items_favicon_pair to content_favicon_pair;
alter table public.content rename constraint content_items_parsed_document_shape to content_parsed_document_shape;
alter table public.content rename constraint content_items_fetch_status to content_fetch_status;
alter table public.content rename constraint content_items_parse_status to content_parse_status;
alter table public.content rename constraint content_items_last_http_status_range to content_last_http_status_range;

alter table public.saved_content rename constraint saved_items_pkey to saved_content_pkey;
alter table public.saved_content rename constraint saved_items_user_id_fkey to saved_content_user_id_fkey;
alter table public.saved_content rename constraint saved_items_content_item_id_fkey to saved_content_content_id_fkey;
alter table public.saved_content rename constraint saved_items_submitted_url_not_blank to saved_content_submitted_url_not_blank;
alter table public.saved_content rename constraint saved_items_read_state to saved_content_read_state;

alter table public.saved_content_tags rename constraint saved_item_tags_pkey to saved_content_tags_pkey;
alter table public.saved_content_tags rename constraint saved_item_tags_saved_item_id_fkey to saved_content_tags_saved_content_id_fkey;
alter table public.saved_content_tags rename constraint saved_item_tags_tag_id_fkey to saved_content_tags_tag_id_fkey;

alter index public.content_items_canonical_url_unique_idx rename to content_canonical_url_unique_idx;
alter index public.content_items_host_idx rename to content_host_idx;
alter index public.content_items_fetch_status_idx rename to content_fetch_status_idx;
alter index public.content_items_parse_status_idx rename to content_parse_status_idx;
alter index public.saved_items_user_content_unique_idx rename to saved_content_user_content_unique_idx;
alter index public.saved_items_user_updated_idx rename to saved_content_user_updated_idx;
alter index public.saved_items_content_item_idx rename to saved_content_content_idx;
alter index public.saved_item_tags_tag_idx rename to saved_content_tags_tag_idx;

create or replace function public.validate_saved_content_tag_scope()
returns trigger
language plpgsql
as $$
declare
    saved_content_user_id uuid;
    tag_owner_user_id uuid;
    tag_scope text;
begin
    select user_id
    into saved_content_user_id
    from public.saved_content
    where id = new.saved_content_id;

    select owner_user_id, scope
    into tag_owner_user_id, tag_scope
    from public.tags
    where id = new.tag_id;

    if tag_scope is null then
        raise exception 'tag % does not exist', new.tag_id;
    end if;

    if saved_content_user_id is null then
        raise exception 'saved content % does not exist', new.saved_content_id;
    end if;

    if tag_scope = 'custom' and tag_owner_user_id <> saved_content_user_id then
        raise exception 'custom tags may only be attached to the owning user''s saved content';
    end if;

    return new;
end;
$$;

drop trigger if exists content_items_set_updated_at on public.content;

create trigger content_set_updated_at
before update on public.content
for each row
execute function public.set_current_timestamp_updated_at();

drop trigger if exists saved_items_set_updated_at on public.saved_content;

create trigger saved_content_set_updated_at
before update on public.saved_content
for each row
execute function public.set_current_timestamp_updated_at();

drop trigger if exists saved_item_tags_validate_scope on public.saved_content_tags;

create trigger saved_content_tags_validate_scope
before insert or update on public.saved_content_tags
for each row
execute function public.validate_saved_content_tag_scope();

drop function if exists public.validate_saved_item_tag_scope();
