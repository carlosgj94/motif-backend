use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderValue, StatusCode, header::CONTENT_TYPE},
    response::IntoResponse,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool, Postgres, QueryBuilder, Transaction, types::Json as SqlxJson};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedUser,
    content::{
        NormalizedUrl, ProcessingStatus, ReadState, SourceKind, TagScope, normalize_tag_slug,
    },
    embedded_content::{
        CompactContentBody, build_compact_content_body, maybe_timestamp_seconds,
        parse_db_processing_status, parse_db_read_state, parse_db_tag_scope,
        parse_optional_source_kind, timestamp_seconds,
    },
    error::{ApiError, ApiResult},
    recommendations::{
        InternalEventType, record_internal_content_event, sync_recommendation_targets_for_signal,
    },
    source_subscriptions::{enqueue_source_refresh, invoke_source_processor},
};

const DEFAULT_PAGE_SIZE: u32 = 20;
const MAX_PAGE_SIZE: u32 = 100;

pub async fn save_saved_content(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Json(payload): Json<SaveSavedContentRequest>,
) -> ApiResult<impl IntoResponse> {
    let normalized_url = NormalizedUrl::parse(&payload.url)?;
    let normalized_tag_slugs = payload
        .tag_slugs
        .map(normalize_requested_tag_slugs)
        .transpose()?;

    let mut transaction = state.pool.begin().await.map_err(map_saved_content_error)?;

    let content = get_or_create_content(&mut transaction, &normalized_url).await?;
    let existing_id =
        find_existing_saved_content_id(&mut transaction, user.user_id, content.id).await?;
    let saved_content_id = upsert_saved_content(
        &mut transaction,
        user.user_id,
        content.id,
        &normalized_url.submitted_url,
    )
    .await?;

    if let Some(tag_slugs) = normalized_tag_slugs.as_deref() {
        replace_saved_content_tags(&mut transaction, user.user_id, saved_content_id, tag_slugs)
            .await?;
        touch_saved_content(&mut transaction, saved_content_id).await?;
    }

    let mut invoke_recommendations = false;
    if existing_id.is_none() {
        record_internal_content_event(
            &mut transaction,
            user.user_id,
            content.id,
            None,
            InternalEventType::Save,
            "saved_content",
        )
        .await?;
        invoke_recommendations = true;
    }

    let should_enqueue_processing = should_enqueue_content_processing(&content);
    if should_enqueue_processing {
        enqueue_content_processing(&mut transaction, content.id, "save", 0).await?;
        invoke_content_processor(&mut transaction, content.id, "save").await?;
    }

    if invoke_recommendations {
        sync_recommendation_targets_for_signal(
            &mut transaction,
            Some(user.user_id),
            Some(content.id),
            None,
        )
        .await?;
    }

    transaction
        .commit()
        .await
        .map_err(map_saved_content_error)?;

    attempt_source_discovery_for_saved_content(&state.pool, &normalized_url, content.id).await;

    let summary = fetch_saved_content_summary(&state.pool, user.user_id, saved_content_id)
        .await?
        .ok_or_else(|| ApiError::internal("Saved content disappeared after save"))?;

    let status = if existing_id.is_some() {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };

    Ok((status, Json(summary)))
}

pub async fn list_saved_content(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Query(query): Query<ListSavedContentQuery>,
) -> ApiResult<Json<SavedContentListResponse>> {
    let limit = normalize_page_size(query.limit)?;
    let cursor = query.cursor.as_deref().map(decode_cursor).transpose()?;
    let tag_slug = query.tag.as_deref().map(normalize_tag_slug).transpose()?;

    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        select
            s.id as saved_content_id,
            s.submitted_url,
            s.read_state,
            s.is_favorited,
            s.archived_at,
            s.created_at,
            s.updated_at,
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
            c.parsed_at
        from public.saved_content s
        join public.content c on c.id = s.content_id
        where s.user_id =
        "#,
    );
    builder.push_bind(user.user_id);

    match query.archived {
        Some(true) => builder.push(" and s.archived_at is not null"),
        Some(false) | None => builder.push(" and s.archived_at is null"),
    };

    if let Some(read_state) = query.read_state {
        builder.push(" and s.read_state = ");
        builder.push_bind(read_state.as_str());
    }

    if let Some(favorited) = query.favorited {
        builder.push(" and s.is_favorited = ");
        builder.push_bind(favorited);
    }

    if let Some(tag_slug) = tag_slug.as_deref() {
        builder.push(
            r#"
            and exists (
                select 1
                from public.saved_content_tags sct
                join public.tags t on t.id = sct.tag_id
                where sct.saved_content_id = s.id
                  and t.slug =
            "#,
        );
        builder.push_bind(tag_slug);
        builder.push(" and (t.owner_user_id is null or t.owner_user_id = ");
        builder.push_bind(user.user_id);
        builder.push("))");
    }

    if let Some(cursor) = cursor {
        builder.push(" and (s.updated_at, s.id) < (");
        builder.push_bind(cursor.updated_at);
        builder.push(", ");
        builder.push_bind(cursor.saved_content_id);
        builder.push(")");
    }

    builder.push(" order by s.updated_at desc, s.id desc limit ");
    builder.push_bind(i64::from(limit) + 1);

    let mut rows = builder
        .build_query_as::<SavedContentSummaryRow>()
        .fetch_all(&state.pool)
        .await
        .map_err(map_saved_content_error)?;

    let next_cursor = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        rows.last().map(encode_cursor)
    } else {
        None
    };

    let content = build_saved_content_summaries(&state.pool, user.user_id, rows).await?;

    Ok(Json(SavedContentListResponse {
        content,
        next_cursor,
    }))
}

