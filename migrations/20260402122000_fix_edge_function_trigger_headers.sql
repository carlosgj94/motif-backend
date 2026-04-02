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
    auth_token text;
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
    into auth_token
    from vault.decrypted_secrets
    where name in ('anon_key', 'service_role_key')
    order by
        case name
            when 'anon_key' then 0
            when 'service_role_key' then 1
            else 2
        end,
        created_at desc
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
        or coalesce(auth_token, '') = ''
        or coalesce(processor_secret, '') = '' then
        return null;
    end if;

    return net.http_post(
        url := project_url || '/functions/v1/process-content-batch',
        headers := jsonb_build_object('Content-Type', 'application/json')
            || case
                when coalesce(publishable_key, '') = '' then '{}'::jsonb
                else jsonb_build_object('apikey', publishable_key)
            end
            || jsonb_build_object(
                'Authorization', 'Bearer ' || auth_token,
                'x-content-processor-secret', processor_secret
            ),
        body := coalesce(p_payload, '{}'::jsonb),
        timeout_milliseconds := 5000
    );
end;
$$;

create or replace function public.invoke_source_processor(
    p_payload jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    project_url text;
    auth_token text;
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
    into auth_token
    from vault.decrypted_secrets
    where name in ('anon_key', 'service_role_key')
    order by
        case name
            when 'anon_key' then 0
            when 'service_role_key' then 1
            else 2
        end,
        created_at desc
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
        or coalesce(auth_token, '') = ''
        or coalesce(processor_secret, '') = '' then
        return null;
    end if;

    return net.http_post(
        url := project_url || '/functions/v1/process-source-batch',
        headers := jsonb_build_object('Content-Type', 'application/json')
            || case
                when coalesce(publishable_key, '') = '' then '{}'::jsonb
                else jsonb_build_object('apikey', publishable_key)
            end
            || jsonb_build_object(
                'Authorization', 'Bearer ' || auth_token,
                'x-content-processor-secret', processor_secret
            ),
        body := coalesce(p_payload, '{}'::jsonb),
        timeout_milliseconds := 5000
    );
end;
$$;
