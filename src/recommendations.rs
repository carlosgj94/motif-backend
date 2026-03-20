use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
};

use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool, Postgres, QueryBuilder, Transaction, types::Json as SqlxJson};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedUser,
    content::{ProcessingStatus, SourceKind, normalize_tag_slug},
    embedded_content::{
        CompactContentBody, build_compact_content_body, maybe_timestamp_seconds,
        parse_db_processing_status, parse_optional_source_kind,
    },
    error::{ApiError, ApiResult},
};

const DEFAULT_RECOMMENDATION_LIMIT: u32 = 20;
const MAX_RECOMMENDATION_LIMIT: u32 = 50;
const MAX_BATCH_EVENT_COUNT: usize = 50;
const MAX_TOPIC_PREFERENCES: usize = 16;
const MAX_LANGUAGE_PREFERENCES: usize = 8;
const IMMEDIATE_RECOMMENDATION_ROLLUP_LIMIT: i32 = 10_000;
const RECOMMENDATION_ALGORITHM_VERSION: &str = "v1-postgres-hybrid";

pub async fn list_content_recommendations(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Query(query): Query<ListRecommendationsQuery>,
) -> ApiResult<Json<ContentRecommendationListResponse>> {
    let limit = normalize_recommendation_limit(query.limit)?;
    let user_context = load_user_recommendation_context(&state.pool, user.user_id).await?;
    let candidate_rows =
        fetch_content_recommendation_candidate_rows(&state.pool, user.user_id).await?;

    let mut scored = candidate_rows
        .into_iter()
        .filter_map(|row| {
            if row.dismiss_count > 0 {
                return None;
            }

            let topic_match = normalize_positive_score(row.topic_score);
            let source_affinity = normalize_positive_score(row.source_affinity_score);
            let content_halo = row.content_halo_score;
            let source_halo = row.source_halo_score;
            let freshness = freshness_score(row.published_at.unwrap_or(row.created_at), 30.0);
            let subscribed_inbox_boost = if row.subscribed_inbox
                || row.source_id.is_some_and(|source_id| {
                    user_context.subscribed_source_ids.contains(&source_id)
                }) {
                1.0
            } else {
                0.0
            };
            let exploration_boost = if !subscribed_inbox_boost.eq(&1.0) {
                1.0
            } else {
                0.0
            };
            let repeat_penalty = repeat_penalty(&row);
            let final_score = (0.30 * topic_match)
                + (0.20 * source_affinity)
                + (0.15 * content_halo)
                + (0.10 * source_halo)
                + (0.10 * freshness)
                + (0.10 * subscribed_inbox_boost)
                + (0.05 * exploration_boost)
                - repeat_penalty;
            let primary_topic_slug = row.primary_topic_slug.clone();
            let bucket_breakdown = json!({
                "subscribed_inbox": row.subscribed_inbox,
                "discovery": row.discovery,
                "saved_adjacent": row.saved_adjacent,
                "trending": row.trending,
            });

            Some(ScoredContentCandidate {
                row,
                primary_topic_slug,
                score: final_score.max(0.0),
                score_breakdown: json!({
                    "topic_affinity": topic_match,
                    "source_affinity": source_affinity,
                    "content_halo": content_halo,
                    "source_halo": source_halo,
                    "freshness": freshness,
                    "subscribed_inbox_boost": subscribed_inbox_boost,
                    "exploration_boost": exploration_boost,
                    "repeat_penalty": repeat_penalty,
                    "buckets": bucket_breakdown,
                }),
            })
        })
        .collect::<Vec<_>>();

    scored.sort_by(|left, right| right.score.total_cmp(&left.score));
    let selected = apply_content_diversity(scored, limit as usize);
    let serve_id = persist_content_recommendation_serve(
        &state.pool,
        user.user_id,
        limit,
        &selected,
        user_context.preferred_languages.clone(),
    )
    .await?;

    let content = selected
        .into_iter()
        .enumerate()
        .map(|(index, candidate)| {
            build_content_recommendation_item(index, candidate, &user_context)
        })
        .collect::<ApiResult<Vec<_>>>()?;

    Ok(Json(ContentRecommendationListResponse {
        serve_id,
        content,
    }))
}

pub async fn list_source_recommendations(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Query(query): Query<ListRecommendationsQuery>,
) -> ApiResult<Json<SourceRecommendationListResponse>> {
    let limit = normalize_recommendation_limit(query.limit)?;
    let user_context = load_user_recommendation_context(&state.pool, user.user_id).await?;
    let source_rows = fetch_source_recommendation_candidate_rows(&state.pool, user.user_id).await?;

    let mut scored = source_rows
        .into_iter()
        .filter(|row| !user_context.subscribed_source_ids.contains(&row.source_id))
        .map(|row| {
            let topic_match = normalize_positive_score(row.topic_score);
            let source_halo = row.source_halo_score;
            let recent_activity_score = normalize_recent_activity(row.recent_activity_count);
            let similarity = row.similarity_score;
            let exploration_diversity = 1.0;
            let final_score = (0.40 * topic_match)
                + (0.20 * source_halo)
                + (0.15 * similarity)
                + (0.15 * recent_activity_score)
                + (0.10 * exploration_diversity);
            let primary_topic_slug = row.primary_topic_slug.clone();

            ScoredSourceCandidate {
                row,
                primary_topic_slug,
                score: final_score.max(0.0),
                score_breakdown: json!({
                    "topic_match": topic_match,
                    "source_halo": source_halo,
                    "similarity_to_engaged_sources": similarity,
                    "recent_activity": recent_activity_score,
                    "exploration_diversity": exploration_diversity,
                }),
            }
        })
        .collect::<Vec<_>>();

    scored.sort_by(|left, right| right.score.total_cmp(&left.score));
    let selected = apply_source_diversity(scored, limit as usize);
    let serve_id = persist_source_recommendation_serve(
        &state.pool,
        user.user_id,
        limit,
        &selected,
        user_context.preferred_languages.clone(),
    )
    .await?;

    let sources = selected
        .into_iter()
        .enumerate()
        .map(|(index, candidate)| build_source_recommendation_item(index, candidate))
        .collect::<ApiResult<Vec<_>>>()?;

    Ok(Json(SourceRecommendationListResponse { serve_id, sources }))
}