pub async fn get_saved_content(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Path(saved_content_id): Path<Uuid>,
) -> ApiResult<Json<SavedContentDetail>> {
    let row = fetch_saved_content_detail_row(&state.pool, user.user_id, saved_content_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Saved content was not found"))?;

    let mut tags_by_content =
        list_tags_for_saved_content(&state.pool, user.user_id, &[saved_content_id]).await?;
    let tags = tags_by_content
        .remove(&saved_content_id)
        .unwrap_or_default();

    Ok(Json(build_saved_content_detail(row, tags)?))
}

pub async fn update_saved_content(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Path(saved_content_id): Path<Uuid>,
    Json(payload): Json<UpdateSavedContentRequest>,
) -> ApiResult<Json<SavedContentSummary>> {
    if payload.read_state.is_none()
        && payload.is_favorited.is_none()
        && payload.is_archived.is_none()
        && payload.tag_slugs.is_none()
    {
        return Err(ApiError::bad_request("At least one field must be provided"));
    }

    let normalized_tag_slugs = payload
        .tag_slugs
        .map(normalize_requested_tag_slugs)
        .transpose()?;

    let mut transaction = state.pool.begin().await.map_err(map_saved_content_error)?;
    let existing = fetch_saved_content_update_row(&mut transaction, user.user_id, saved_content_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Saved content was not found"))?;

    let next_read_state = payload.read_state.unwrap_or(existing.read_state);
    let next_is_favorited = payload.is_favorited.unwrap_or(existing.is_favorited);
    let next_archived_at = match payload.is_archived {
        Some(true) => Some(OffsetDateTime::now_utc()),
        Some(false) => None,
        None => existing.archived_at,
    };
    let next_read_completed_at = match next_read_state {
        ReadState::Read => existing
            .read_completed_at
            .or_else(|| Some(OffsetDateTime::now_utc())),
        ReadState::Unread | ReadState::Reading => None,
    };
    let became_favorited = !existing.is_favorited && next_is_favorited;
    let became_read = existing.read_state != ReadState::Read && next_read_state == ReadState::Read;

    apply_saved_content_update(
        &mut transaction,
        saved_content_id,
        next_read_state,
        next_is_favorited,
        next_archived_at,
        next_read_completed_at,
    )
    .await?;

    if let Some(tag_slugs) = normalized_tag_slugs.as_deref() {
        replace_saved_content_tags(&mut transaction, user.user_id, saved_content_id, tag_slugs)
            .await?;
        touch_saved_content(&mut transaction, saved_content_id).await?;
    }

    let mut invoke_recommendations = false;
    if became_favorited {
        record_internal_content_event(
            &mut transaction,
            user.user_id,
            existing.content_id,
            None,
            InternalEventType::Favorite,
            "saved_content",
        )
        .await?;
        invoke_recommendations = true;
    }

    if became_read {
        record_internal_content_event(
            &mut transaction,
            user.user_id,
            existing.content_id,
            None,
            InternalEventType::MarkRead,
            "saved_content",
        )
        .await?;
        invoke_recommendations = true;
    }

    if invoke_recommendations {
        sync_recommendation_targets_for_signal(
            &mut transaction,
            Some(user.user_id),
            Some(existing.content_id),
            None,
        )
        .await?;
    }

    transaction
        .commit()
        .await
        .map_err(map_saved_content_error)?;

    let summary = fetch_saved_content_summary(&state.pool, user.user_id, saved_content_id)
        .await?
        .ok_or_else(|| ApiError::internal("Saved content disappeared after update"))?;

    Ok(Json(summary))
}

pub async fn delete_saved_content(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Path(saved_content_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let deleted = sqlx::query_scalar::<_, Uuid>(
        r#"
        delete from public.saved_content
        where id = $1 and user_id = $2
        returning id
        "#,
    )
    .bind(saved_content_id)
    .bind(user.user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(map_saved_content_error)?;

    match deleted {
        Some(_) => Ok(StatusCode::NO_CONTENT),
        None => Err(ApiError::not_found("Saved content was not found")),
    }
}

pub async fn list_content_tags(
    user: AuthenticatedUser,
    State(state): State<AppState>,
) -> ApiResult<Json<ContentTagListResponse>> {
    let rows = sqlx::query_as::<_, TagSummaryRow>(
        r#"
        with user_tag_counts as (
            select
                sct.tag_id,
                count(*)::bigint as content_count
            from public.saved_content sc
            join public.saved_content_tags sct on sct.saved_content_id = sc.id
            where sc.user_id = $1
            group by sct.tag_id
        )
        select
            t.id,
            t.slug,
            t.label,
            t.scope,
            coalesce(utc.content_count, 0)::bigint as content_count
        from public.tags t
        left join user_tag_counts utc on utc.tag_id = t.id
        where t.owner_user_id is null or t.owner_user_id = $1
        order by
            case when t.owner_user_id is null then 0 else 1 end,
            t.label asc
        "#,
    )
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(map_saved_content_error)?;

    Ok(Json(ContentTagListResponse {
        tags: rows
            .into_iter()
            .map(build_tag_summary)
            .collect::<ApiResult<Vec<_>>>()?,
    }))
}

pub async fn get_content_favicon(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Path(content_id): Path<Uuid>,
) -> ApiResult<impl IntoResponse> {
    let favicon = sqlx::query_as::<_, FaviconRow>(
        r#"
        select c.favicon_bytes, c.favicon_mime_type
        from public.content c
        join public.saved_content s on s.content_id = c.id
        where c.id = $1
          and s.user_id = $2
          and c.favicon_bytes is not null
          and c.favicon_mime_type is not null
        limit 1
        "#,
    )
    .bind(content_id)
    .bind(user.user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(map_saved_content_error)?
    .ok_or_else(|| ApiError::not_found("Favicon was not found"))?;

    let content_type = HeaderValue::from_str(&favicon.favicon_mime_type)
        .map_err(|_| ApiError::internal("Stored favicon MIME type was invalid"))?;

    Ok(([(CONTENT_TYPE, content_type)], favicon.favicon_bytes))
}

async fn get_or_create_content(
    transaction: &mut Transaction<'_, Postgres>,
    normalized_url: &NormalizedUrl,
) -> ApiResult<ContentProcessingStateRow> {
    sqlx::query_as::<_, ContentProcessingStateRow>(
        r#"
        with inserted as (
            insert into public.content (canonical_url, host)
            values ($1, $2)
            on conflict (canonical_url) do nothing
            returning
                id,
                fetch_status,
                parse_status,
                (parsed_document is not null) as has_parsed_document
        )
        select id, fetch_status, parse_status, has_parsed_document
        from inserted
        union all
        select
            id,
            fetch_status,
            parse_status,
            (parsed_document is not null) as has_parsed_document
        from public.content
        where canonical_url = $1
        limit 1
        "#,
    )
    .bind(&normalized_url.canonical_url)
    .bind(&normalized_url.host)
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_saved_content_error)
}

async fn attempt_source_discovery_for_saved_content(
    pool: &PgPool,
    normalized_url: &NormalizedUrl,
    content_id: Uuid,
) {
    let attempt = async {
        let mut transaction = pool.begin().await.map_err(map_saved_content_error)?;
        let source_id = load_linked_source_id(&mut transaction, content_id).await?;

        let source_id = match source_id {
            Some(source_id) => source_id,
            None => {
                let Some(source_candidate) = normalized_url.source_discovery_candidate()? else {
                    transaction
                        .rollback()
                        .await
                        .map_err(map_saved_content_error)?;
                    return Ok(());
                };

                let Some(source_id) =
                    find_source_id_by_url(&mut transaction, &source_candidate).await?
                else {
                    transaction
                        .rollback()
                        .await
                        .map_err(map_saved_content_error)?;
                    return Ok(());
                };

                link_content_to_source(&mut transaction, content_id, source_id).await?;
                source_id
            }
        };

        enqueue_source_refresh(&mut transaction, source_id, "save", 0).await?;
        invoke_source_processor(&mut transaction, source_id, "save").await?;
        transaction
            .commit()
            .await
            .map_err(map_saved_content_error)?;

        Ok::<(), ApiError>(())
    }
    .await;

    if let Err(error) = attempt {
        tracing::warn!(
            %content_id,
            url = %normalized_url.canonical_url,
            ?error,
            "saved-content source discovery attempt failed",
        );
    }
}

async fn load_linked_source_id(
    transaction: &mut Transaction<'_, Postgres>,
    content_id: Uuid,
) -> ApiResult<Option<Uuid>> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        select source_id
        from public.content
        where id = $1
          and source_id is not null
        "#,
    )
    .bind(content_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_saved_content_error)
}

async fn find_source_id_by_url(
    transaction: &mut Transaction<'_, Postgres>,
    source_candidate: &NormalizedUrl,
) -> ApiResult<Option<Uuid>> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        select id
        from public.content_sources
        where source_url = $1
        "#,
    )
    .bind(&source_candidate.canonical_url)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_saved_content_error)
}

