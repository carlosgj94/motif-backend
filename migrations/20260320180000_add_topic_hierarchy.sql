alter table public.topics
    add column parent_topic_id uuid references public.topics (id) on delete cascade,
    add column display_order integer not null default 0,
    add constraint topics_display_order_nonnegative check (display_order >= 0),
    add constraint topics_no_self_parent check (parent_topic_id is null or parent_topic_id <> id);

create index topics_parent_display_order_idx
    on public.topics (parent_topic_id, display_order, label, slug);

create table public.topic_closure (
    ancestor_topic_id uuid not null references public.topics (id) on delete cascade,
    descendant_topic_id uuid not null references public.topics (id) on delete cascade,
    depth integer not null,
    primary key (ancestor_topic_id, descendant_topic_id),
    constraint topic_closure_depth_nonnegative check (depth >= 0)
);

create index topic_closure_descendant_ancestor_idx
    on public.topic_closure (descendant_topic_id, ancestor_topic_id, depth);

alter table public.topic_closure enable row level security;

create or replace function public.rebuild_topic_closure()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    delete from public.topic_closure;

    insert into public.topic_closure (
        ancestor_topic_id,
        descendant_topic_id,
        depth
    )
    with recursive topic_tree as (
        select
            t.id as ancestor_topic_id,
            t.id as descendant_topic_id,
            0 as depth
        from public.topics t

        union all

        select
            tree.ancestor_topic_id,
            child.id as descendant_topic_id,
            tree.depth + 1 as depth
        from topic_tree tree
        join public.topics child
          on child.parent_topic_id = tree.descendant_topic_id
    )
    select
        ancestor_topic_id,
        descendant_topic_id,
        depth
    from topic_tree;
end;
$$;

create or replace function public.ensure_topic_hierarchy_is_acyclic()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    if new.parent_topic_id is null then
        return new;
    end if;

    if new.parent_topic_id = new.id then
        raise exception 'topic cannot be its own parent';
    end if;

    if exists (
        with recursive parent_chain as (
            select t.parent_topic_id
            from public.topics t
            where t.id = new.parent_topic_id

            union all

            select t.parent_topic_id
            from public.topics t
            join parent_chain pc on pc.parent_topic_id = t.id
            where pc.parent_topic_id is not null
        )
        select 1
        from parent_chain
        where parent_topic_id = new.id
    ) then
        raise exception 'topic hierarchy cannot contain cycles';
    end if;

    return new;
end;
$$;

create or replace function public.refresh_topic_closure()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.rebuild_topic_closure();
    return null;
end;
$$;

drop trigger if exists topics_ensure_hierarchy_acyclic on public.topics;
create trigger topics_ensure_hierarchy_acyclic
before insert or update of parent_topic_id on public.topics
for each row
execute function public.ensure_topic_hierarchy_is_acyclic();

drop trigger if exists topics_refresh_topic_closure on public.topics;
create trigger topics_refresh_topic_closure
after insert or update of parent_topic_id or delete on public.topics
for each statement
execute function public.refresh_topic_closure();

with root_topics (slug, label, description, display_order) as (
    values
        ('technology', 'Technology', 'Software, hardware, AI, and engineering', 10),
        ('science', 'Science', 'Research, discovery, and the natural sciences', 20),
        ('society', 'Society', 'Social issues, institutions, and communities', 30),
        ('business', 'Business', 'Companies, markets, and strategy', 40),
        ('design', 'Design', 'Product, visual, and interaction design', 50),
        ('culture', 'Culture', 'Arts, media, and cultural commentary', 60),
        ('politics', 'Politics', 'Governance, policy, and public affairs', 70),
        ('health', 'Health', 'Medicine, wellbeing, and public health', 80),
        ('finance', 'Finance', 'Investing, economics, and personal finance', 90),
        ('sports', 'Sports', 'Competitive sports, teams, and athletic culture', 100)
)
insert into public.topics (
    slug,
    label,
    description,
    parent_topic_id,
    display_order
)
select
    root.slug,
    root.label,
    root.description,
    null,
    root.display_order
from root_topics root
on conflict (slug) do update
set label = excluded.label,
    description = excluded.description,
    parent_topic_id = null,
    display_order = excluded.display_order;