pub async fn preview_source_recommendations(
    State(state): State<AppState>,
    Json(payload): Json<PublicSourceRecommendationsRequest>,
) -> ApiResult<Json<PublicSourceRecommendationListResponse>> {
    let limit = normalize_recommendation_limit(payload.limit)?;
    let validated_preferences = validate_recommendation_preferences(
        &state.pool,
        &payload.topic_slugs,
        &payload.language_codes,
    )
    .await?;
    if validated_preferences.topic_ids.is_empty() {
        return Err(ApiError::bad_request(
            "At least one topic slug must be provided",
        ));
    }

    let mut scored = fetch_public_source_recommendation_candidate_rows(
        &state.pool,
        &validated_preferences.topic_ids,
        &validated_preferences.language_codes,
    )
    .await?
    .into_iter()
    .map(|row| {
        let topic_match = normalize_positive_score(row.topic_score);
        let source_halo = row.source_halo_score;
        let recent_activity = normalize_recent_activity(row.recent_activity_count);
        let final_score = (0.60 * topic_match) + (0.25 * source_halo) + (0.15 * recent_activity);
        let primary_topic_slug = row.primary_topic_slug.clone();

        ScoredSourceCandidate {
            row,
            primary_topic_slug,
            score: final_score.max(0.0),
            score_breakdown: json!({
                "topic_match": topic_match,
                "source_halo": source_halo,
                "recent_activity": recent_activity,
            }),
        }
    })
    .collect::<Vec<_>>();

    scored.sort_by(|left, right| right.score.total_cmp(&left.score));
    let selected = apply_source_diversity(scored, limit as usize);
    let sources = selected
        .into_iter()
        .enumerate()
        .map(|(index, candidate)| build_public_source_recommendation_item(index, candidate))
        .collect::<ApiResult<Vec<_>>>()?;

    Ok(Json(PublicSourceRecommendationListResponse { sources }))
}