async fn link_content_to_source(
    transaction: &mut Transaction<'_, Postgres>,
    content_id: Uuid,
    source_id: Uuid,
) -> ApiResult<()> {
    sqlx::query(
        r#"
        update public.content
        set source_id = $2,
            updated_at = timezone('utc', now())
        where id = $1
          and source_id is null
        "#,
    )
    .bind(content_id)
    .bind(source_id)
    .execute(&mut **transaction)
    .await
    .map_err(map_saved_content_error)?;

    Ok(())
}
async fn enqueue_content_processing(
    transaction: &mut Transaction<'_, Postgres>,
    content_id: Uuid,
    trigger: &str,
    delay_seconds: i32,
) -> ApiResult<()> {
    sqlx::query_scalar::<_, i64>(
        r#"
        select public.enqueue_content_processing($1, $2, $3, $4)
        "#,
    )
    .bind(content_id)
    .bind(trigger)
    .bind(delay_seconds)
    .bind(0_i32)
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_saved_content_error)?;

    Ok(())
}

async fn invoke_content_processor(
    transaction: &mut Transaction<'_, Postgres>,
    content_id: Uuid,
    trigger: &str,
) -> ApiResult<()> {
    let job_id = sqlx::query_scalar::<_, Option<i64>>(
        r#"
        select public.invoke_content_processor(
            jsonb_build_object(
                'content_id', $1,
                'trigger', $2
            )
        )
        "#,
    )
    .bind(content_id)
    .bind(trigger)
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_saved_content_error)?;

    if job_id.is_none() {
        tracing::warn!(
            %content_id,
            trigger,
            "content processor invoke skipped because required Vault secrets are missing",
        );
    }

    Ok(())
}

async fn find_existing_saved_content_id(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    content_id: Uuid,
) -> ApiResult<Option<Uuid>> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        select id
        from public.saved_content
        where user_id = $1 and content_id = $2
        "#,
    )
    .bind(user_id)
    .bind(content_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_saved_content_error)
}