with subtopics (parent_slug, slug, label, description, display_order) as (
    values
        ('technology', 'programming', 'Programming', 'Software engineering, languages, tooling, and developer workflows', 10),
        ('technology', 'artificial-intelligence', 'Artificial Intelligence', 'Machine learning, models, agents, and AI products', 20),
        ('technology', 'devices', 'Devices', 'Phones, laptops, consoles, wearables, and consumer hardware', 30),
        ('technology', 'semiconductors', 'Semiconductors', 'Chips, foundries, GPUs, and hardware manufacturing', 40),
        ('technology', 'internet', 'Internet', 'Web platforms, protocols, infrastructure, and online services', 50),

        ('science', 'physics', 'Physics', 'Physics, energy, and the laws of matter', 10),
        ('science', 'biology', 'Biology', 'Life sciences, genetics, and organisms', 20),
        ('science', 'space', 'Space', 'Astronomy, aerospace, and planetary science', 30),
        ('science', 'climate', 'Climate', 'Climate science, weather, and the environment', 40),
        ('science', 'mathematics', 'Mathematics', 'Mathematics, statistics, and formal reasoning', 50),

        ('society', 'education', 'Education', 'Learning, schools, universities, and pedagogy', 10),
        ('society', 'history', 'History', 'Historical analysis, archives, and long-term change', 20),
        ('society', 'philosophy', 'Philosophy', 'Ethics, ideas, and philosophical inquiry', 30),
        ('society', 'urbanism', 'Urbanism', 'Cities, housing, transport, and civic life', 40),
        ('society', 'labor', 'Labor', 'Work, careers, labor markets, and workplace culture', 50),

        ('business', 'startups', 'Startups', 'Early-stage companies, venture, and founders', 10),
        ('business', 'strategy', 'Strategy', 'Competition, market positioning, and business models', 20),
        ('business', 'management', 'Management', 'Leadership, org design, and execution', 30),
        ('business', 'media-business', 'Media Business', 'Publishing, creator economics, and media strategy', 40),
        ('business', 'retail', 'Retail', 'Commerce, logistics, and consumer markets', 50),

        ('design', 'product-design', 'Product Design', 'Product thinking, flows, systems, and usability', 10),
        ('design', 'visual-design', 'Visual Design', 'Graphic design, branding, and visual systems', 20),
        ('design', 'interaction-design', 'Interaction Design', 'Interfaces, motion, and behavior design', 30),
        ('design', 'industrial-design', 'Industrial Design', 'Physical products, manufacturing, and ergonomics', 40),
        ('design', 'typography', 'Typography', 'Type, readability, and editorial design', 50),

        ('culture', 'books', 'Books', 'Books, essays, criticism, and literature', 10),
        ('culture', 'film-tv', 'Film & TV', 'Cinema, television, and screen storytelling', 20),
        ('culture', 'music', 'Music', 'Music, audio culture, and criticism', 30),
        ('culture', 'art', 'Art', 'Visual arts, museums, and creative practice', 40),
        ('culture', 'food', 'Food', 'Cooking, restaurants, and food culture', 50),

        ('politics', 'public-policy', 'Public Policy', 'Policy design, public administration, and government action', 10),
        ('politics', 'geopolitics', 'Geopolitics', 'International relations, conflict, and global power', 20),
        ('politics', 'law', 'Law', 'Courts, legal systems, rights, and regulation', 30),
        ('politics', 'elections', 'Elections', 'Campaigns, voting, and electoral politics', 40),
        ('politics', 'local-government', 'Local Government', 'Municipal politics, local policy, and civic administration', 50),

        ('health', 'medicine', 'Medicine', 'Clinical medicine, treatments, and healthcare systems', 10),
        ('health', 'mental-health', 'Mental Health', 'Psychology, psychiatry, and emotional wellbeing', 20),
        ('health', 'nutrition', 'Nutrition', 'Diet, metabolism, and nutritional science', 30),
        ('health', 'fitness', 'Fitness', 'Training, strength, endurance, and physical performance', 40),
        ('health', 'public-health', 'Public Health', 'Population health, epidemiology, and prevention', 50),

        ('finance', 'investing', 'Investing', 'Public markets, portfolio strategy, and asset allocation', 10),
        ('finance', 'macroeconomics', 'Macroeconomics', 'Rates, inflation, growth, and economic systems', 20),
        ('finance', 'personal-finance', 'Personal Finance', 'Saving, budgeting, taxes, and household money', 30),
        ('finance', 'crypto', 'Crypto', 'Blockchains, digital assets, and crypto markets', 40),
        ('finance', 'banking', 'Banking', 'Banks, credit, payments, and financial infrastructure', 50),

        ('sports', 'football', 'Football', 'Association football, leagues, clubs, and tactics', 10),
        ('sports', 'basketball', 'Basketball', 'Basketball leagues, teams, and analysis', 20),
        ('sports', 'tennis', 'Tennis', 'Professional tennis, tournaments, and player coverage', 30),
        ('sports', 'motorsports', 'Motorsports', 'Formula 1, endurance racing, and motorsport culture', 40),
        ('sports', 'cycling', 'Cycling', 'Road cycling, racing, and cycling culture', 50)
)
insert into public.topics (
    slug,
    label,
    description,
    parent_topic_id,
    display_order
)
select
    child.slug,
    child.label,
    child.description,
    parent_topic.id,
    child.display_order