pub async fn get_content_detail(
    _user: AuthenticatedUser,
    State(state): State<AppState>,
    Path(content_id): Path<Uuid>,
) -> ApiResult<Json<RecommendationContentDetail>> {
    let row = sqlx::query_as::<_, RecommendationContentDetailRow>(
        r#"
        select
            c.id as content_id,
            c.canonical_url,
            c.resolved_url,
            c.host,
            c.site_name,
            c.source_kind,
            c.title,
            c.excerpt,
            c.author,
            c.published_at,
            c.language_code,
            (c.favicon_bytes is not null and c.favicon_mime_type is not null) as has_favicon,
            c.fetch_status,
            c.parse_status,
            c.parsed_at,
            c.parsed_document
        from public.content c
        where c.id = $1
        "#,
    )
    .bind(content_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(map_recommendation_error)?
    .ok_or_else(|| ApiError::not_found("Content was not found"))?;

    build_content_detail(row).map(Json)
}

pub async fn ingest_interaction_events_batch(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Json(payload): Json<InteractionEventBatchRequest>,
) -> ApiResult<Json<InteractionEventBatchResponse>> {
    if payload.events.is_empty() {
        return Err(ApiError::bad_request("At least one event must be provided"));
    }
    if payload.events.len() > MAX_BATCH_EVENT_COUNT {
        return Err(ApiError::bad_request("Too many events were provided"));
    }

    let events = payload
        .events
        .into_iter()
        .map(validate_public_interaction_event)
        .collect::<ApiResult<Vec<_>>>()?;

    validate_public_interaction_targets(&state.pool, &events).await?;

    let mut transaction = state.pool.begin().await.map_err(map_recommendation_error)?;
    let inserted =
        insert_public_interaction_events(&mut transaction, user.user_id, &events).await?;
    transaction
        .commit()
        .await
        .map_err(map_recommendation_error)?;

    Ok(Json(InteractionEventBatchResponse {
        accepted: inserted,
        received: events.len() as u32,
    }))
}

pub async fn update_recommendation_preferences(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Json(payload): Json<UpdateRecommendationPreferencesRequest>,
) -> ApiResult<Json<RecommendationPreferencesResponse>> {
    let validated_preferences = validate_recommendation_preferences(
        &state.pool,
        &payload.topic_slugs,
        &payload.language_codes,
    )
    .await?;

    let mut transaction = state.pool.begin().await.map_err(map_recommendation_error)?;
    apply_recommendation_preferences(&mut transaction, user.user_id, &validated_preferences)
        .await?;
    refresh_recommendation_targets(&mut transaction, Some(user.user_id), None, None).await?;
    transaction
        .commit()
        .await
        .map_err(map_recommendation_error)?;

    let preferences = load_recommendation_preferences(&state.pool, user.user_id).await?;

    Ok(Json(preferences))
}

pub async fn get_recommendation_preferences(
    user: AuthenticatedUser,
    State(state): State<AppState>,
) -> ApiResult<Json<RecommendationPreferencesResponse>> {
    let preferences = load_recommendation_preferences(&state.pool, user.user_id).await?;

    Ok(Json(preferences))
}

pub(crate) async fn record_internal_content_event(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    content_id: Uuid,
    source_id: Option<Uuid>,
    event_type: InternalEventType,
    surface: &'static str,
) -> ApiResult<()> {
    sqlx::query(
        r#"
        insert into public.interaction_events (
            user_id,
            entity_type,
            content_id,
            source_id,
            event_type,
            surface,
            occurred_at,
            metadata
        )
        values ($1, 'content', $2, $3, $4, $5, timezone('utc', now()), '{}'::jsonb)
        "#,
    )
    .bind(user_id)
    .bind(content_id)
    .bind(source_id)
    .bind(event_type.as_str())
    .bind(surface)
    .execute(&mut **transaction)
    .await
    .map_err(map_recommendation_error)?;

    Ok(())
}

pub(crate) async fn record_internal_source_event(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    source_id: Uuid,
    event_type: InternalEventType,
    surface: &'static str,
) -> ApiResult<()> {
    sqlx::query(
        r#"
        insert into public.interaction_events (
            user_id,
            entity_type,
            source_id,
            event_type,
            surface,
            occurred_at,
            metadata
        )
        values ($1, 'source', $2, $3, $4, timezone('utc', now()), '{}'::jsonb)
        "#,
    )
    .bind(user_id)
    .bind(source_id)
    .bind(event_type.as_str())
    .bind(surface)
    .execute(&mut **transaction)
    .await
    .map_err(map_recommendation_error)?;

    Ok(())
}

pub(crate) async fn sync_recommendation_targets_for_signal(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Option<Uuid>,
    content_id: Option<Uuid>,
    source_id: Option<Uuid>,
) -> ApiResult<()> {
    rollup_interaction_events(transaction, IMMEDIATE_RECOMMENDATION_ROLLUP_LIMIT).await?;
    refresh_recommendation_targets(transaction, user_id, content_id, source_id).await
}

pub(crate) async fn refresh_recommendation_targets(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Option<Uuid>,
    content_id: Option<Uuid>,
    source_id: Option<Uuid>,
) -> ApiResult<()> {
    sqlx::query(
        r#"
        select public.refresh_recommendation_targets($1, $2, $3)
        "#,
    )
    .bind(user_id)
    .bind(content_id)
    .bind(source_id)
    .execute(&mut **transaction)
    .await
    .map_err(map_recommendation_error)?;

    Ok(())
}

async fn rollup_interaction_events(
    transaction: &mut Transaction<'_, Postgres>,
    limit: i32,
) -> ApiResult<()> {
    sqlx::query(
        r#"
        select public.rollup_interaction_events($1)
        "#,
    )
    .bind(limit)
    .execute(&mut **transaction)
    .await
    .map_err(map_recommendation_error)?;

    Ok(())
}

async fn load_user_recommendation_context(
    pool: &PgPool,
    user_id: Uuid,
) -> ApiResult<UserRecommendationContext> {
    let row = sqlx::query_as::<_, RecommendationContextRow>(
        r#"
        select *
        from public.get_user_recommendation_context($1)
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .map_err(map_recommendation_error)?;

    Ok(UserRecommendationContext {
        preferred_languages: row.preferred_languages,
        subscribed_source_ids: row
            .subscribed_source_ids
            .into_iter()
            .collect::<HashSet<_>>(),
    })
}

pub(crate) async fn validate_recommendation_preferences(
    pool: &PgPool,
    topic_slugs: &[String],
    language_codes: &[String],
) -> ApiResult<ValidatedRecommendationPreferences> {
    let topic_slugs = normalize_topic_slugs(topic_slugs)?;
    let language_codes = normalize_language_codes(language_codes)?;
    let topics = fetch_topics_by_slugs(pool, &topic_slugs).await?;
    if topics.len() != topic_slugs.len() {
        return Err(ApiError::bad_request("At least one topic slug is invalid"));
    }

    Ok(ValidatedRecommendationPreferences {
        language_codes,
        topic_ids: topics.into_iter().map(|topic| topic.id).collect(),
    })
}

pub(crate) async fn apply_recommendation_preferences(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    preferences: &ValidatedRecommendationPreferences,
) -> ApiResult<()> {
    sqlx::query(
        r#"
        insert into public.user_recommendation_settings (user_id, preferred_languages)
        values ($1, $2)
        on conflict (user_id) do update
        set preferred_languages = excluded.preferred_languages
        "#,
    )
    .bind(user_id)
    .bind(&preferences.language_codes)
    .execute(&mut **transaction)
    .await
    .map_err(map_recommendation_error)?;

    sqlx::query(
        r#"
        delete from public.user_topic_preferences
        where user_id = $1
        "#,
    )
    .bind(user_id)
    .execute(&mut **transaction)
    .await
    .map_err(map_recommendation_error)?;

    if !preferences.topic_ids.is_empty() {
        let mut builder = QueryBuilder::<Postgres>::new(
            "insert into public.user_topic_preferences (user_id, topic_id, weight) ",
        );
        builder.push_values(preferences.topic_ids.iter(), |mut row, topic_id| {
            row.push_bind(user_id)
                .push_bind(*topic_id)
                .push_bind(1.0_f64);
        });
        builder
            .build()
            .execute(&mut **transaction)
            .await
            .map_err(map_recommendation_error)?;
    }

    Ok(())
}

pub(crate) async fn rollup_and_refresh_recommendation_state(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> ApiResult<()> {
    rollup_interaction_events(transaction, IMMEDIATE_RECOMMENDATION_ROLLUP_LIMIT).await?;
    refresh_recommendation_targets(transaction, Some(user_id), None, None).await
}

async fn load_recommendation_preferences(
    pool: &PgPool,
    user_id: Uuid,
) -> ApiResult<RecommendationPreferencesResponse> {
    let row = sqlx::query_as::<_, RecommendationPreferencesRow>(
        r#"
        select
            coalesce(urs.preferred_languages, '{}'::text[]) as language_codes,
            coalesce(
                (
                    select array_agg(t.slug order by t.slug)
                    from public.user_topic_preferences utp
                    join public.topics t
                      on t.id = utp.topic_id
                    where utp.user_id = $1
                ),
                '{}'::text[]
            ) as topic_slugs
        from (select $1::uuid as user_id) as input
        left join public.user_recommendation_settings urs
          on urs.user_id = input.user_id
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .map_err(map_recommendation_error)?;

    Ok(RecommendationPreferencesResponse {
        topic_slugs: row.topic_slugs,
        language_codes: row.language_codes,
    })
}

async fn fetch_content_recommendation_candidate_rows(
    pool: &PgPool,
    user_id: Uuid,
) -> ApiResult<Vec<RecommendationContentCandidateRow>> {
    sqlx::query_as::<_, RecommendationContentCandidateRow>(
        r#"
        select *
        from public.get_content_recommendation_candidates($1)
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

async fn fetch_source_recommendation_candidate_rows(
    pool: &PgPool,
    user_id: Uuid,
) -> ApiResult<Vec<RecommendationSourceCandidateRow>> {
    sqlx::query_as::<_, RecommendationSourceCandidateRow>(
        r#"
        select *
        from public.get_source_recommendation_candidates($1)
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

async fn fetch_public_source_recommendation_candidate_rows(
    pool: &PgPool,
    topic_ids: &[Uuid],
    language_codes: &[String],
) -> ApiResult<Vec<RecommendationSourceCandidateRow>> {
    sqlx::query_as::<_, RecommendationSourceCandidateRow>(
        r#"
        with matched_topic_sources as (
            select
                st.source_id,
                least(sum(st.confidence), 2.0) as topic_score,
                (
                    array_agg(t.slug order by st.confidence desc, t.slug asc)
                )[1] as primary_topic_slug
            from public.source_topics st
            join public.topics t on t.id = st.topic_id
            where st.topic_id = any($1)
            group by st.source_id
        ),
        recent_activity as (
            select
                c.source_id,
                count(*)::bigint as recent_activity_count
            from public.content c
            where c.source_id in (select source_id from matched_topic_sources)
              and c.parse_status = 'succeeded'
              and c.parsed_document is not null
              and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '30 days'
              and (
                  cardinality($2::text[]) = 0
                  or c.language_code is null
                  or c.language_code = any($2)
              )
            group by c.source_id
        ),
        source_halo as (
            select
                shd.source_id,
                avg(shd.score) as source_halo_score
            from public.source_halo_daily shd
            where shd.source_id in (select source_id from matched_topic_sources)
              and shd.halo_date >= current_date - 30
            group by shd.source_id
        )
        select
            cs.id as source_id,
            cs.source_url,
            cs.resolved_source_url,
            cs.host as source_host,
            cs.title as source_title,
            cs.description as source_description,
            cs.source_kind,
            cs.refresh_status,
            cs.last_refreshed_at,
            sf.feed_url as primary_feed_url,
            mts.topic_score,
            mts.primary_topic_slug,
            coalesce(sh.source_halo_score, 0.0) as source_halo_score,
            coalesce(ra.recent_activity_count, 0)::bigint as recent_activity_count,
            0.0::double precision as similarity_score
        from matched_topic_sources mts
        join public.content_sources cs on cs.id = mts.source_id
        left join public.source_feeds sf on sf.id = cs.primary_feed_id
        left join recent_activity ra on ra.source_id = mts.source_id
        left join source_halo sh on sh.source_id = mts.source_id
        where coalesce(ra.recent_activity_count, 0) > 0
        order by
            mts.topic_score desc,
            coalesce(sh.source_halo_score, 0.0) desc,
            coalesce(ra.recent_activity_count, 0) desc,
            cs.id asc
        "#,
    )
    .bind(topic_ids)
    .bind(language_codes)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

async fn persist_content_recommendation_serve(
    pool: &PgPool,
    user_id: Uuid,
    limit: u32,
    candidates: &[ScoredContentCandidate],
    preferred_languages: Vec<String>,
) -> ApiResult<Uuid> {
    let mut transaction = pool.begin().await.map_err(map_recommendation_error)?;
    let serve_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        insert into public.recommendation_serves (
            user_id,
            surface,
            algorithm_version,
            request_context
        )
        values (
            $1,
            'content',
            $2,
            jsonb_build_object(
                'limit', $3,
                'preferred_languages', $4
            )
        )
        returning id
        "#,
    )
    .bind(user_id)
    .bind(RECOMMENDATION_ALGORITHM_VERSION)
    .bind(i64::from(limit))
    .bind(&preferred_languages)
    .fetch_one(&mut *transaction)
    .await
    .map_err(map_recommendation_error)?;

    if !candidates.is_empty() {
        let mut builder = QueryBuilder::<Postgres>::new(
            "insert into public.recommendation_serve_items (serve_id, position, entity_type, content_id, source_id, score, score_breakdown) ",
        );
        builder.push_values(
            candidates.iter().enumerate(),
            |mut row, (index, candidate)| {
                row.push_bind(serve_id)
                    .push_bind(index as i32)
                    .push_bind("content")
                    .push_bind(candidate.row.content_id)
                    .push_bind(candidate.row.source_id)
                    .push_bind(candidate.score)
                    .push_bind(SqlxJson(candidate.score_breakdown.clone()));
            },
        );
        builder
            .build()
            .execute(&mut *transaction)
            .await
            .map_err(map_recommendation_error)?;
    }

    transaction
        .commit()
        .await
        .map_err(map_recommendation_error)?;
    Ok(serve_id)
}

async fn persist_source_recommendation_serve(
    pool: &PgPool,
    user_id: Uuid,
    limit: u32,
    candidates: &[ScoredSourceCandidate],
    preferred_languages: Vec<String>,
) -> ApiResult<Uuid> {
    let mut transaction = pool.begin().await.map_err(map_recommendation_error)?;
    let serve_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        insert into public.recommendation_serves (
            user_id,
            surface,
            algorithm_version,
            request_context
        )
        values (
            $1,
            'sources',
            $2,
            jsonb_build_object(
                'limit', $3,
                'preferred_languages', $4
            )
        )
        returning id
        "#,
    )
    .bind(user_id)
    .bind(RECOMMENDATION_ALGORITHM_VERSION)
    .bind(i64::from(limit))
    .bind(&preferred_languages)
    .fetch_one(&mut *transaction)
    .await
    .map_err(map_recommendation_error)?;

    if !candidates.is_empty() {
        let mut builder = QueryBuilder::<Postgres>::new(
            "insert into public.recommendation_serve_items (serve_id, position, entity_type, source_id, score, score_breakdown) ",
        );
        builder.push_values(
            candidates.iter().enumerate(),
            |mut row, (index, candidate)| {
                row.push_bind(serve_id)
                    .push_bind(index as i32)
                    .push_bind("source")
                    .push_bind(candidate.row.source_id)
                    .push_bind(candidate.score)
                    .push_bind(SqlxJson(candidate.score_breakdown.clone()));
            },
        );
        builder
            .build()
            .execute(&mut *transaction)
            .await
            .map_err(map_recommendation_error)?;
    }

    transaction
        .commit()
        .await
        .map_err(map_recommendation_error)?;
    Ok(serve_id)
}

fn build_content_recommendation_item(
    position: usize,
    candidate: ScoredContentCandidate,
    context: &UserRecommendationContext,
) -> ApiResult<ContentRecommendationItem> {
    let source_kind = parse_optional_source_kind(candidate.row.source_kind_label.as_deref())?;
    let source = candidate
        .row
        .source_id
        .map(|source_id| RecommendationSourcePreview {
            id: source_id,
            source_url: candidate.row.source_url.clone(),
            resolved_source_url: candidate.row.resolved_source_url.clone(),
            host: candidate
                .row
                .source_host
                .clone()
                .unwrap_or_else(|| candidate.row.host.clone()),
            title: candidate.row.source_title.clone(),
            source_kind,
            primary_feed_url: candidate.row.primary_feed_url.clone(),
        });

    Ok(ContentRecommendationItem {
        position: position as u32,
        is_saved: false,
        is_subscribed_source: candidate
            .row
            .source_id
            .is_some_and(|source_id| context.subscribed_source_ids.contains(&source_id)),
        content: RecommendationContentSummary {
            id: candidate.row.content_id,
            canonical_url: candidate.row.canonical_url,
            resolved_url: candidate.row.resolved_url,
            host: candidate.row.host,
            site_name: candidate.row.site_name,
            source_kind: parse_optional_source_kind(candidate.row.source_kind.as_deref())?,
            title: candidate.row.title,
            excerpt: candidate.row.excerpt,
            author: candidate.row.author,
            published_at: maybe_timestamp_seconds(candidate.row.published_at),
            language_code: candidate.row.language_code,
            has_favicon: candidate.row.has_favicon,
            favicon_href: format!("/me/content/{}/favicon", candidate.row.content_id),
            fetch_status: parse_db_processing_status(&candidate.row.fetch_status)?,
            parse_status: parse_db_processing_status(&candidate.row.parse_status)?,
            parsed_at: maybe_timestamp_seconds(candidate.row.parsed_at),
        },
        source,
    })
}

fn build_source_recommendation_item(
    position: usize,
    candidate: ScoredSourceCandidate,
) -> ApiResult<SourceRecommendationItem> {
    let source = build_recommendation_source_summary(candidate.row)?;

    Ok(SourceRecommendationItem {
        position: position as u32,
        is_subscribed: false,
        source,
    })
}

fn build_public_source_recommendation_item(
    position: usize,
    candidate: ScoredSourceCandidate,
) -> ApiResult<PublicSourceRecommendationItem> {
    let source = build_recommendation_source_summary(candidate.row)?;

    Ok(PublicSourceRecommendationItem {
        position: position as u32,
        source,
    })
}

fn build_recommendation_source_summary(
    row: RecommendationSourceCandidateRow,
) -> ApiResult<RecommendationSourceSummary> {
    Ok(RecommendationSourceSummary {
        id: row.source_id,
        source_url: row.source_url,
        resolved_source_url: row.resolved_source_url,
        host: row.source_host,
        title: row.source_title,
        description: row.source_description,
        source_kind: SourceKind::from_str(&row.source_kind)
            .map_err(|_| ApiError::internal("Stored source kind was invalid"))?,
        primary_feed_url: row.primary_feed_url,
        refresh_status: RecommendationSourceRefreshStatus::from_db(&row.refresh_status)?,
        last_refreshed_at: maybe_timestamp_seconds(row.last_refreshed_at),
    })
}

fn build_content_detail(
    row: RecommendationContentDetailRow,
) -> ApiResult<RecommendationContentDetail> {
    let body = row.parsed_document.as_ref().and_then(|document| {
        build_compact_content_body(
            &document.0,
            parse_optional_source_kind(row.source_kind.as_deref())
                .ok()
                .flatten(),
        )
    });

    Ok(RecommendationContentDetail {
        id: row.content_id,
        canonical_url: row.canonical_url,
        resolved_url: row.resolved_url,
        host: row.host,
        site_name: row.site_name,
        source_kind: parse_optional_source_kind(row.source_kind.as_deref())?,
        title: row.title,
        excerpt: row.excerpt,
        author: row.author,
        published_at: maybe_timestamp_seconds(row.published_at),
        language_code: row.language_code,
        has_favicon: row.has_favicon,
        favicon_href: format!("/me/content/{}/favicon", row.content_id),
        fetch_status: parse_db_processing_status(&row.fetch_status)?,
        parse_status: parse_db_processing_status(&row.parse_status)?,
        parsed_at: maybe_timestamp_seconds(row.parsed_at),
        body,
    })
}

async fn insert_public_interaction_events(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    events: &[ValidatedInteractionEvent],
) -> ApiResult<u32> {
    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        insert into public.interaction_events (
            user_id,
            entity_type,
            content_id,
            source_id,
            event_type,
            surface,
            session_id,
            serve_id,
            position,
            visible_ms_delta,
            occurred_at,
            client_event_id,
            metadata
        )
        "#,
    );
    builder.push_values(events.iter(), |mut row, event| {
        row.push_bind(user_id)
            .push_bind(event.entity_type.as_str())
            .push_bind(event.content_id)
            .push_bind(event.source_id)
            .push_bind(event.event_type.as_str())
            .push_bind(event.surface.as_deref())
            .push_bind(event.session_id)
            .push_bind(event.serve_id)
            .push_bind(event.position.map(|value| value as i32))
            .push_bind(event.visible_ms_delta.map(|value| value as i32))
            .push_bind(event.occurred_at)
            .push_bind(event.client_event_id)
            .push_bind(SqlxJson(event.metadata.clone()));
    });
    builder.push(
        " on conflict (user_id, client_event_id) where client_event_id is not null do nothing",
    );

    let result = builder
        .build()
        .execute(&mut **transaction)
        .await
        .map_err(map_recommendation_error)?;

    Ok(result.rows_affected() as u32)
}

async fn validate_public_interaction_targets(
    pool: &PgPool,
    events: &[ValidatedInteractionEvent],
) -> ApiResult<()> {
    let mut content_ids = HashSet::new();
    let mut source_ids = HashSet::new();
    let mut serve_ids = HashSet::new();
    for event in events {
        if let Some(content_id) = event.content_id {
            content_ids.insert(content_id);
        }
        if let Some(source_id) = event.source_id {
            source_ids.insert(source_id);
        }
        if let Some(serve_id) = event.serve_id {
            serve_ids.insert(serve_id);
        }
    }

    if !content_ids.is_empty() {
        let rows =
            sqlx::query_scalar::<_, Uuid>("select id from public.content where id = any($1)")
                .bind(content_ids.iter().copied().collect::<Vec<_>>())
                .fetch_all(pool)
                .await
                .map_err(map_recommendation_error)?;
        if rows.len() != content_ids.len() {
            return Err(ApiError::bad_request("At least one content_id is invalid"));
        }
    }

    if !source_ids.is_empty() {
        let rows = sqlx::query_scalar::<_, Uuid>(
            "select id from public.content_sources where id = any($1)",
        )
        .bind(source_ids.iter().copied().collect::<Vec<_>>())
        .fetch_all(pool)
        .await
        .map_err(map_recommendation_error)?;
        if rows.len() != source_ids.len() {
            return Err(ApiError::bad_request("At least one source_id is invalid"));
        }
    }

    if !serve_ids.is_empty() {
        let rows = sqlx::query_scalar::<_, Uuid>(
            "select id from public.recommendation_serves where id = any($1)",
        )
        .bind(serve_ids.iter().copied().collect::<Vec<_>>())
        .fetch_all(pool)
        .await
        .map_err(map_recommendation_error)?;
        if rows.len() != serve_ids.len() {
            return Err(ApiError::bad_request("At least one serve_id is invalid"));
        }
    }

    Ok(())
}

async fn fetch_topics_by_slugs(pool: &PgPool, slugs: &[String]) -> ApiResult<Vec<TopicRow>> {
    if slugs.is_empty() {
        return Ok(Vec::new());
    }

    sqlx::query_as::<_, TopicRow>(
        r#"
        select id
        from public.topics
        where slug = any($1)
        "#,
    )
    .bind(slugs)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

fn apply_content_diversity(
    ranked: Vec<ScoredContentCandidate>,
    limit: usize,
) -> Vec<ScoredContentCandidate> {
    let mut selected = Vec::new();
    let mut overflow = Vec::new();
    let mut source_counts = HashMap::<Uuid, usize>::new();
    let mut topic_counts = HashMap::<String, usize>::new();

    for candidate in ranked {
        let source_allowed = candidate
            .row
            .source_id
            .map(|source_id| {
                let cap = if selected.len() < 10 { 2 } else { 4 };
                source_counts.get(&source_id).copied().unwrap_or(0) < cap
            })
            .unwrap_or(true);
        let topic_allowed = candidate.primary_topic_slug.as_ref().is_none_or(|topic| {
            let cap = if selected.len() < 10 { 3 } else { 5 };
            topic_counts.get(topic).copied().unwrap_or(0) < cap
        });

        if source_allowed && topic_allowed {
            if let Some(source_id) = candidate.row.source_id {
                *source_counts.entry(source_id).or_insert(0) += 1;
            }
            if let Some(topic) = candidate.primary_topic_slug.as_ref() {
                *topic_counts.entry(topic.clone()).or_insert(0) += 1;
            }
            selected.push(candidate);
            if selected.len() == limit {
                return selected;
            }
        } else {
            overflow.push(candidate);
        }
    }

    for candidate in overflow {
        selected.push(candidate);
        if selected.len() == limit {
            break;
        }
    }

    selected
}

fn apply_source_diversity(
    ranked: Vec<ScoredSourceCandidate>,
    limit: usize,
) -> Vec<ScoredSourceCandidate> {
    let mut selected = Vec::new();
    let mut overflow = Vec::new();
    let mut topic_counts = HashMap::<String, usize>::new();

    for candidate in ranked {
        let topic_allowed = candidate.primary_topic_slug.as_ref().is_none_or(|topic| {
            let cap = if selected.len() < 10 { 2 } else { 4 };
            topic_counts.get(topic).copied().unwrap_or(0) < cap
        });

        if topic_allowed {
            if let Some(topic) = candidate.primary_topic_slug.as_ref() {
                *topic_counts.entry(topic.clone()).or_insert(0) += 1;
            }
            selected.push(candidate);
            if selected.len() == limit {
                return selected;
            }
        } else {
            overflow.push(candidate);
        }
    }

    for candidate in overflow {
        selected.push(candidate);
        if selected.len() == limit {
            break;
        }
    }

    selected
}

fn normalize_recommendation_limit(limit: Option<u32>) -> ApiResult<u32> {
    let limit = limit.unwrap_or(DEFAULT_RECOMMENDATION_LIMIT);
    if (1..=MAX_RECOMMENDATION_LIMIT).contains(&limit) {
        Ok(limit)
    } else {
        Err(ApiError::bad_request("limit is invalid"))
    }
}

fn validate_public_interaction_event(
    input: InteractionEventInput,
) -> ApiResult<ValidatedInteractionEvent> {
    let surface = input
        .surface
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let entity_type = match (input.content_id, input.source_id) {
        (Some(_), _) => InteractionEntityType::Content,
        (None, Some(_)) => InteractionEntityType::Source,
        (None, None) => {
            return Err(ApiError::bad_request(
                "Each event must include a content_id or source_id",
            ));
        }
    };

    if input.client_event_id.is_none() {
        return Err(ApiError::bad_request(
            "Each event must include a client_event_id",
        ));
    }

    if matches!(input.event_type, PublicInteractionEventType::Heartbeat)
        && input.visible_ms_delta.unwrap_or(0) == 0
    {
        return Err(ApiError::bad_request(
            "Heartbeat events must include visible_ms_delta",
        ));
    }

    let occurred_at = input
        .occurred_at
        .map(OffsetDateTime::from_unix_timestamp)
        .transpose()
        .map_err(|_| ApiError::bad_request("occurred_at is invalid"))?
        .unwrap_or_else(OffsetDateTime::now_utc);

    Ok(ValidatedInteractionEvent {
        entity_type,
        event_type: input.event_type,
        content_id: input.content_id,
        source_id: input.source_id,
        surface,
        session_id: input.session_id,
        serve_id: input.serve_id,
        position: input.position,
        visible_ms_delta: input.visible_ms_delta,
        occurred_at,
        client_event_id: input.client_event_id,
        metadata: input.metadata.unwrap_or_else(|| json!({})),
    })
}

fn normalize_topic_slugs(input: &[String]) -> ApiResult<Vec<String>> {
    if input.len() > MAX_TOPIC_PREFERENCES {
        return Err(ApiError::bad_request(
            "Too many topic preferences were provided",
        ));
    }

    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for slug in input {
        let slug = normalize_tag_slug(slug)?;
        if seen.insert(slug.clone()) {
            normalized.push(slug);
        }
    }

    Ok(normalized)
}

fn normalize_language_codes(input: &[String]) -> ApiResult<Vec<String>> {
    if input.len() > MAX_LANGUAGE_PREFERENCES {
        return Err(ApiError::bad_request(
            "Too many language preferences were provided",
        ));
    }

    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for code in input {
        let code = code.trim().to_ascii_lowercase();
        if code.is_empty()
            || code.len() > 16
            || !code
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
        {
            return Err(ApiError::bad_request(
                "language_codes contains an invalid value",
            ));
        }

        if seen.insert(code.clone()) {
            normalized.push(code);
        }
    }

    Ok(normalized)
}

fn normalize_positive_score(score: f64) -> f64 {
    score.clamp(0.0, 2.0) / 2.0
}

fn freshness_score(timestamp: OffsetDateTime, window_days: f64) -> f64 {
    let age_days =
        ((OffsetDateTime::now_utc() - timestamp).whole_seconds() as f64 / 86_400.0).max(0.0);
    ((window_days - age_days) / window_days).clamp(0.0, 1.0)
}

fn normalize_recent_activity(activity_count: i64) -> f64 {
    (activity_count as f64).clamp(0.0, 20.0) / 20.0
}

fn repeat_penalty(candidate: &RecommendationContentCandidateRow) -> f64 {
    if candidate.mark_read_count > 0 || candidate.read_ratio >= 0.8 {
        0.35
    } else {
        0.0
    }
}

fn map_recommendation_error(error: sqlx::Error) -> ApiError {
    tracing::error!(error = %error, "recommendation query failed");
    ApiError::internal("Database operation failed")
}

#[derive(Debug, Deserialize)]
pub struct ListRecommendationsQuery {
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRecommendationPreferencesRequest {
    #[serde(default)]
    topic_slugs: Vec<String>,
    #[serde(default)]
    language_codes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RecommendationPreferencesResponse {
    topic_slugs: Vec<String>,
    language_codes: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct PublicSourceRecommendationsRequest {
    #[serde(default)]
    topic_slugs: Vec<String>,
    #[serde(default)]
    language_codes: Vec<String>,
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct InteractionEventBatchRequest {
    events: Vec<InteractionEventInput>,
}

#[derive(Debug, Deserialize)]
pub struct InteractionEventInput {
    event_type: PublicInteractionEventType,
    content_id: Option<Uuid>,
    source_id: Option<Uuid>,
    surface: Option<String>,
    session_id: Option<Uuid>,
    serve_id: Option<Uuid>,
    position: Option<u32>,
    visible_ms_delta: Option<u32>,
    occurred_at: Option<i64>,
    client_event_id: Option<Uuid>,
    metadata: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct InteractionEventBatchResponse {
    accepted: u32,
    received: u32,
}

#[derive(Debug, Serialize)]
pub struct ContentRecommendationListResponse {
    serve_id: Uuid,
    content: Vec<ContentRecommendationItem>,
}

#[derive(Debug, Serialize)]
pub struct SourceRecommendationListResponse {
    serve_id: Uuid,
    sources: Vec<SourceRecommendationItem>,
}

#[derive(Debug, Serialize)]
pub struct PublicSourceRecommendationListResponse {
    sources: Vec<PublicSourceRecommendationItem>,
}

#[derive(Debug, Serialize)]
pub struct ContentRecommendationItem {
    position: u32,
    is_saved: bool,
    is_subscribed_source: bool,
    content: RecommendationContentSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<RecommendationSourcePreview>,
}

#[derive(Debug, Serialize)]
pub struct SourceRecommendationItem {
    position: u32,
    is_subscribed: bool,
    source: RecommendationSourceSummary,
}

#[derive(Debug, Serialize)]
pub struct PublicSourceRecommendationItem {
    position: u32,
    source: RecommendationSourceSummary,
}

#[derive(Debug, Serialize)]
pub struct RecommendationContentSummary {
    id: Uuid,
    canonical_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_url: Option<String>,
    host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    site_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_kind: Option<SourceKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_code: Option<String>,
    has_favicon: bool,
    favicon_href: String,
    fetch_status: ProcessingStatus,
    parse_status: ProcessingStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    parsed_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct RecommendationSourcePreview {
    id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_source_url: Option<String>,
    host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_kind: Option<SourceKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    primary_feed_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RecommendationSourceSummary {
    id: Uuid,
    source_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_source_url: Option<String>,
    host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    source_kind: SourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    primary_feed_url: Option<String>,
    refresh_status: RecommendationSourceRefreshStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_refreshed_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct RecommendationContentDetail {
    id: Uuid,
    canonical_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_url: Option<String>,
    host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    site_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_kind: Option<SourceKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_code: Option<String>,
    has_favicon: bool,
    favicon_href: String,
    fetch_status: ProcessingStatus,
    parse_status: ProcessingStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    parsed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<CompactContentBody>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecommendationSourceRefreshStatus {
    Pending,
    InProgress,
    Succeeded,
    Failed,
    NoFeed,
}

impl RecommendationSourceRefreshStatus {
    fn from_db(value: &str) -> ApiResult<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "in_progress" => Ok(Self::InProgress),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "no_feed" => Ok(Self::NoFeed),
            _ => Err(ApiError::internal(
                "Stored source refresh status was invalid",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PublicInteractionEventType {
    Impression,
    Open,
    Heartbeat,
    Close,
    Dismiss,
}

impl PublicInteractionEventType {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Impression => "impression",
            Self::Open => "open",
            Self::Heartbeat => "heartbeat",
            Self::Close => "close",
            Self::Dismiss => "dismiss",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum InternalEventType {
    Save,
    Favorite,
    MarkRead,
    Subscribe,
    Unsubscribe,
    Dismiss,
}

impl InternalEventType {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Save => "save",
            Self::Favorite => "favorite",
            Self::MarkRead => "mark_read",
            Self::Subscribe => "subscribe",
            Self::Unsubscribe => "unsubscribe",
            Self::Dismiss => "dismiss",
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum InteractionEntityType {
    Content,
    Source,
}

impl InteractionEntityType {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Content => "content",
            Self::Source => "source",
        }
    }
}

#[derive(Debug)]
struct ValidatedInteractionEvent {
    entity_type: InteractionEntityType,
    event_type: PublicInteractionEventType,
    content_id: Option<Uuid>,
    source_id: Option<Uuid>,
    surface: Option<String>,
    session_id: Option<Uuid>,
    serve_id: Option<Uuid>,
    position: Option<u32>,
    visible_ms_delta: Option<u32>,
    occurred_at: OffsetDateTime,
    client_event_id: Option<Uuid>,
    metadata: Value,
}

#[derive(Debug)]
struct UserRecommendationContext {
    preferred_languages: Vec<String>,
    subscribed_source_ids: HashSet<Uuid>,
}

#[derive(Debug)]
struct ScoredContentCandidate {
    row: RecommendationContentCandidateRow,
    primary_topic_slug: Option<String>,
    score: f64,
    score_breakdown: Value,
}

#[derive(Debug)]
struct ScoredSourceCandidate {
    row: RecommendationSourceCandidateRow,
    primary_topic_slug: Option<String>,
    score: f64,
    score_breakdown: Value,
}

#[derive(Debug, FromRow)]
struct RecommendationContextRow {
    preferred_languages: Vec<String>,
    subscribed_source_ids: Vec<Uuid>,
    #[sqlx(rename = "top_topic_ids")]
    _top_topic_ids: Vec<Uuid>,
    #[sqlx(rename = "top_source_ids")]
    _top_source_ids: Vec<Uuid>,
}

#[derive(Debug, FromRow)]
struct RecommendationContentCandidateRow {
    content_id: Uuid,
    source_id: Option<Uuid>,
    subscribed_inbox: bool,
    discovery: bool,
    saved_adjacent: bool,
    trending: bool,
    canonical_url: String,
    resolved_url: Option<String>,
    host: String,
    site_name: Option<String>,
    source_kind: Option<String>,
    title: Option<String>,
    excerpt: Option<String>,
    author: Option<String>,
    published_at: Option<OffsetDateTime>,
    language_code: Option<String>,
    has_favicon: bool,
    fetch_status: String,
    parse_status: String,
    parsed_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    source_url: Option<String>,
    resolved_source_url: Option<String>,
    source_host: Option<String>,
    source_title: Option<String>,
    source_kind_label: Option<String>,
    primary_feed_url: Option<String>,
    topic_score: f64,
    primary_topic_slug: Option<String>,
    source_affinity_score: f64,
    content_halo_score: f64,
    source_halo_score: f64,
    dismiss_count: i32,
    mark_read_count: i32,
    read_ratio: f64,
}

#[derive(Debug, FromRow)]
struct RecommendationSourceCandidateRow {
    source_id: Uuid,
    source_url: String,
    resolved_source_url: Option<String>,
    source_host: String,
    source_title: Option<String>,
    source_description: Option<String>,
    source_kind: String,
    refresh_status: String,
    last_refreshed_at: Option<OffsetDateTime>,
    primary_feed_url: Option<String>,
    topic_score: f64,
    primary_topic_slug: Option<String>,
    source_halo_score: f64,
    recent_activity_count: i64,
    similarity_score: f64,
}

#[derive(Debug, FromRow)]
struct RecommendationContentDetailRow {
    content_id: Uuid,
    canonical_url: String,
    resolved_url: Option<String>,
    host: String,
    site_name: Option<String>,
    source_kind: Option<String>,
    title: Option<String>,
    excerpt: Option<String>,
    author: Option<String>,
    published_at: Option<OffsetDateTime>,
    language_code: Option<String>,
    has_favicon: bool,
    fetch_status: String,
    parse_status: String,
    parsed_at: Option<OffsetDateTime>,
    parsed_document: Option<SqlxJson<Value>>,
}

#[derive(Debug, FromRow)]
struct TopicRow {
    id: Uuid,
}

#[derive(Debug, Clone)]
pub(crate) struct ValidatedRecommendationPreferences {
    pub(crate) language_codes: Vec<String>,
    pub(crate) topic_ids: Vec<Uuid>,
}

impl ValidatedRecommendationPreferences {
    pub(crate) fn is_empty(&self) -> bool {
        self.topic_ids.is_empty() && self.language_codes.is_empty()
    }
}

#[derive(Debug, FromRow)]
struct RecommendationPreferencesRow {
    topic_slugs: Vec<String>,
    language_codes: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::{
        PublicInteractionEventType, PublicSourceRecommendationsRequest, freshness_score,
        normalize_language_codes, normalize_positive_score, normalize_topic_slugs,
        preview_source_recommendations, validate_public_interaction_event,
    };
    use crate::{
        AppState, auth::SupabaseAuth, auth_api::SupabaseAuthApi, config::SupabaseConfig,
        rate_limit::AuthRateLimiter,
    };
    use axum::response::IntoResponse;
    use axum::{Json, extract::State};
    use serde_json::json;
    use sqlx::postgres::PgPoolOptions;
    use std::time::Duration;
    use uuid::Uuid;

    fn test_app_state() -> AppState {
        let config = SupabaseConfig {
            url: "http://127.0.0.1:9999".to_string(),
            issuer: "http://127.0.0.1:9999/auth/v1".to_string(),
            jwks_url: "http://127.0.0.1:9999/auth/v1/.well-known/jwks.json".to_string(),
            audience: "authenticated".to_string(),
            jwks_cache_ttl: Duration::from_secs(300),
            publishable_key: Some("publishable-test-key".to_string()),
            service_role_key: Some("service-role-key".to_string()),
        };

        AppState {
            auth: SupabaseAuth::new(config.clone()),
            auth_api: SupabaseAuthApi::new(&config),
            auth_rate_limiter: AuthRateLimiter::default(),
            pool: PgPoolOptions::new()
                .connect_lazy("postgresql://postgres:postgres@localhost/postgres")
                .expect("lazy pool should parse"),
        }
    }

    #[test]
    fn normalizes_topic_slugs_and_deduplicates() {
        let normalized = normalize_topic_slugs(&[
            "Technology".to_string(),
            "technology".to_string(),
            "Science & Research".to_string(),
        ])
        .expect("slugs should normalize");

        assert_eq!(normalized, vec!["technology", "science-research"]);
    }

    #[test]
    fn normalizes_language_codes() {
        let normalized =
            normalize_language_codes(&["EN".to_string(), "en".to_string(), "pt-BR".to_string()])
                .expect("codes should normalize");

        assert_eq!(normalized, vec!["en", "pt-br"]);
    }

    #[test]
    fn validates_heartbeat_requires_visible_delta() {
        let error = validate_public_interaction_event(super::InteractionEventInput {
            event_type: PublicInteractionEventType::Heartbeat,
            content_id: Some(Uuid::nil()),
            source_id: None,
            surface: Some("recommendations_content".to_string()),
            session_id: None,
            serve_id: None,
            position: Some(1),
            visible_ms_delta: None,
            occurred_at: Some(0),
            client_event_id: Some(Uuid::nil()),
            metadata: Some(json!({})),
        })
        .expect_err("heartbeat should require visible_ms_delta");

        assert_eq!(
            error.into_response().status(),
            axum::http::StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn positive_score_normalization_clamps() {
        assert_eq!(normalize_positive_score(-1.0), 0.0);
        assert_eq!(normalize_positive_score(0.5), 0.25);
        assert_eq!(normalize_positive_score(3.0), 1.0);
    }

    #[test]
    fn freshness_score_is_bounded() {
        let now = time::OffsetDateTime::now_utc();
        assert!(freshness_score(now, 30.0) > 0.99);
        assert_eq!(freshness_score(now - time::Duration::days(45), 30.0), 0.0);
    }

    #[tokio::test]
    async fn preview_source_recommendations_requires_topics() {
        let result = preview_source_recommendations(
            State(test_app_state()),
            Json(PublicSourceRecommendationsRequest {
                topic_slugs: Vec::new(),
                language_codes: vec!["en".to_string()],
                limit: Some(10),
            }),
        )
        .await;

        let response = result.expect_err("preview should fail").into_response();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }
}