async fn upsert_saved_content(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    content_id: Uuid,
    submitted_url: &str,
) -> ApiResult<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        insert into public.saved_content (user_id, content_id, submitted_url)
        values ($1, $2, $3)
        on conflict (user_id, content_id) do update
        set submitted_url = excluded.submitted_url,
            archived_at = null,
            updated_at = timezone('utc', now())
        returning id
        "#,
    )
    .bind(user_id)
    .bind(content_id)
    .bind(submitted_url)
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_saved_content_error)
}

async fn fetch_saved_content_summary(
    pool: &PgPool,
    user_id: Uuid,
    saved_content_id: Uuid,
) -> ApiResult<Option<SavedContentSummary>> {
    let row = fetch_saved_content_summary_row(pool, user_id, saved_content_id).await?;
    let Some(row) = row else {
        return Ok(None);
    };

    let mut tags_by_content =
        list_tags_for_saved_content(pool, user_id, &[saved_content_id]).await?;
    let tags = tags_by_content
        .remove(&saved_content_id)
        .unwrap_or_default();

    Ok(Some(build_saved_content_summary(row, tags)?))
}

async fn fetch_saved_content_summary_row(
    pool: &PgPool,
    user_id: Uuid,
    saved_content_id: Uuid,
) -> ApiResult<Option<SavedContentSummaryRow>> {
    sqlx::query_as::<_, SavedContentSummaryRow>(
        r#"
        select
            s.id as saved_content_id,
            s.submitted_url,
            s.read_state,
            s.is_favorited,
            s.archived_at,
            s.created_at,
            s.updated_at,
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
            c.parsed_at
        from public.saved_content s
        join public.content c on c.id = s.content_id
        where s.id = $1 and s.user_id = $2
        "#,
    )
    .bind(saved_content_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(map_saved_content_error)
}

async fn fetch_saved_content_detail_row(
    pool: &PgPool,
    user_id: Uuid,
    saved_content_id: Uuid,
) -> ApiResult<Option<SavedContentDetailRow>> {
    sqlx::query_as::<_, SavedContentDetailRow>(
        r#"
        select
            s.id as saved_content_id,
            s.submitted_url,
            s.read_state,
            s.is_favorited,
            s.archived_at,
            s.created_at,
            s.updated_at,
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
        from public.saved_content s
        join public.content c on c.id = s.content_id
        where s.id = $1 and s.user_id = $2
        "#,
    )
    .bind(saved_content_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(map_saved_content_error)
}

async fn build_saved_content_summaries(
    pool: &PgPool,
    user_id: Uuid,
    rows: Vec<SavedContentSummaryRow>,
) -> ApiResult<Vec<SavedContentSummary>> {
    let saved_content_ids: Vec<Uuid> = rows.iter().map(|row| row.saved_content_id).collect();
    let mut tags_by_content =
        list_tags_for_saved_content(pool, user_id, &saved_content_ids).await?;

    rows.into_iter()
        .map(|row| {
            let tags = tags_by_content
                .remove(&row.saved_content_id)
                .unwrap_or_default();
            build_saved_content_summary(row, tags)
        })
        .collect()
}

async fn list_tags_for_saved_content(
    pool: &PgPool,
    user_id: Uuid,
    saved_content_ids: &[Uuid],
) -> ApiResult<HashMap<Uuid, Vec<TagSummary>>> {
    if saved_content_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query_as::<_, SavedContentTagRow>(
        r#"
        select
            sct.saved_content_id,
            t.id,
            t.slug,
            t.label,
            t.scope,
            (
                select count(*)::bigint
                from public.saved_content_tags sct2
                join public.saved_content sc2 on sc2.id = sct2.saved_content_id
                where sct2.tag_id = t.id
                  and sc2.user_id = $1
            ) as content_count
        from public.saved_content_tags sct
        join public.tags t on t.id = sct.tag_id
        where sct.saved_content_id = any($2)
        order by
            case when t.owner_user_id is null then 0 else 1 end,
            t.label asc
        "#,
    )
    .bind(user_id)
    .bind(saved_content_ids)
    .fetch_all(pool)
    .await
    .map_err(map_saved_content_error)?;

    let mut grouped: HashMap<Uuid, Vec<TagSummary>> = HashMap::new();
    for row in rows {
        grouped
            .entry(row.saved_content_id)
            .or_default()
            .push(build_tag_summary(TagSummaryRow {
                id: row.id,
                slug: row.slug,
                label: row.label,
                scope: row.scope,
                content_count: row.content_count,
            })?);
    }

    Ok(grouped)
}

async fn fetch_saved_content_update_row(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    saved_content_id: Uuid,
) -> ApiResult<Option<SavedContentUpdateRow>> {
    sqlx::query_as::<_, SavedContentUpdateRowRaw>(
        r#"
        select read_state, is_favorited, archived_at, read_completed_at, content_id
        from public.saved_content
        where id = $1 and user_id = $2
        "#,
    )
    .bind(saved_content_id)
    .bind(user_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_saved_content_error)?
    .map(build_saved_content_update_row)
    .transpose()
}

async fn apply_saved_content_update(
    transaction: &mut Transaction<'_, Postgres>,
    saved_content_id: Uuid,
    read_state: ReadState,
    is_favorited: bool,
    archived_at: Option<OffsetDateTime>,
    read_completed_at: Option<OffsetDateTime>,
) -> ApiResult<()> {
    sqlx::query(
        r#"
        update public.saved_content
        set read_state = $2,
            is_favorited = $3,
            archived_at = $4,
            read_completed_at = $5,
            updated_at = timezone('utc', now())
        where id = $1
        "#,
    )
    .bind(saved_content_id)
    .bind(read_state.as_str())
    .bind(is_favorited)
    .bind(archived_at)
    .bind(read_completed_at)
    .execute(&mut **transaction)
    .await
    .map_err(map_saved_content_error)?;

    Ok(())
}

async fn touch_saved_content(
    transaction: &mut Transaction<'_, Postgres>,
    saved_content_id: Uuid,
) -> ApiResult<()> {
    sqlx::query(
        r#"
        update public.saved_content
        set updated_at = timezone('utc', now())
        where id = $1
        "#,
    )
    .bind(saved_content_id)
    .execute(&mut **transaction)
    .await
    .map_err(map_saved_content_error)?;

    Ok(())
}

async fn replace_saved_content_tags(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    saved_content_id: Uuid,
    tag_slugs: &[String],
) -> ApiResult<()> {
    let tag_ids = resolve_tag_ids(transaction, user_id, tag_slugs).await?;

    sqlx::query(
        r#"
        delete from public.saved_content_tags
        where saved_content_id = $1
        "#,
    )
    .bind(saved_content_id)
    .execute(&mut **transaction)
    .await
    .map_err(map_saved_content_error)?;

    if tag_ids.is_empty() {
        return Ok(());
    }

    let mut builder = QueryBuilder::<Postgres>::new(
        "insert into public.saved_content_tags (saved_content_id, tag_id) ",
    );
    builder.push_values(tag_ids, |mut separated, tag_id| {
        separated.push_bind(saved_content_id).push_bind(tag_id);
    });
    builder.push(" on conflict do nothing");

    builder
        .build()
        .execute(&mut **transaction)
        .await
        .map_err(map_saved_content_error)?;

    Ok(())
}

async fn resolve_tag_ids(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    tag_slugs: &[String],
) -> ApiResult<Vec<Uuid>> {
    if tag_slugs.is_empty() {
        return Ok(Vec::new());
    }

    let system_rows = sqlx::query_as::<_, ExistingTagRow>(
        r#"
        select id, slug
        from public.tags
        where owner_user_id is null
          and slug = any($1)
        "#,
    )
    .bind(tag_slugs)
    .fetch_all(&mut **transaction)
    .await
    .map_err(map_saved_content_error)?;

    let system_by_slug: HashMap<String, Uuid> = system_rows
        .into_iter()
        .map(|row| (row.slug, row.id))
        .collect();

    let missing_from_system: Vec<String> = tag_slugs
        .iter()
        .filter(|slug| !system_by_slug.contains_key(*slug))
        .cloned()
        .collect();

    let custom_rows = if missing_from_system.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, ExistingTagRow>(
            r#"
            select id, slug
            from public.tags
            where owner_user_id = $1
              and slug = any($2)
            "#,
        )
        .bind(user_id)
        .bind(&missing_from_system)
        .fetch_all(&mut **transaction)
        .await
        .map_err(map_saved_content_error)?
    };

    let mut custom_by_slug: HashMap<String, Uuid> = custom_rows
        .into_iter()
        .map(|row| (row.slug, row.id))
        .collect();

    let mut resolved = Vec::with_capacity(tag_slugs.len());
    for slug in tag_slugs {
        if let Some(id) = system_by_slug.get(slug) {
            resolved.push(*id);
            continue;
        }

        if let Some(id) = custom_by_slug.get(slug) {
            resolved.push(*id);
            continue;
        }

        let created_id = sqlx::query_scalar::<_, Uuid>(
            r#"
            insert into public.tags (owner_user_id, scope, slug, label)
            values ($1, 'custom', $2, $3)
            on conflict (owner_user_id, slug) where owner_user_id is not null do update
            set label = public.tags.label
            returning id
            "#,
        )
        .bind(user_id)
        .bind(slug)
        .bind(humanize_tag_slug(slug))
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_saved_content_error)?;

        custom_by_slug.insert(slug.clone(), created_id);
        resolved.push(created_id);
    }

    Ok(resolved)
}