from subtopics child
join public.topics parent_topic on parent_topic.slug = child.parent_slug
on conflict (slug) do update
set label = excluded.label,
    description = excluded.description,
    parent_topic_id = excluded.parent_topic_id,
    display_order = excluded.display_order;

select public.rebuild_topic_closure();

create or replace function public.rebuild_user_topic_affinity(
    p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    delete from public.user_topic_affinity
    where user_id = p_user_id;

    insert into public.user_topic_affinity (
        user_id,
        topic_id,
        score,
        signals,
        last_interacted_at
    )
    with preference_topics as (
        select
            p_user_id as user_id,
            tc.descendant_topic_id as topic_id,
            sum(utp.weight * 2.0 * power(0.8::double precision, tc.depth::double precision)) as score,
            count(*)::integer as signals,
            timezone('utc', now()) as last_interacted_at
        from public.user_topic_preferences utp
        join public.topic_closure tc
          on tc.ancestor_topic_id = utp.topic_id
        where utp.user_id = p_user_id
        group by tc.descendant_topic_id
    ),
    content_topics as (
        select
            p_user_id as user_id,
            tc.ancestor_topic_id as topic_id,
            sum(
                ucf.score
                * ct.confidence
                * power(0.7::double precision, tc.depth::double precision)
                * exp(
                    -ln(2.0)
                    * greatest(
                        extract(epoch from (timezone('utc', now()) - ucf.last_interacted_at)) / 86400.0,
                        0
                    )
                    / 30.0
                )
            ) as score,
            count(*)::integer as signals,
            max(ucf.last_interacted_at) as last_interacted_at
        from public.user_content_feedback ucf
        join public.content_topics ct on ct.content_id = ucf.content_id
        join public.topic_closure tc
          on tc.descendant_topic_id = ct.topic_id
        where ucf.user_id = p_user_id
          and ucf.last_interacted_at is not null
        group by tc.ancestor_topic_id
    ),
    source_affinity_topics as (
        select
            p_user_id as user_id,
            tc.ancestor_topic_id as topic_id,
            sum(
                usa.score
                * st.confidence
                * power(0.75::double precision, tc.depth::double precision)
            ) as score,
            count(*)::integer as signals,
            max(usa.last_interacted_at) as last_interacted_at
        from public.user_source_affinity usa
        join public.source_topics st on st.source_id = usa.source_id
        join public.topic_closure tc
          on tc.descendant_topic_id = st.topic_id
        where usa.user_id = p_user_id
        group by tc.ancestor_topic_id
    ),
    combined as (
        select * from preference_topics
        union all
        select * from content_topics
        union all
        select * from source_affinity_topics
    )
    select
        p_user_id,
        topic_id,
        sum(score),
        sum(signals),
        max(last_interacted_at)
    from combined
    group by topic_id;
end;
$$;

revoke all on table public.topic_closure from public, anon, authenticated;
grant all on table public.topic_closure to service_role;

revoke all on function public.rebuild_topic_closure() from public, anon, authenticated;
revoke all on function public.ensure_topic_hierarchy_is_acyclic() from public, anon, authenticated;
revoke all on function public.refresh_topic_closure() from public, anon, authenticated;

grant execute on function public.rebuild_topic_closure() to service_role;
grant execute on function public.ensure_topic_hierarchy_is_acyclic() to service_role;
grant execute on function public.refresh_topic_closure() to service_role;
