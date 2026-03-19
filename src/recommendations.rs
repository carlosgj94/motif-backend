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
const RECOMMENDATION_ALGORITHM_VERSION: &str = "v1-postgres-hybrid";

pub async fn list_content_recommendations(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Query(query): Query<ListRecommendationsQuery>,
) -> ApiResult<Json<ContentRecommendationListResponse>> {
    let limit = normalize_recommendation_limit(query.limit)?;
    let user_context = load_user_recommendation_context(&state.pool, user.user_id).await?;

    let mut candidates = HashMap::new();
    collect_content_candidates(
        &mut candidates,
        fetch_subscribed_content_candidates(&state.pool, user.user_id).await?,
        ContentCandidateBucket::SubscribedInbox,
    );
    collect_content_candidates(
        &mut candidates,
        fetch_discovery_content_candidates(
            &state.pool,
            user.user_id,
            &user_context.preferred_languages,
        )
        .await?,
        ContentCandidateBucket::Discovery,
    );
    collect_content_candidates(
        &mut candidates,
        fetch_saved_adjacent_content_candidates(
            &state.pool,
            user.user_id,
            &user_context.top_topic_ids,
            &user_context.top_source_ids,
        )
        .await?,
        ContentCandidateBucket::SavedAdjacent,
    );
    collect_content_candidates(
        &mut candidates,
        fetch_trending_content_candidates(
            &state.pool,
            user.user_id,
            &user_context.preferred_languages,
        )
        .await?,
        ContentCandidateBucket::Trending,
    );

    let candidate_ids: Vec<Uuid> = candidates.keys().copied().collect();
    let content_rows = fetch_recommendation_content_rows(&state.pool, &candidate_ids).await?;
    let content_ids: Vec<Uuid> = content_rows.iter().map(|row| row.content_id).collect();
    let source_ids: Vec<Uuid> = content_rows
        .iter()
        .filter_map(|row| row.source_id)
        .collect();

    let topic_scores = fetch_content_topic_scores(&state.pool, user.user_id, &content_ids).await?;
    let source_affinity_scores =
        fetch_user_source_affinity_scores(&state.pool, user.user_id, &source_ids).await?;
    let content_halos = fetch_recent_content_halos(&state.pool, &content_ids, 30).await?;
    let source_halos = fetch_recent_source_halos(&state.pool, &source_ids, 30).await?;
    let feedback_map =
        fetch_user_content_feedback_scores(&state.pool, user.user_id, &content_ids).await?;

    let mut scored = content_rows
        .into_iter()
        .filter_map(|row| {
            let content_id = row.content_id;
            let source_id = row.source_id;
            let buckets = candidates.remove(&content_id)?;
            if feedback_map
                .get(&content_id)
                .is_some_and(|feedback| feedback.dismiss_count > 0)
            {
                return None;
            }

            let topic_match = topic_scores
                .get(&content_id)
                .map(|score| normalize_positive_score(score.score))
                .unwrap_or(0.0);
            let source_affinity = source_id
                .and_then(|value| source_affinity_scores.get(&value).copied())
                .map(normalize_positive_score)
                .unwrap_or(0.0);
            let content_halo = content_halos.get(&content_id).copied().unwrap_or(0.0);
            let source_halo = source_id
                .and_then(|value| source_halos.get(&value).copied())
                .unwrap_or(0.0);
            let freshness = freshness_score(row.published_at.unwrap_or(row.created_at), 30.0);
            let subscribed_inbox_boost = if user_context
                .subscribed_source_ids
                .contains(&source_id.unwrap_or(Uuid::nil()))
                || buckets.subscribed_inbox
            {
                1.0
            } else {
                0.0
            };
            let exploration_boost = if !subscribed_inbox_boost.eq(&1.0) {
                1.0
            } else {
                0.0
            };
            let repeat_penalty = feedback_map
                .get(&content_id)
                .map(repeat_penalty)
                .unwrap_or(0.0);
            let final_score = (0.30 * topic_match)
                + (0.20 * source_affinity)
                + (0.15 * content_halo)
                + (0.10 * source_halo)
                + (0.10 * freshness)
                + (0.10 * subscribed_inbox_boost)
                + (0.05 * exploration_boost)
                - repeat_penalty;

            Some(ScoredContentCandidate {
                row,
                primary_topic_slug: topic_scores
                    .get(&content_id)
                    .and_then(|score| score.primary_topic_slug.clone()),
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
                    "buckets": buckets.to_json(),
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

    let mut candidate_ids = HashSet::new();
    candidate_ids
        .extend(fetch_topic_source_candidates(&state.pool, &user_context.top_topic_ids).await?);
    candidate_ids.extend(
        fetch_recent_source_candidates(
            &state.pool,
            user.user_id,
            &user_context.preferred_languages,
        )
        .await?,
    );
    candidate_ids.extend(
        fetch_similar_source_candidates(&state.pool, user.user_id, &user_context.top_source_ids)
            .await?,
    );
    for subscribed in &user_context.subscribed_source_ids {
        candidate_ids.remove(subscribed);
    }

    let source_ids: Vec<Uuid> = candidate_ids.into_iter().collect();
    let source_rows = fetch_recommendation_source_rows(&state.pool, &source_ids).await?;
    let topic_scores = fetch_source_topic_scores(&state.pool, user.user_id, &source_ids).await?;
    let source_halos = fetch_recent_source_halos(&state.pool, &source_ids, 30).await?;
    let recent_activity = fetch_source_recent_activity(&state.pool, &source_ids, 30).await?;
    let similarity_scores =
        fetch_source_similarity_scores(&state.pool, user.user_id, &source_ids).await?;

    let mut scored = source_rows
        .into_iter()
        .map(|row| {
            let source_id = row.source_id;
            let topic_match = topic_scores
                .get(&source_id)
                .map(|score| normalize_positive_score(score.score))
                .unwrap_or(0.0);
            let source_halo = source_halos.get(&source_id).copied().unwrap_or(0.0);
            let recent_activity_score =
                normalize_recent_activity(recent_activity.get(&source_id).copied().unwrap_or(0));
            let similarity = similarity_scores.get(&source_id).copied().unwrap_or(0.0);
            let exploration_diversity = 1.0;
            let final_score = (0.40 * topic_match)
                + (0.20 * source_halo)
                + (0.15 * similarity)
                + (0.15 * recent_activity_score)
                + (0.10 * exploration_diversity);

            ScoredSourceCandidate {
                row,
                primary_topic_slug: topic_scores
                    .get(&source_id)
                    .and_then(|score| score.primary_topic_slug.clone()),
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
    enqueue_public_interaction_refreshes(&mut transaction, user.user_id, &events).await?;
    invoke_recommendation_processor(&mut transaction, "event").await?;
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
    let topic_slugs = normalize_topic_slugs(&payload.topic_slugs)?;
    let language_codes = normalize_language_codes(&payload.language_codes)?;
    let topics = fetch_topics_by_slugs(&state.pool, &topic_slugs).await?;
    if topics.len() != topic_slugs.len() {
        return Err(ApiError::bad_request("At least one topic slug is invalid"));
    }

    let mut transaction = state.pool.begin().await.map_err(map_recommendation_error)?;
    sqlx::query(
        r#"
        insert into public.user_recommendation_settings (user_id, preferred_languages)
        values ($1, $2)
        on conflict (user_id) do update
        set preferred_languages = excluded.preferred_languages
        "#,
    )
    .bind(user.user_id)
    .bind(&language_codes)
    .execute(&mut *transaction)
    .await
    .map_err(map_recommendation_error)?;

    sqlx::query(
        r#"
        delete from public.user_topic_preferences
        where user_id = $1
        "#,
    )
    .bind(user.user_id)
    .execute(&mut *transaction)
    .await
    .map_err(map_recommendation_error)?;

    if !topics.is_empty() {
        let mut builder = QueryBuilder::<Postgres>::new(
            "insert into public.user_topic_preferences (user_id, topic_id, weight) ",
        );
        builder.push_values(topics.iter(), |mut row, topic| {
            row.push_bind(user.user_id)
                .push_bind(topic.id)
                .push_bind(1.0_f64);
        });
        builder
            .build()
            .execute(&mut *transaction)
            .await
            .map_err(map_recommendation_error)?;
    }

    enqueue_recommendation_refresh(
        &mut transaction,
        Some(user.user_id),
        None,
        None,
        "preferences",
        0,
    )
    .await?;
    invoke_recommendation_processor(&mut transaction, "preferences").await?;
    transaction
        .commit()
        .await
        .map_err(map_recommendation_error)?;

    Ok(Json(RecommendationPreferencesResponse {
        topic_slugs,
        language_codes,
    }))
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

    enqueue_recommendation_refresh(
        transaction,
        Some(user_id),
        Some(content_id),
        source_id,
        event_type.default_trigger(),
        0,
    )
    .await
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

    enqueue_recommendation_refresh(
        transaction,
        Some(user_id),
        None,
        Some(source_id),
        event_type.default_trigger(),
        0,
    )
    .await
}

pub(crate) async fn invoke_recommendation_processor(
    transaction: &mut Transaction<'_, Postgres>,
    trigger: &str,
) -> ApiResult<()> {
    let job_id = sqlx::query_scalar::<_, Option<i64>>(
        r#"
        select public.invoke_recommendation_processor(
            jsonb_build_object('trigger', $1)
        )
        "#,
    )
    .bind(trigger)
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_recommendation_error)?;

    if job_id.is_none() {
        tracing::warn!(
            trigger,
            "recommendation processor invoke skipped because required Vault secrets are missing",
        );
    }

    Ok(())
}

async fn enqueue_recommendation_refresh(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Option<Uuid>,
    content_id: Option<Uuid>,
    source_id: Option<Uuid>,
    trigger: &str,
    delay_seconds: i32,
) -> ApiResult<()> {
    sqlx::query_scalar::<_, i64>(
        r#"
        select public.enqueue_recommendation_refresh($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(user_id)
    .bind(content_id)
    .bind(source_id)
    .bind(trigger)
    .bind(delay_seconds)
    .bind(0_i32)
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_recommendation_error)?;

    Ok(())
}

async fn load_user_recommendation_context(
    pool: &PgPool,
    user_id: Uuid,
) -> ApiResult<UserRecommendationContext> {
    let preferred_languages = sqlx::query_scalar::<_, Vec<String>>(
        r#"
        select preferred_languages
        from public.user_recommendation_settings
        where user_id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(map_recommendation_error)?
    .unwrap_or_default();

    let subscribed_source_ids = sqlx::query_scalar::<_, Uuid>(
        r#"
        select source_id
        from public.source_subscriptions
        where user_id = $1
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)?
    .into_iter()
    .collect::<HashSet<_>>();

    let top_topic_ids = sqlx::query_scalar::<_, Uuid>(
        r#"
        select topic_id
        from public.user_topic_affinity
        where user_id = $1 and score > 0
        order by score desc, topic_id asc
        limit 10
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)?;

    let top_source_ids = sqlx::query_scalar::<_, Uuid>(
        r#"
        select source_id
        from public.user_source_affinity
        where user_id = $1 and score > 0
        order by score desc, source_id asc
        limit 10
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)?;

    Ok(UserRecommendationContext {
        preferred_languages,
        subscribed_source_ids,
        top_topic_ids,
        top_source_ids,
    })
}

fn collect_content_candidates(
    out: &mut HashMap<Uuid, ContentCandidateBuckets>,
    rows: Vec<RecommendationContentSeedRow>,
    bucket: ContentCandidateBucket,
) {
    for row in rows {
        out.entry(row.content_id)
            .and_modify(|existing| existing.merge_bucket(bucket))
            .or_insert_with(|| ContentCandidateBuckets::from_bucket(bucket));
    }
}

async fn fetch_subscribed_content_candidates(
    pool: &PgPool,
    user_id: Uuid,
) -> ApiResult<Vec<RecommendationContentSeedRow>> {
    sqlx::query_as::<_, RecommendationContentSeedRow>(
        r#"
        select distinct
            i.content_id
        from public.subscription_inbox i
        join public.content c on c.id = i.content_id
        where i.user_id = $1
          and i.dismissed_at is null
          and c.parse_status = 'succeeded'
          and c.parsed_document is not null
          and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '30 days'
          and not exists (
              select 1
              from public.saved_content sc
              where sc.user_id = $1
                and sc.content_id = i.content_id
                and sc.archived_at is null
          )
          and not exists (
              select 1
              from public.user_content_feedback ucf
              where ucf.user_id = $1
                and ucf.content_id = i.content_id
                and ucf.dismiss_count > 0
          )
        order by i.content_id
        limit 200
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

async fn fetch_discovery_content_candidates(
    pool: &PgPool,
    user_id: Uuid,
    preferred_languages: &[String],
) -> ApiResult<Vec<RecommendationContentSeedRow>> {
    sqlx::query_as::<_, RecommendationContentSeedRow>(
        r#"
        select
            c.id as content_id
        from public.content c
        where c.parse_status = 'succeeded'
          and c.parsed_document is not null
          and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '30 days'
          and not exists (
              select 1
              from public.source_subscriptions ss
              where ss.user_id = $1
                and ss.source_id = c.source_id
          )
          and not exists (
              select 1
              from public.saved_content sc
              where sc.user_id = $1
                and sc.content_id = c.id
                and sc.archived_at is null
          )
          and not exists (
              select 1
              from public.user_content_feedback ucf
              where ucf.user_id = $1
                and ucf.content_id = c.id
                and ucf.dismiss_count > 0
          )
          and (
              cardinality($2::text[]) = 0
              or c.language_code is null
              or c.language_code = any($2)
          )
        order by coalesce(c.published_at, c.created_at) desc, c.id desc
        limit 200
        "#,
    )
    .bind(user_id)
    .bind(preferred_languages)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

async fn fetch_saved_adjacent_content_candidates(
    pool: &PgPool,
    user_id: Uuid,
    topic_ids: &[Uuid],
    source_ids: &[Uuid],
) -> ApiResult<Vec<RecommendationContentSeedRow>> {
    if topic_ids.is_empty() && source_ids.is_empty() {
        return Ok(Vec::new());
    }

    sqlx::query_as::<_, RecommendationContentSeedRow>(
        r#"
        select distinct
            c.id as content_id
        from public.content c
        where c.parse_status = 'succeeded'
          and c.parsed_document is not null
          and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '60 days'
          and (
              (
                  cardinality($2::uuid[]) > 0
                  and (
                      exists (
                          select 1
                          from public.content_topics ct
                          where ct.content_id = c.id
                            and ct.topic_id = any($2)
                      )
                      or exists (
                          select 1
                          from public.source_topics st
                          where st.source_id = c.source_id
                            and st.topic_id = any($2)
                      )
                  )
              )
              or (
                  cardinality($3::uuid[]) > 0
                  and c.source_id = any($3)
              )
          )
          and not exists (
              select 1
              from public.saved_content sc
              where sc.user_id = $1
                and sc.content_id = c.id
                and sc.archived_at is null
          )
          and not exists (
              select 1
              from public.user_content_feedback ucf
              where ucf.user_id = $1
                and ucf.content_id = c.id
                and ucf.dismiss_count > 0
          )
        order by coalesce(c.published_at, c.created_at) desc, c.id desc
        limit 200
        "#,
    )
    .bind(user_id)
    .bind(topic_ids)
    .bind(source_ids)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

async fn fetch_trending_content_candidates(
    pool: &PgPool,
    user_id: Uuid,
    preferred_languages: &[String],
) -> ApiResult<Vec<RecommendationContentSeedRow>> {
    sqlx::query_as::<_, RecommendationContentSeedRow>(
        r#"
        with halo as (
            select
                content_id,
                avg(score) as average_score
            from public.content_halo_daily
            where halo_date >= current_date - 14
            group by content_id
        )
        select
            c.id as content_id
        from halo
        join public.content c on c.id = halo.content_id
        where c.parse_status = 'succeeded'
          and c.parsed_document is not null
          and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '14 days'
          and not exists (
              select 1
              from public.saved_content sc
              where sc.user_id = $1
                and sc.content_id = c.id
                and sc.archived_at is null
          )
          and not exists (
              select 1
              from public.user_content_feedback ucf
              where ucf.user_id = $1
                and ucf.content_id = c.id
                and ucf.dismiss_count > 0
          )
          and (
              cardinality($2::text[]) = 0
              or c.language_code is null
              or c.language_code = any($2)
          )
        order by halo.average_score desc, coalesce(c.published_at, c.created_at) desc
        limit 200
        "#,
    )
    .bind(user_id)
    .bind(preferred_languages)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

async fn fetch_recommendation_content_rows(
    pool: &PgPool,
    content_ids: &[Uuid],
) -> ApiResult<Vec<RecommendationContentRow>> {
    if content_ids.is_empty() {
        return Ok(Vec::new());
    }

    sqlx::query_as::<_, RecommendationContentRow>(
        r#"
        select
            c.id as content_id,
            c.source_id,
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
            c.created_at,
            cs.source_url,
            cs.resolved_source_url,
            cs.host as source_host,
            cs.title as source_title,
            cs.source_kind as source_kind_label,
            sf.feed_url as primary_feed_url
        from public.content c
        left join public.content_sources cs on cs.id = c.source_id
        left join lateral (
            select feed_url
            from public.source_feeds
            where source_id = c.source_id
              and is_primary
            order by created_at asc
            limit 1
        ) sf on true
        where c.id = any($1)
        "#,
    )
    .bind(content_ids)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

async fn fetch_content_topic_scores(
    pool: &PgPool,
    user_id: Uuid,
    content_ids: &[Uuid],
) -> ApiResult<HashMap<Uuid, TopicScore>> {
    if content_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query_as::<_, TopicScoreRow>(
        r#"
        with topic_matches as (
            select
                ct.content_id,
                t.slug,
                greatest(uta.score, 0) * ct.confidence as weighted_score
            from public.content_topics ct
            join public.user_topic_affinity uta
              on uta.topic_id = ct.topic_id
             and uta.user_id = $1
            join public.topics t on t.id = ct.topic_id
            where ct.content_id = any($2)

            union all

            select
                c.id as content_id,
                t.slug,
                greatest(uta.score, 0) * st.confidence * 0.75 as weighted_score
            from public.content c
            join public.source_topics st on st.source_id = c.source_id
            join public.user_topic_affinity uta
              on uta.topic_id = st.topic_id
             and uta.user_id = $1
            join public.topics t on t.id = st.topic_id
            where c.id = any($2)
        )
        select
            content_id,
            max(weighted_score) as score,
            (array_agg(slug order by weighted_score desc, slug asc))[1] as primary_topic_slug
        from topic_matches
        group by content_id
        "#,
    )
    .bind(user_id)
    .bind(content_ids)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.id,
                TopicScore {
                    score: row.score,
                    primary_topic_slug: row.primary_topic_slug,
                },
            )
        })
        .collect())
}

async fn fetch_user_source_affinity_scores(
    pool: &PgPool,
    user_id: Uuid,
    source_ids: &[Uuid],
) -> ApiResult<HashMap<Uuid, f64>> {
    if source_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query_as::<_, SourceScoreRow>(
        r#"
        select source_id, score
        from public.user_source_affinity
        where user_id = $1
          and source_id = any($2)
        "#,
    )
    .bind(user_id)
    .bind(source_ids)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)?;

    Ok(rows.into_iter().map(|row| (row.id, row.score)).collect())
}

async fn fetch_recent_content_halos(
    pool: &PgPool,
    content_ids: &[Uuid],
    days: i32,
) -> ApiResult<HashMap<Uuid, f64>> {
    if content_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query_as::<_, SourceScoreRow>(
        r#"
        select content_id as source_id, avg(score) as score
        from public.content_halo_daily
        where content_id = any($1)
          and halo_date >= current_date - $2
        group by content_id
        "#,
    )
    .bind(content_ids)
    .bind(days)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)?;

    Ok(rows.into_iter().map(|row| (row.id, row.score)).collect())
}

async fn fetch_recent_source_halos(
    pool: &PgPool,
    source_ids: &[Uuid],
    days: i32,
) -> ApiResult<HashMap<Uuid, f64>> {
    if source_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query_as::<_, SourceScoreRow>(
        r#"
        select source_id, avg(score) as score
        from public.source_halo_daily
        where source_id = any($1)
          and halo_date >= current_date - $2
        group by source_id
        "#,
    )
    .bind(source_ids)
    .bind(days)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)?;

    Ok(rows.into_iter().map(|row| (row.id, row.score)).collect())
}

async fn fetch_user_content_feedback_scores(
    pool: &PgPool,
    user_id: Uuid,
    content_ids: &[Uuid],
) -> ApiResult<HashMap<Uuid, UserContentFeedbackRow>> {
    if content_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query_as::<_, UserContentFeedbackRow>(
        r#"
        select
            content_id,
            dismiss_count,
            mark_read_count,
            read_ratio
        from public.user_content_feedback
        where user_id = $1
          and content_id = any($2)
        "#,
    )
    .bind(user_id)
    .bind(content_ids)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)?;

    Ok(rows.into_iter().map(|row| (row.content_id, row)).collect())
}

async fn fetch_topic_source_candidates(pool: &PgPool, topic_ids: &[Uuid]) -> ApiResult<Vec<Uuid>> {
    if topic_ids.is_empty() {
        return Ok(Vec::new());
    }

    sqlx::query_scalar::<_, Uuid>(
        r#"
        select distinct st.source_id
        from public.source_topics st
        where st.topic_id = any($1)
        limit 200
        "#,
    )
    .bind(topic_ids)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

async fn fetch_recent_source_candidates(
    pool: &PgPool,
    user_id: Uuid,
    preferred_languages: &[String],
) -> ApiResult<Vec<Uuid>> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        select distinct c.source_id
        from public.content c
        where c.source_id is not null
          and c.parse_status = 'succeeded'
          and c.parsed_document is not null
          and coalesce(c.published_at, c.created_at) >= timezone('utc', now()) - interval '30 days'
          and not exists (
              select 1
              from public.source_subscriptions ss
              where ss.user_id = $1
                and ss.source_id = c.source_id
          )
          and (
              cardinality($2::text[]) = 0
              or c.language_code is null
              or c.language_code = any($2)
          )
        order by c.source_id
        limit 200
        "#,
    )
    .bind(user_id)
    .bind(preferred_languages)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

async fn fetch_similar_source_candidates(
    pool: &PgPool,
    user_id: Uuid,
    source_ids: &[Uuid],
) -> ApiResult<Vec<Uuid>> {
    if source_ids.is_empty() {
        return Ok(Vec::new());
    }

    sqlx::query_scalar::<_, Uuid>(
        r#"
        with engaged_topics as (
            select distinct st.topic_id
            from public.user_source_affinity usa
            join public.source_topics st on st.source_id = usa.source_id
            where usa.user_id = $1
              and usa.score > 0
        )
        select distinct st.source_id
        from public.source_topics st
        join engaged_topics et on et.topic_id = st.topic_id
        where st.source_id <> all($2)
        limit 200
        "#,
    )
    .bind(user_id)
    .bind(source_ids)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

async fn fetch_recommendation_source_rows(
    pool: &PgPool,
    source_ids: &[Uuid],
) -> ApiResult<Vec<RecommendationSourceRow>> {
    if source_ids.is_empty() {
        return Ok(Vec::new());
    }

    sqlx::query_as::<_, RecommendationSourceRow>(
        r#"
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
            sf.feed_url as primary_feed_url
        from public.content_sources cs
        left join lateral (
            select feed_url
            from public.source_feeds
            where source_id = cs.id
              and is_primary
            order by created_at asc
            limit 1
        ) sf on true
        where cs.id = any($1)
        "#,
    )
    .bind(source_ids)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)
}

async fn fetch_source_topic_scores(
    pool: &PgPool,
    user_id: Uuid,
    source_ids: &[Uuid],
) -> ApiResult<HashMap<Uuid, TopicScore>> {
    if source_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query_as::<_, TopicScoreRow>(
        r#"
        select
            st.source_id as content_id,
            max(greatest(uta.score, 0) * st.confidence) as score,
            (array_agg(t.slug order by greatest(uta.score, 0) * st.confidence desc, t.slug asc))[1] as primary_topic_slug
        from public.source_topics st
        join public.user_topic_affinity uta
          on uta.topic_id = st.topic_id
         and uta.user_id = $1
        join public.topics t on t.id = st.topic_id
        where st.source_id = any($2)
        group by st.source_id
        "#,
    )
    .bind(user_id)
    .bind(source_ids)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.id,
                TopicScore {
                    score: row.score,
                    primary_topic_slug: row.primary_topic_slug,
                },
            )
        })
        .collect())
}

async fn fetch_source_recent_activity(
    pool: &PgPool,
    source_ids: &[Uuid],
    days: i32,
) -> ApiResult<HashMap<Uuid, i64>> {
    if source_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query_as::<_, SourceActivityRow>(
        r#"
        select source_id, count(*)::bigint as activity_count
        from public.content
        where source_id = any($1)
          and parse_status = 'succeeded'
          and parsed_document is not null
          and coalesce(published_at, created_at) >= timezone('utc', now()) - make_interval(days => greatest($2, 1))
        group by source_id
        "#,
    )
    .bind(source_ids)
    .bind(days)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)?;

    Ok(rows
        .into_iter()
        .map(|row| (row.source_id, row.activity_count))
        .collect())
}

async fn fetch_source_similarity_scores(
    pool: &PgPool,
    user_id: Uuid,
    source_ids: &[Uuid],
) -> ApiResult<HashMap<Uuid, f64>> {
    if source_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query_as::<_, SourceScoreRow>(
        r#"
        with engaged_topics as (
            select
                st.topic_id,
                max(greatest(usa.score, 0)) as affinity_score
            from public.user_source_affinity usa
            join public.source_topics st on st.source_id = usa.source_id
            where usa.user_id = $1
              and usa.score > 0
            group by st.topic_id
        )
        select
            st.source_id,
            coalesce(avg(least(et.affinity_score * st.confidence, 2.0)), 0) as score
        from public.source_topics st
        join engaged_topics et on et.topic_id = st.topic_id
        where st.source_id = any($2)
        group by st.source_id
        "#,
    )
    .bind(user_id)
    .bind(source_ids)
    .fetch_all(pool)
    .await
    .map_err(map_recommendation_error)?;

    Ok(rows.into_iter().map(|row| (row.id, row.score)).collect())
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
        host: candidate.row.source_host.clone().unwrap_or_else(|| candidate.row.host.clone()),
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
    Ok(SourceRecommendationItem {
        position: position as u32,
        is_subscribed: false,
        source: RecommendationSourceSummary {
            id: candidate.row.source_id,
            source_url: candidate.row.source_url,
            resolved_source_url: candidate.row.resolved_source_url,
            host: candidate.row.source_host,
            title: candidate.row.source_title,
            description: candidate.row.source_description,
            source_kind: SourceKind::from_str(&candidate.row.source_kind)
                .map_err(|_| ApiError::internal("Stored source kind was invalid"))?,
            primary_feed_url: candidate.row.primary_feed_url,
            refresh_status: RecommendationSourceRefreshStatus::from_db(
                &candidate.row.refresh_status,
            )?,
            last_refreshed_at: maybe_timestamp_seconds(candidate.row.last_refreshed_at),
        },
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

async fn enqueue_public_interaction_refreshes(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    events: &[ValidatedInteractionEvent],
) -> ApiResult<()> {
    let mut unique_targets = HashSet::new();
    for event in events {
        unique_targets.insert((event.content_id, event.source_id));
    }

    for (content_id, source_id) in unique_targets {
        enqueue_recommendation_refresh(
            transaction,
            Some(user_id),
            content_id,
            source_id,
            "event",
            0,
        )
        .await?;
    }

    Ok(())
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

fn repeat_penalty(feedback: &UserContentFeedbackRow) -> f64 {
    if feedback.mark_read_count > 0 || feedback.read_ratio >= 0.8 {
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

    const fn default_trigger(self) -> &'static str {
        match self {
            Self::Save => "save",
            Self::Subscribe => "subscribe",
            Self::Unsubscribe => "unsubscribe",
            Self::Favorite | Self::MarkRead | Self::Dismiss => "event",
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
    top_topic_ids: Vec<Uuid>,
    top_source_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Copy)]
enum ContentCandidateBucket {
    SubscribedInbox,
    Discovery,
    SavedAdjacent,
    Trending,
}

#[derive(Debug, Default)]
struct ContentCandidateBuckets {
    subscribed_inbox: bool,
    discovery: bool,
    saved_adjacent: bool,
    trending: bool,
}

impl ContentCandidateBuckets {
    fn from_bucket(bucket: ContentCandidateBucket) -> Self {
        let mut value = Self::default();
        value.merge_bucket(bucket);
        value
    }

    fn merge_bucket(&mut self, bucket: ContentCandidateBucket) {
        match bucket {
            ContentCandidateBucket::SubscribedInbox => self.subscribed_inbox = true,
            ContentCandidateBucket::Discovery => self.discovery = true,
            ContentCandidateBucket::SavedAdjacent => self.saved_adjacent = true,
            ContentCandidateBucket::Trending => self.trending = true,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "subscribed_inbox": self.subscribed_inbox,
            "discovery": self.discovery,
            "saved_adjacent": self.saved_adjacent,
            "trending": self.trending,
        })
    }
}

#[derive(Debug)]
struct ScoredContentCandidate {
    row: RecommendationContentRow,
    primary_topic_slug: Option<String>,
    score: f64,
    score_breakdown: Value,
}

#[derive(Debug)]
struct ScoredSourceCandidate {
    row: RecommendationSourceRow,
    primary_topic_slug: Option<String>,
    score: f64,
    score_breakdown: Value,
}

#[derive(Debug)]
struct TopicScore {
    score: f64,
    primary_topic_slug: Option<String>,
}

#[derive(Debug, FromRow)]
struct TopicScoreRow {
    #[sqlx(rename = "content_id")]
    id: Uuid,
    score: f64,
    primary_topic_slug: Option<String>,
}

#[derive(Debug, FromRow)]
struct RecommendationContentSeedRow {
    content_id: Uuid,
}

#[derive(Debug, FromRow)]
struct RecommendationContentRow {
    content_id: Uuid,
    source_id: Option<Uuid>,
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
}

#[derive(Debug, FromRow)]
struct RecommendationSourceRow {
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
struct SourceScoreRow {
    #[sqlx(rename = "source_id")]
    id: Uuid,
    score: f64,
}

#[derive(Debug, FromRow)]
struct SourceActivityRow {
    source_id: Uuid,
    activity_count: i64,
}

#[derive(Debug, FromRow)]
struct UserContentFeedbackRow {
    content_id: Uuid,
    dismiss_count: i32,
    mark_read_count: i32,
    read_ratio: f64,
}

#[derive(Debug, FromRow)]
struct TopicRow {
    id: Uuid,
}

#[cfg(test)]
mod tests {
    use super::{
        ContentCandidateBucket, ContentCandidateBuckets, InternalEventType,
        PublicInteractionEventType, freshness_score, normalize_language_codes,
        normalize_positive_score, normalize_topic_slugs, validate_public_interaction_event,
    };
    use axum::response::IntoResponse;
    use serde_json::json;
    use uuid::Uuid;

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
    fn bucket_json_reflects_merged_state() {
        let mut buckets = ContentCandidateBuckets::from_bucket(ContentCandidateBucket::Discovery);
        buckets.merge_bucket(ContentCandidateBucket::Trending);

        assert_eq!(
            buckets.to_json(),
            json!({
                "subscribed_inbox": false,
                "discovery": true,
                "saved_adjacent": false,
                "trending": true,
            })
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

    #[test]
    fn internal_event_triggers_match_expected_routes() {
        assert_eq!(InternalEventType::Save.default_trigger(), "save");
        assert_eq!(InternalEventType::Subscribe.default_trigger(), "subscribe");
        assert_eq!(InternalEventType::Favorite.default_trigger(), "event");
    }
}