fn build_saved_content_summary(
    row: SavedContentSummaryRow,
    tags: Vec<TagSummary>,
) -> ApiResult<SavedContentSummary> {
    let source_kind = parse_optional_source_kind(row.source_kind.as_deref())?;

    Ok(SavedContentSummary {
        id: row.saved_content_id,
        submitted_url: row.submitted_url,
        read_state: parse_db_read_state(&row.read_state)?,
        is_favorited: row.is_favorited,
        archived_at: maybe_timestamp_seconds(row.archived_at),
        created_at: timestamp_seconds(row.created_at),
        updated_at: timestamp_seconds(row.updated_at),
        tags,
        content: ContentSummary {
            id: row.content_id,
            canonical_url: row.canonical_url,
            resolved_url: row.resolved_url,
            host: row.host,
            site_name: row.site_name,
            source_kind,
            title: row.title,
            excerpt: row.excerpt,
            author: row.author,
            published_at: maybe_timestamp_seconds(row.published_at),
            language_code: row.language_code,
            has_favicon: row.has_favicon,
            favicon_href: row
                .has_favicon
                .then(|| format!("/me/content/{}/favicon", row.content_id)),
            fetch_status: parse_db_processing_status(&row.fetch_status)?,
            parse_status: parse_db_processing_status(&row.parse_status)?,
            parsed_at: maybe_timestamp_seconds(row.parsed_at),
        },
    })
}

fn build_saved_content_detail(
    row: SavedContentDetailRow,
    tags: Vec<TagSummary>,
) -> ApiResult<SavedContentDetail> {
    let source_kind = parse_optional_source_kind(row.source_kind.as_deref())?;
    let body = row
        .parsed_document
        .as_ref()
        .and_then(|value| build_compact_content_body(&value.0, source_kind));

    Ok(SavedContentDetail {
        id: row.saved_content_id,
        submitted_url: row.submitted_url,
        read_state: parse_db_read_state(&row.read_state)?,
        is_favorited: row.is_favorited,
        archived_at: maybe_timestamp_seconds(row.archived_at),
        created_at: timestamp_seconds(row.created_at),
        updated_at: timestamp_seconds(row.updated_at),
        tags,
        content: ContentDetail {
            id: row.content_id,
            canonical_url: row.canonical_url,
            resolved_url: row.resolved_url,
            host: row.host,
            site_name: row.site_name,
            source_kind,
            title: row.title,
            excerpt: row.excerpt,
            author: row.author,
            published_at: maybe_timestamp_seconds(row.published_at),
            language_code: row.language_code,
            has_favicon: row.has_favicon,
            favicon_href: row
                .has_favicon
                .then(|| format!("/me/content/{}/favicon", row.content_id)),
            fetch_status: parse_db_processing_status(&row.fetch_status)?,
            parse_status: parse_db_processing_status(&row.parse_status)?,
            parsed_at: maybe_timestamp_seconds(row.parsed_at),
            body,
        },
    })
}

fn build_tag_summary(row: TagSummaryRow) -> ApiResult<TagSummary> {
    Ok(TagSummary {
        id: row.id,
        slug: row.slug,
        label: row.label,
        scope: parse_db_tag_scope(&row.scope)?,
        content_count: row.content_count,
    })
}

fn build_saved_content_update_row(
    row: SavedContentUpdateRowRaw,
) -> ApiResult<SavedContentUpdateRow> {
    Ok(SavedContentUpdateRow {
        read_state: parse_db_read_state(&row.read_state)?,
        is_favorited: row.is_favorited,
        archived_at: row.archived_at,
        read_completed_at: row.read_completed_at,
        content_id: row.content_id,
    })
}

fn should_enqueue_content_processing(content: &ContentProcessingStateRow) -> bool {
    !content.has_parsed_document
        || matches!(
            (content.fetch_status.as_str(), content.parse_status.as_str(),),
            ("pending", _) | ("failed", _) | (_, "pending") | (_, "failed")
        )
}

fn normalize_page_size(limit: Option<u32>) -> ApiResult<u32> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err(ApiError::bad_request(format!(
            "limit must be between 1 and {MAX_PAGE_SIZE}"
        )));
    }

    Ok(limit)
}

fn normalize_requested_tag_slugs(tag_slugs: Vec<String>) -> ApiResult<Vec<String>> {
    let mut normalized = Vec::new();
    for tag_slug in tag_slugs {
        let slug = normalize_tag_slug(&tag_slug)?;
        if !normalized.contains(&slug) {
            normalized.push(slug);
        }
    }

    Ok(normalized)
}

fn humanize_tag_slug(slug: &str) -> String {
    slug.split('-')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let mut characters = segment.chars();
            let Some(first) = characters.next() else {
                return String::new();
            };

            format!(
                "{}{}",
                first.to_ascii_uppercase(),
                characters.collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn encode_cursor(row: &SavedContentSummaryRow) -> String {
    let cursor = SavedContentCursor {
        updated_at_unix_nanos: row.updated_at.unix_timestamp_nanos(),
        saved_content_id: row.saved_content_id,
    };

    let bytes = serde_json::to_vec(&cursor).expect("cursor serialization should not fail");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_cursor(cursor: &str) -> ApiResult<SavedContentCursorDecoded> {
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| ApiError::bad_request("cursor is invalid"))?;
    let decoded: SavedContentCursor =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::bad_request("cursor is invalid"))?;

    let updated_at = OffsetDateTime::from_unix_timestamp_nanos(decoded.updated_at_unix_nanos)
        .map_err(|_| ApiError::bad_request("cursor is invalid"))?;

    Ok(SavedContentCursorDecoded {
        updated_at,
        saved_content_id: decoded.saved_content_id,
    })
}

fn map_saved_content_error(error: sqlx::Error) -> ApiError {
    tracing::error!(error = %error, "saved content query failed");
    ApiError::internal("Database operation failed")
}

#[derive(Debug, Deserialize)]
pub struct SaveSavedContentRequest {
    url: String,
    #[serde(default)]
    tag_slugs: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSavedContentRequest {
    read_state: Option<ReadState>,
    is_favorited: Option<bool>,
    is_archived: Option<bool>,
    #[serde(default)]
    tag_slugs: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct ListSavedContentQuery {
    limit: Option<u32>,
    cursor: Option<String>,
    read_state: Option<ReadState>,
    favorited: Option<bool>,
    archived: Option<bool>,
    tag: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SavedContentListResponse {
    content: Vec<SavedContentSummary>,
    next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ContentTagListResponse {
    tags: Vec<TagSummary>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TagSummary {
    id: Uuid,
    slug: String,
    label: String,
    scope: TagScope,
    content_count: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ContentSummary {
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
    #[serde(skip_serializing_if = "Option::is_none")]
    favicon_href: Option<String>,
    fetch_status: ProcessingStatus,
    parse_status: ProcessingStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    parsed_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ContentDetail {
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
    #[serde(skip_serializing_if = "Option::is_none")]
    favicon_href: Option<String>,
    fetch_status: ProcessingStatus,
    parse_status: ProcessingStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    parsed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<CompactContentBody>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SavedContentSummary {
    id: Uuid,
    submitted_url: String,
    read_state: ReadState,
    is_favorited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    archived_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    tags: Vec<TagSummary>,
    content: ContentSummary,
}

#[derive(Debug, Serialize)]
pub struct SavedContentDetail {
    id: Uuid,
    submitted_url: String,
    read_state: ReadState,
    is_favorited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    archived_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    tags: Vec<TagSummary>,
    content: ContentDetail,
}

#[derive(Debug, Deserialize, Serialize)]
struct SavedContentCursor {
    updated_at_unix_nanos: i128,
    saved_content_id: Uuid,
}

#[derive(Debug)]
struct SavedContentCursorDecoded {
    updated_at: OffsetDateTime,
    saved_content_id: Uuid,
}

#[derive(Debug, FromRow)]
struct SavedContentSummaryRow {
    saved_content_id: Uuid,
    submitted_url: String,
    read_state: String,
    is_favorited: bool,
    archived_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
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
}

#[derive(Debug, FromRow)]
struct SavedContentDetailRow {
    saved_content_id: Uuid,
    submitted_url: String,
    read_state: String,
    is_favorited: bool,
    archived_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
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
struct SavedContentTagRow {
    saved_content_id: Uuid,
    id: Uuid,
    slug: String,
    label: String,
    scope: String,
    content_count: i64,
}

#[derive(Debug, FromRow)]
struct TagSummaryRow {
    id: Uuid,
    slug: String,
    label: String,
    scope: String,
    content_count: i64,
}

#[derive(Debug, FromRow)]
struct ExistingTagRow {
    id: Uuid,
    slug: String,
}

#[derive(Debug, FromRow)]
struct ContentProcessingStateRow {
    id: Uuid,
    fetch_status: String,
    parse_status: String,
    has_parsed_document: bool,
}

#[derive(Debug, FromRow)]
struct SavedContentUpdateRowRaw {
    read_state: String,
    is_favorited: bool,
    archived_at: Option<OffsetDateTime>,
    read_completed_at: Option<OffsetDateTime>,
    content_id: Uuid,
}

#[derive(Debug)]
struct SavedContentUpdateRow {
    read_state: ReadState,
    is_favorited: bool,
    archived_at: Option<OffsetDateTime>,
    read_completed_at: Option<OffsetDateTime>,
    content_id: Uuid,
}

#[derive(Debug, FromRow)]
struct FaviconRow {
    favicon_bytes: Vec<u8>,
    favicon_mime_type: String,
}

#[cfg(test)]
mod tests {
    use super::{
        ContentDetail, ContentProcessingStateRow, ContentSummary, SavedContentDetail,
        SavedContentSummary, SavedContentSummaryRow, TagSummary, decode_cursor, encode_cursor,
        humanize_tag_slug, normalize_page_size, normalize_requested_tag_slugs,
        should_enqueue_content_processing,
    };
    use crate::content::{ProcessingStatus, ReadState, SourceKind, TagScope};
    use crate::embedded_content::{
        CompactContentBlock, CompactContentBody, build_compact_content_body,
    };
    use serde_json::json;
    use time::OffsetDateTime;
    use uuid::Uuid;

    #[test]
    fn encodes_and_decodes_cursor_round_trip() {
        let row = SavedContentSummaryRow {
            saved_content_id: Uuid::nil(),
            submitted_url: "https://example.com".to_string(),
            read_state: "unread".to_string(),
            is_favorited: false,
            archived_at: None,
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: OffsetDateTime::UNIX_EPOCH,
            content_id: Uuid::nil(),
            canonical_url: "https://example.com".to_string(),
            resolved_url: None,
            host: "example.com".to_string(),
            site_name: None,
            source_kind: None,
            title: None,
            excerpt: None,
            author: None,
            published_at: None,
            language_code: None,
            has_favicon: false,
            fetch_status: "pending".to_string(),
            parse_status: "pending".to_string(),
            parsed_at: None,
        };

        let encoded = encode_cursor(&row);
        let decoded = decode_cursor(&encoded).expect("cursor should decode");

        assert_eq!(decoded.saved_content_id, Uuid::nil());
        assert_eq!(decoded.updated_at, OffsetDateTime::UNIX_EPOCH);
    }

    #[test]
    fn rejects_out_of_range_page_sizes() {
        assert!(normalize_page_size(Some(0)).is_err());
        assert!(normalize_page_size(Some(101)).is_err());
    }

    #[test]
    fn normalizes_and_deduplicates_requested_tag_slugs() {
        let normalized = normalize_requested_tag_slugs(vec![
            "AI".to_string(),
            "machine-learning".to_string(),
            "ai".to_string(),
        ])
        .expect("tag slugs should normalize");

        assert_eq!(normalized, vec!["ai", "machine-learning"]);
    }

    #[test]
    fn humanizes_tag_slugs() {
        assert_eq!(humanize_tag_slug("machine-learning"), "Machine Learning");
    }

    #[test]
    fn enqueues_processing_when_content_is_pending() {
        assert!(should_enqueue_content_processing(
            &ContentProcessingStateRow {
                id: Uuid::nil(),
                fetch_status: "pending".to_string(),
                parse_status: "pending".to_string(),
                has_parsed_document: false,
            }
        ));
    }

    #[test]
    fn skips_processing_when_content_is_already_succeeded() {
        assert!(!should_enqueue_content_processing(
            &ContentProcessingStateRow {
                id: Uuid::nil(),
                fetch_status: "succeeded".to_string(),
                parse_status: "succeeded".to_string(),
                has_parsed_document: true,
            }
        ));
    }

    #[test]
    fn builds_compact_article_body_from_parsed_document() {
        let body = build_compact_content_body(
            &json!({
                "kind": "article",
                "blocks": [
                    {"type": "heading", "level": 2, "text": "Docs"},
                    {"type": "paragraph", "text": "Paragraph text"},
                    {"type": "list", "style": "numbered", "items": ["One", "Two"]},
                    {"type": "code", "language": "rust", "text": "fn main() {}"},
                    {"type": "image", "url": "https://example.com/ignored.png"}
                ]
            }),
            Some(SourceKind::Article),
        )
        .expect("body should be built");

        assert_eq!(
            body,
            CompactContentBody {
                kind: SourceKind::Article,
                blocks: vec![
                    CompactContentBlock::Heading {
                        level: 2,
                        text: "Docs".to_string(),
                    },
                    CompactContentBlock::Paragraph {
                        text: "Paragraph text".to_string(),
                    },
                    CompactContentBlock::List {
                        ordered: true,
                        items: vec!["One".to_string(), "Two".to_string()],
                    },
                    CompactContentBlock::Code {
                        language: Some("rust".to_string()),
                        text: "fn main() {}".to_string(),
                    },
                ],
            }
        );
    }

    #[test]
    fn builds_compact_thread_body_from_thread_posts() {
        let body = build_compact_content_body(
            &json!({
                "kind": "thread",
                "blocks": [
                    {
                        "type": "thread_post",
                        "display_name": "OpenAI",
                        "author_handle": "OpenAI",
                        "text": "First post"
                    },
                    {
                        "type": "thread_post",
                        "author_handle": "sam",
                        "text": "Second post"
                    }
                ]
            }),
            Some(SourceKind::Thread),
        )
        .expect("body should be built");

        assert_eq!(
            body,
            CompactContentBody {
                kind: SourceKind::Thread,
                blocks: vec![
                    CompactContentBlock::Heading {
                        level: 3,
                        text: "OpenAI".to_string(),
                    },
                    CompactContentBlock::Paragraph {
                        text: "First post".to_string(),
                    },
                    CompactContentBlock::Heading {
                        level: 3,
                        text: "@sam".to_string(),
                    },
                    CompactContentBlock::Paragraph {
                        text: "Second post".to_string(),
                    },
                ],
            }
        );
    }

    #[test]
    fn serializes_summary_with_unix_timestamps_and_without_body() {
        let summary = SavedContentSummary {
            id: Uuid::nil(),
            submitted_url: "https://example.com".to_string(),
            read_state: ReadState::Unread,
            is_favorited: false,
            archived_at: Some(1),
            created_at: 2,
            updated_at: 3,
            tags: vec![TagSummary {
                id: Uuid::nil(),
                slug: "technology".to_string(),
                label: "Technology".to_string(),
                scope: TagScope::System,
                content_count: 1,
            }],
            content: ContentSummary {
                id: Uuid::nil(),
                canonical_url: "https://example.com".to_string(),
                resolved_url: None,
                host: "example.com".to_string(),
                site_name: None,
                source_kind: Some(SourceKind::Article),
                title: Some("Title".to_string()),
                excerpt: Some("Excerpt".to_string()),
                author: None,
                published_at: Some(4),
                language_code: Some("en".to_string()),
                has_favicon: false,
                favicon_href: None,
                fetch_status: ProcessingStatus::Succeeded,
                parse_status: ProcessingStatus::Succeeded,
                parsed_at: Some(5),
            },
        };

        let value = serde_json::to_value(&summary).expect("summary should serialize");
        assert_eq!(value["created_at"], json!(2));
        assert_eq!(value["updated_at"], json!(3));
        assert_eq!(value["content"]["published_at"], json!(4));
        assert_eq!(value["content"]["parsed_at"], json!(5));
        assert!(value["content"].get("cover_image_url").is_none());
        assert!(value["content"].get("body").is_none());
    }

    #[test]
    fn serializes_detail_with_compact_body_and_omits_internal_parser_fields() {
        let detail = SavedContentDetail {
            id: Uuid::nil(),
            submitted_url: "https://example.com".to_string(),
            read_state: ReadState::Read,
            is_favorited: true,
            archived_at: None,
            created_at: 10,
            updated_at: 11,
            tags: Vec::new(),
            content: ContentDetail {
                id: Uuid::nil(),
                canonical_url: "https://example.com".to_string(),
                resolved_url: Some("https://example.com/final".to_string()),
                host: "example.com".to_string(),
                site_name: Some("Example".to_string()),
                source_kind: Some(SourceKind::Article),
                title: Some("Title".to_string()),
                excerpt: Some("Excerpt".to_string()),
                author: Some("Author".to_string()),
                published_at: Some(12),
                language_code: Some("en".to_string()),
                has_favicon: true,
                favicon_href: Some("/me/content/1/favicon".to_string()),
                fetch_status: ProcessingStatus::Succeeded,
                parse_status: ProcessingStatus::Succeeded,
                parsed_at: Some(13),
                body: Some(CompactContentBody {
                    kind: SourceKind::Article,
                    blocks: vec![CompactContentBlock::Paragraph {
                        text: "Body text".to_string(),
                    }],
                }),
            },
        };

        let value = serde_json::to_value(&detail).expect("detail should serialize");
        assert_eq!(value["created_at"], json!(10));
        assert_eq!(value["content"]["parsed_at"], json!(13));
        assert_eq!(value["content"]["body"]["kind"], json!("article"));
        assert_eq!(
            value["content"]["body"]["blocks"],
            json!([{ "t": "p", "x": "Body text" }])
        );
        assert!(value["content"].get("parsed_document").is_none());
        assert!(value["content"].get("parser_name").is_none());
        assert!(value["content"].get("parser_version").is_none());
        assert!(value["content"].get("last_successful_fetch_at").is_none());
    }
}
