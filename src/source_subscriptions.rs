use std::str::FromStr;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
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
    content::{NormalizedUrl, ProcessingStatus, ReadState, SourceKind},
    embedded_content::{
        CompactContentBody, build_compact_content_body, maybe_timestamp_seconds,
        parse_db_processing_status, parse_db_read_state, parse_optional_source_kind,
        timestamp_seconds,
    },
    error::{ApiError, ApiResult},
    recommendations::{
        InternalEventType, record_internal_content_event, record_internal_source_event,
        sync_recommendation_targets_for_signal,
    },
};

const DEFAULT_PAGE_SIZE: u32 = 20;
const MAX_PAGE_SIZE: u32 = 100;
pub async fn create_source_subscription(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Json(payload): Json<CreateSourceSubscriptionRequest>,
) -> ApiResult<(StatusCode, Json<SourceSubscriptionSummary>)> {
    let normalized_source_url = NormalizedUrl::parse(&payload.source_url)?;
    let normalized_feed_url = payload
        .feed_url
        .as_deref()
        .map(NormalizedUrl::parse)
        .transpose()?;

    let mut transaction = state.pool.begin().await.map_err(map_source_error)?;
    let source_id = get_or_create_source(&mut transaction, &normalized_source_url).await?;
    if let Some(feed_url) = normalized_feed_url.as_ref() {
        upsert_source_feed(&mut transaction, source_id, feed_url).await?;
    }

    let existing_id =
        find_existing_source_subscription_id(&mut transaction, user.user_id, source_id).await?;
    let subscription_id =
        upsert_source_subscription(&mut transaction, user.user_id, source_id).await?;

    let mut invoke_recommendations = false;
    if existing_id.is_none() {
        record_internal_source_event(
            &mut transaction,
            user.user_id,
            source_id,
            InternalEventType::Subscribe,
            "source_subscriptions",
        )
        .await?;
        invoke_recommendations = true;
    }

    enqueue_source_refresh(&mut transaction, source_id, "subscribe", 0).await?;
    invoke_source_processor(&mut transaction, source_id, "subscribe").await?;
    if invoke_recommendations {
        sync_recommendation_targets_for_signal(
            &mut transaction,
            Some(user.user_id),
            None,
            Some(source_id),
        )
        .await?;
    }

    transaction.commit().await.map_err(map_source_error)?;

    let summary = fetch_source_subscription_summary(&state.pool, user.user_id, subscription_id)
        .await?
        .ok_or_else(|| ApiError::internal("Source subscription disappeared after save"))?;

    let status = if existing_id.is_some() {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };

    Ok((status, Json(summary)))
}

pub async fn list_source_subscriptions(
    user: AuthenticatedUser,
    State(state): State<AppState>,
) -> ApiResult<Json<SourceSubscriptionListResponse>> {
    let rows = sqlx::query_as::<_, SourceSubscriptionSummaryRow>(
        r#"
        select
            ss.id as source_subscription_id,
            ss.created_at,
            ss.updated_at,
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
        from public.source_subscriptions ss
        join public.content_sources cs on cs.id = ss.source_id
        left join public.source_feeds sf on sf.id = cs.primary_feed_id
        where ss.user_id = $1
        order by ss.updated_at desc, ss.id desc
        "#,
    )
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(map_source_error)?;

    let subscriptions = rows
        .into_iter()
        .map(build_source_subscription_summary)
        .collect::<ApiResult<Vec<_>>>()?;

    Ok(Json(SourceSubscriptionListResponse { subscriptions }))
}

pub async fn delete_source_subscription(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Path(subscription_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let mut transaction = state.pool.begin().await.map_err(map_source_error)?;
    let deleted = sqlx::query_scalar::<_, Uuid>(
        r#"
        delete from public.source_subscriptions
        where id = $1 and user_id = $2
        returning source_id
        "#,
    )
    .bind(subscription_id)
    .bind(user.user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(map_source_error)?;

    match deleted {
        Some(source_id) => {
            record_internal_source_event(
                &mut transaction,
                user.user_id,
                source_id,
                InternalEventType::Unsubscribe,
                "source_subscriptions",
            )
            .await?;
            sync_recommendation_targets_for_signal(
                &mut transaction,
                Some(user.user_id),
                None,
                Some(source_id),
            )
            .await?;
            transaction.commit().await.map_err(map_source_error)?;
            Ok(StatusCode::NO_CONTENT)
        }
        None => Err(ApiError::not_found("Source subscription was not found")),
    }
}

pub async fn list_inbox(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Query(query): Query<ListInboxQuery>,
) -> ApiResult<Json<InboxListResponse>> {
    let limit = normalize_page_size(query.limit)?;
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_inbox_cursor)
        .transpose()?;

    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        select
            i.id as inbox_item_id,
            i.subscription_id,
            i.delivered_at,
            i.read_state,
            i.dismissed_at,
            i.created_at,
            i.updated_at,
            exists (
                select 1
                from public.saved_content sc
                where sc.user_id =
        "#,
    );
    builder.push_bind(user.user_id);
    builder.push(
        r#"
                  and sc.content_id = i.content_id
            ) as is_saved,
            cs.id as source_id,
            cs.source_url,
            cs.resolved_source_url,
            cs.host as source_host,
            cs.title as source_title,
            cs.description as source_description,
            cs.source_kind as source_kind,
            cs.refresh_status,
            cs.last_refreshed_at,
            sf.feed_url as primary_feed_url,
            c.id as content_id,
            c.canonical_url,
            c.resolved_url,
            c.host as content_host,
            c.site_name,
            c.source_kind as content_source_kind,
            c.title as content_title,
            c.excerpt,
            c.author,
            c.published_at,
            c.language_code,
            (c.favicon_bytes is not null and c.favicon_mime_type is not null) as has_favicon,
            c.fetch_status,
            c.parse_status,
            c.parsed_at
        from public.subscription_inbox i
        join public.source_subscriptions ss on ss.id = i.subscription_id
        join public.content_sources cs on cs.id = ss.source_id
        left join public.source_feeds sf on sf.id = cs.primary_feed_id
        join public.content c on c.id = i.content_id
        where i.user_id =
        "#,
    );
    builder.push_bind(user.user_id);
    builder.push(" and ss.user_id = ");
    builder.push_bind(user.user_id);

    match query.dismissed {
        Some(true) => {
            builder.push(" and i.dismissed_at is not null");
        }
        Some(false) | None => {
            builder.push(" and i.dismissed_at is null");
        }
    }

    if let Some(read_state) = query.read_state {
        builder.push(" and i.read_state = ");
        builder.push_bind(read_state.as_str());
    }

    if let Some(subscription_id) = query.subscription_id {
        builder.push(" and i.subscription_id = ");
        builder.push_bind(subscription_id);
    }

    if let Some(cursor) = cursor {
        builder.push(" and (i.delivered_at, i.id) < (");
        builder.push_bind(cursor.delivered_at);
        builder.push(", ");
        builder.push_bind(cursor.inbox_item_id);
        builder.push(")");
    }

    builder.push(" order by i.delivered_at desc, i.id desc limit ");
    builder.push_bind(i64::from(limit) + 1);

    let mut rows = builder
        .build_query_as::<InboxSummaryRow>()
        .fetch_all(&state.pool)
        .await
        .map_err(map_source_error)?;

    let next_cursor = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        rows.last().map(encode_inbox_cursor)
    } else {
        None
    };

    let inbox = rows
        .into_iter()
        .map(build_inbox_summary)
        .collect::<ApiResult<Vec<_>>>()?;

    Ok(Json(InboxListResponse { inbox, next_cursor }))
}

pub async fn get_inbox_item(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Path(inbox_item_id): Path<Uuid>,
) -> ApiResult<Json<InboxItemDetail>> {
    let row = sqlx::query_as::<_, InboxDetailRow>(
        r#"
        select
            i.id as inbox_item_id,
            i.subscription_id,
            i.delivered_at,
            i.read_state,
            i.dismissed_at,
            i.created_at,
            i.updated_at,
            exists (
                select 1
                from public.saved_content sc
                where sc.user_id = $2
                  and sc.content_id = i.content_id
            ) as is_saved,
            cs.id as source_id,
            cs.source_url,
            cs.resolved_source_url,
            cs.host as source_host,
            cs.title as source_title,
            cs.description as source_description,
            cs.source_kind as source_kind,
            cs.refresh_status,
            cs.last_refreshed_at,
            sf.feed_url as primary_feed_url,
            c.id as content_id,
            c.canonical_url,
            c.resolved_url,
            c.host as content_host,
            c.site_name,
            c.source_kind as content_source_kind,
            c.title as content_title,
            c.excerpt,
            c.author,
            c.published_at,
            c.language_code,
            (c.favicon_bytes is not null and c.favicon_mime_type is not null) as has_favicon,
            c.fetch_status,
            c.parse_status,
            c.parsed_at,
            c.parsed_document
        from public.subscription_inbox i
        join public.source_subscriptions ss on ss.id = i.subscription_id
        join public.content_sources cs on cs.id = ss.source_id
        left join public.source_feeds sf on sf.id = cs.primary_feed_id
        join public.content c on c.id = i.content_id
        where i.id = $1
          and i.user_id = $2
          and ss.user_id = $2
        "#,
    )
    .bind(inbox_item_id)
    .bind(user.user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(map_source_error)?
    .ok_or_else(|| ApiError::not_found("Inbox item was not found"))?;

    Ok(Json(build_inbox_detail(row)?))
}

pub async fn update_inbox_item(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Path(inbox_item_id): Path<Uuid>,
    Json(payload): Json<UpdateInboxItemRequest>,
) -> ApiResult<Json<InboxItemSummary>> {
    if payload.read_state.is_none() && payload.is_dismissed.is_none() {
        return Err(ApiError::bad_request("At least one field must be provided"));
    }

    let mut transaction = state.pool.begin().await.map_err(map_source_error)?;
    let existing = sqlx::query_as::<_, InboxUpdateRow>(
        r#"
        select i.read_state, i.dismissed_at, i.read_at, i.content_id, c.source_id
        from public.subscription_inbox i
        join public.content c on c.id = i.content_id
        where id = $1 and user_id = $2
        "#,
    )
    .bind(inbox_item_id)
    .bind(user.user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(map_source_error)?
    .ok_or_else(|| ApiError::not_found("Inbox item was not found"))?;

    let existing_read_state = parse_db_read_state(&existing.read_state)?;
    let next_read_state = payload.read_state.unwrap_or(existing_read_state);
    let next_dismissed_at = match payload.is_dismissed {
        Some(true) => Some(OffsetDateTime::now_utc()),
        Some(false) => None,
        None => existing.dismissed_at,
    };
    let next_read_at = match next_read_state {
        ReadState::Read => existing.read_at.or_else(|| Some(OffsetDateTime::now_utc())),
        ReadState::Unread | ReadState::Reading => None,
    };
    let became_dismissed = existing.dismissed_at.is_none() && next_dismissed_at.is_some();
    let became_read = existing_read_state != ReadState::Read && next_read_state == ReadState::Read;

    sqlx::query(
        r#"
        update public.subscription_inbox
        set read_state = $2,
            read_at = $3,
            dismissed_at = $4,
            updated_at = timezone('utc', now())
        where id = $1 and user_id = $5
        "#,
    )
    .bind(inbox_item_id)
    .bind(next_read_state.as_str())
    .bind(next_read_at)
    .bind(next_dismissed_at)
    .bind(user.user_id)
    .execute(&mut *transaction)
    .await
    .map_err(map_source_error)?;

    let mut invoke_recommendations = false;
    if became_dismissed {
        record_internal_content_event(
            &mut transaction,
            user.user_id,
            existing.content_id,
            existing.source_id,
            InternalEventType::Dismiss,
            "inbox",
        )
        .await?;
        invoke_recommendations = true;
    }

    if became_read {
        record_internal_content_event(
            &mut transaction,
            user.user_id,
            existing.content_id,
            existing.source_id,
            InternalEventType::MarkRead,
            "inbox",
        )
        .await?;
        invoke_recommendations = true;
    }

    if invoke_recommendations {
        sync_recommendation_targets_for_signal(
            &mut transaction,
            Some(user.user_id),
            Some(existing.content_id),
            existing.source_id,
        )
        .await?;
    }

    transaction.commit().await.map_err(map_source_error)?;

    let summary = fetch_inbox_summary(&state.pool, user.user_id, inbox_item_id)
        .await?
        .ok_or_else(|| ApiError::internal("Inbox item disappeared after update"))?;

    Ok(Json(summary))
}

pub(crate) async fn get_or_create_source(
    transaction: &mut Transaction<'_, Postgres>,
    source_url: &NormalizedUrl,
) -> ApiResult<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        with inserted as (
            insert into public.content_sources (source_url, host)
            values ($1, $2)
            on conflict (source_url) do nothing
            returning id
        )
        select id
        from inserted
        union all
        select id
        from public.content_sources
        where source_url = $1
        limit 1
        "#,
    )
    .bind(&source_url.canonical_url)
    .bind(&source_url.host)
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_source_error)
}

async fn upsert_source_feed(
    transaction: &mut Transaction<'_, Postgres>,
    source_id: Uuid,
    feed_url: &NormalizedUrl,
) -> ApiResult<()> {
    sqlx::query(
        r#"
        update public.source_feeds
        set is_primary = false,
            updated_at = timezone('utc', now())
        where source_id = $1
          and feed_url <> $2
          and is_primary
        "#,
    )
    .bind(source_id)
    .bind(&feed_url.canonical_url)
    .execute(&mut **transaction)
    .await
    .map_err(map_source_error)?;

    sqlx::query(
        r#"
        insert into public.source_feeds (
            source_id,
            feed_url,
            feed_kind,
            discovery_method,
            is_primary,
            refresh_status,
            next_refresh_at
        )
        values ($1, $2, 'unknown', 'provided', true, 'pending', timezone('utc', now()))
        on conflict (source_id, feed_url) do update
        set discovery_method = excluded.discovery_method,
            is_primary = true,
            refresh_status = case
                when public.source_feeds.refresh_status = 'in_progress' then public.source_feeds.refresh_status
                else 'pending'
            end,
            next_refresh_at = timezone('utc', now()),
            updated_at = timezone('utc', now())
        "#,
    )
    .bind(source_id)
    .bind(&feed_url.canonical_url)
    .execute(&mut **transaction)
    .await
    .map_err(map_source_error)?;

    Ok(())
}

async fn find_existing_source_subscription_id(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    source_id: Uuid,
) -> ApiResult<Option<Uuid>> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        select id
        from public.source_subscriptions
        where user_id = $1 and source_id = $2
        "#,
    )
    .bind(user_id)
    .bind(source_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_source_error)
}

async fn upsert_source_subscription(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    source_id: Uuid,
) -> ApiResult<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        insert into public.source_subscriptions (user_id, source_id)
        values ($1, $2)
        on conflict (user_id, source_id) do update
        set updated_at = timezone('utc', now())
        returning id
        "#,
    )
    .bind(user_id)
    .bind(source_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_source_error)
}

pub(crate) async fn enqueue_source_refresh(
    transaction: &mut Transaction<'_, Postgres>,
    source_id: Uuid,
    trigger: &str,
    delay_seconds: i32,
) -> ApiResult<()> {
    sqlx::query_scalar::<_, i64>(
        r#"
        select public.enqueue_source_refresh($1, $2, $3, $4)
        "#,
    )
    .bind(source_id)
    .bind(trigger)
    .bind(delay_seconds)
    .bind(0_i32)
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_source_error)?;

    Ok(())
}

pub(crate) async fn invoke_source_processor(
    transaction: &mut Transaction<'_, Postgres>,
    source_id: Uuid,
    trigger: &str,
) -> ApiResult<()> {
    let job_id = sqlx::query_scalar::<_, Option<i64>>(
        r#"
        select public.invoke_source_processor(
            jsonb_build_object(
                'source_id', $1,
                'trigger', $2
            )
        )
        "#,
    )
    .bind(source_id)
    .bind(trigger)
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_source_error)?;

    if job_id.is_none() {
        tracing::warn!(
            %source_id,
            trigger,
            "source processor invoke skipped because required Vault secrets are missing",
        );
    }

    Ok(())
}

async fn fetch_source_subscription_summary(
    pool: &PgPool,
    user_id: Uuid,
    subscription_id: Uuid,
) -> ApiResult<Option<SourceSubscriptionSummary>> {
    let row = sqlx::query_as::<_, SourceSubscriptionSummaryRow>(
        r#"
        select
            ss.id as source_subscription_id,
            ss.created_at,
            ss.updated_at,
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
        from public.source_subscriptions ss
        join public.content_sources cs on cs.id = ss.source_id
        left join public.source_feeds sf on sf.id = cs.primary_feed_id
        where ss.id = $1 and ss.user_id = $2
        "#,
    )
    .bind(subscription_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(map_source_error)?;

    row.map(build_source_subscription_summary).transpose()
}

async fn fetch_inbox_summary(
    pool: &PgPool,
    user_id: Uuid,
    inbox_item_id: Uuid,
) -> ApiResult<Option<InboxItemSummary>> {
    let row = sqlx::query_as::<_, InboxSummaryRow>(
        r#"
        select
            i.id as inbox_item_id,
            i.subscription_id,
            i.delivered_at,
            i.read_state,
            i.dismissed_at,
            i.created_at,
            i.updated_at,
            exists (
                select 1
                from public.saved_content sc
                where sc.user_id = $2
                  and sc.content_id = i.content_id
            ) as is_saved,
            cs.id as source_id,
            cs.source_url,
            cs.resolved_source_url,
            cs.host as source_host,
            cs.title as source_title,
            cs.description as source_description,
            cs.source_kind as source_kind,
            cs.refresh_status,
            cs.last_refreshed_at,
            sf.feed_url as primary_feed_url,
            c.id as content_id,
            c.canonical_url,
            c.resolved_url,
            c.host as content_host,
            c.site_name,
            c.source_kind as content_source_kind,
            c.title as content_title,
            c.excerpt,
            c.author,
            c.published_at,
            c.language_code,
            (c.favicon_bytes is not null and c.favicon_mime_type is not null) as has_favicon,
            c.fetch_status,
            c.parse_status,
            c.parsed_at
        from public.subscription_inbox i
        join public.source_subscriptions ss on ss.id = i.subscription_id
        join public.content_sources cs on cs.id = ss.source_id
        left join public.source_feeds sf on sf.id = cs.primary_feed_id
        join public.content c on c.id = i.content_id
        where i.id = $1
          and i.user_id = $2
          and ss.user_id = $2
        "#,
    )
    .bind(inbox_item_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(map_source_error)?;

    row.map(build_inbox_summary).transpose()
}

fn build_source_subscription_summary(
    row: SourceSubscriptionSummaryRow,
) -> ApiResult<SourceSubscriptionSummary> {
    Ok(SourceSubscriptionSummary {
        id: row.source_subscription_id,
        created_at: timestamp_seconds(row.created_at),
        updated_at: timestamp_seconds(row.updated_at),
        source: build_source_summary(row.source_summary_parts())?,
    })
}

fn build_inbox_summary(row: InboxSummaryRow) -> ApiResult<InboxItemSummary> {
    Ok(InboxItemSummary {
        id: row.inbox_item_id,
        subscription_id: row.subscription_id,
        delivered_at: timestamp_seconds(row.delivered_at),
        read_state: parse_db_read_state(&row.read_state)?,
        dismissed_at: maybe_timestamp_seconds(row.dismissed_at),
        created_at: timestamp_seconds(row.created_at),
        updated_at: timestamp_seconds(row.updated_at),
        is_saved: row.is_saved,
        source: build_source_summary(row.source_summary_parts())?,
        content: build_content_summary(row.content_summary_parts())?,
    })
}

fn build_inbox_detail(row: InboxDetailRow) -> ApiResult<InboxItemDetail> {
    let fallback_source_kind = parse_optional_source_kind(row.content_source_kind.as_deref())?;
    let body = row
        .parsed_document
        .as_ref()
        .and_then(|value| build_compact_content_body(&value.0, fallback_source_kind));

    Ok(InboxItemDetail {
        id: row.inbox_item_id,
        subscription_id: row.subscription_id,
        delivered_at: timestamp_seconds(row.delivered_at),
        read_state: parse_db_read_state(&row.read_state)?,
        dismissed_at: maybe_timestamp_seconds(row.dismissed_at),
        created_at: timestamp_seconds(row.created_at),
        updated_at: timestamp_seconds(row.updated_at),
        is_saved: row.is_saved,
        source: build_source_summary(row.source_summary_parts())?,
        content: build_content_detail(row.content_summary_parts(), body)?,
    })
}

fn build_source_summary(parts: SourceSummaryParts<'_>) -> ApiResult<SourceSummary> {
    Ok(SourceSummary {
        id: parts.id,
        source_url: parts.source_url.to_string(),
        resolved_source_url: parts.resolved_source_url.map(ToOwned::to_owned),
        host: parts.host.to_string(),
        title: parts.title.map(ToOwned::to_owned),
        description: parts.description.map(ToOwned::to_owned),
        source_kind: parts.source_kind.to_string(),
        primary_feed_url: parts.primary_feed_url.map(ToOwned::to_owned),
        refresh_status: parse_source_refresh_status(parts.refresh_status)?,
        last_refreshed_at: maybe_timestamp_seconds(parts.last_refreshed_at),
    })
}

fn build_content_summary(parts: ContentSummaryParts<'_>) -> ApiResult<InboxContentSummary> {
    Ok(InboxContentSummary {
        id: parts.id,
        canonical_url: parts.canonical_url.to_string(),
        resolved_url: parts.resolved_url.map(ToOwned::to_owned),
        host: parts.host.to_string(),
        site_name: parts.site_name.map(ToOwned::to_owned),
        source_kind: parse_optional_source_kind(parts.source_kind)?,
        title: parts.title.map(ToOwned::to_owned),
        excerpt: parts.excerpt.map(ToOwned::to_owned),
        author: parts.author.map(ToOwned::to_owned),
        published_at: maybe_timestamp_seconds(parts.published_at),
        language_code: parts.language_code.map(ToOwned::to_owned),
        has_favicon: parts.has_favicon,
        favicon_href: parts
            .has_favicon
            .then(|| format!("/me/content/{}/favicon", parts.id)),
        fetch_status: parse_db_processing_status(parts.fetch_status)?,
        parse_status: parse_db_processing_status(parts.parse_status)?,
        parsed_at: maybe_timestamp_seconds(parts.parsed_at),
    })
}

fn build_content_detail(
    parts: ContentSummaryParts<'_>,
    body: Option<CompactContentBody>,
) -> ApiResult<InboxContentDetail> {
    Ok(InboxContentDetail {
        id: parts.id,
        canonical_url: parts.canonical_url.to_string(),
        resolved_url: parts.resolved_url.map(ToOwned::to_owned),
        host: parts.host.to_string(),
        site_name: parts.site_name.map(ToOwned::to_owned),
        source_kind: parse_optional_source_kind(parts.source_kind)?,
        title: parts.title.map(ToOwned::to_owned),
        excerpt: parts.excerpt.map(ToOwned::to_owned),
        author: parts.author.map(ToOwned::to_owned),
        published_at: maybe_timestamp_seconds(parts.published_at),
        language_code: parts.language_code.map(ToOwned::to_owned),
        has_favicon: parts.has_favicon,
        favicon_href: parts
            .has_favicon
            .then(|| format!("/me/content/{}/favicon", parts.id)),
        fetch_status: parse_db_processing_status(parts.fetch_status)?,
        parse_status: parse_db_processing_status(parts.parse_status)?,
        parsed_at: maybe_timestamp_seconds(parts.parsed_at),
        body,
    })
}

fn parse_source_refresh_status(value: &str) -> ApiResult<SourceRefreshStatus> {
    SourceRefreshStatus::from_str(value)
        .map_err(|_| ApiError::internal("Stored source refresh status was invalid"))
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

fn encode_inbox_cursor(row: &InboxSummaryRow) -> String {
    let cursor = InboxCursor {
        delivered_at_unix_nanos: row.delivered_at.unix_timestamp_nanos(),
        inbox_item_id: row.inbox_item_id,
    };

    let bytes = serde_json::to_vec(&cursor).expect("cursor serialization should not fail");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_inbox_cursor(cursor: &str) -> ApiResult<InboxCursorDecoded> {
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| ApiError::bad_request("cursor is invalid"))?;
    let decoded: InboxCursor =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::bad_request("cursor is invalid"))?;

    let delivered_at = OffsetDateTime::from_unix_timestamp_nanos(decoded.delivered_at_unix_nanos)
        .map_err(|_| ApiError::bad_request("cursor is invalid"))?;

    Ok(InboxCursorDecoded {
        delivered_at,
        inbox_item_id: decoded.inbox_item_id,
    })
}

fn map_source_error(error: sqlx::Error) -> ApiError {
    tracing::error!(error = %error, "source subscription query failed");
    ApiError::internal("Database operation failed")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceRefreshStatus {
    Pending,
    InProgress,
    Succeeded,
    Failed,
    NoFeed,
}

impl FromStr for SourceRefreshStatus {
    type Err = ApiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "pending" => Ok(Self::Pending),
            "in_progress" => Ok(Self::InProgress),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "no_feed" => Ok(Self::NoFeed),
            _ => Err(ApiError::bad_request("source refresh status is invalid")),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateSourceSubscriptionRequest {
    source_url: String,
    #[serde(default)]
    feed_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListInboxQuery {
    limit: Option<u32>,
    cursor: Option<String>,
    read_state: Option<ReadState>,
    dismissed: Option<bool>,
    subscription_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateInboxItemRequest {
    read_state: Option<ReadState>,
    is_dismissed: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct SourceSubscriptionListResponse {
    subscriptions: Vec<SourceSubscriptionSummary>,
}

#[derive(Debug, Serialize)]
pub struct InboxListResponse {
    inbox: Vec<InboxItemSummary>,
    next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SourceSummary {
    id: Uuid,
    source_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_source_url: Option<String>,
    host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    source_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    primary_feed_url: Option<String>,
    refresh_status: SourceRefreshStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_refreshed_at: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SourceSubscriptionSummary {
    id: Uuid,
    created_at: i64,
    updated_at: i64,
    source: SourceSummary,
}

#[derive(Debug, Serialize, Clone)]
pub struct InboxContentSummary {
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
pub struct InboxContentDetail {
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
pub struct InboxItemSummary {
    id: Uuid,
    subscription_id: Uuid,
    delivered_at: i64,
    read_state: ReadState,
    #[serde(skip_serializing_if = "Option::is_none")]
    dismissed_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    is_saved: bool,
    source: SourceSummary,
    content: InboxContentSummary,
}

#[derive(Debug, Serialize)]
pub struct InboxItemDetail {
    id: Uuid,
    subscription_id: Uuid,
    delivered_at: i64,
    read_state: ReadState,
    #[serde(skip_serializing_if = "Option::is_none")]
    dismissed_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    is_saved: bool,
    source: SourceSummary,
    content: InboxContentDetail,
}

#[derive(Debug, Deserialize, Serialize)]
struct InboxCursor {
    delivered_at_unix_nanos: i128,
    inbox_item_id: Uuid,
}

#[derive(Debug)]
struct InboxCursorDecoded {
    delivered_at: OffsetDateTime,
    inbox_item_id: Uuid,
}

#[derive(Debug, FromRow)]
struct SourceSubscriptionSummaryRow {
    source_subscription_id: Uuid,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
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
struct InboxSummaryRow {
    inbox_item_id: Uuid,
    subscription_id: Uuid,
    delivered_at: OffsetDateTime,
    read_state: String,
    dismissed_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
    is_saved: bool,
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
    content_id: Uuid,
    canonical_url: String,
    resolved_url: Option<String>,
    content_host: String,
    site_name: Option<String>,
    content_source_kind: Option<String>,
    content_title: Option<String>,
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
struct InboxDetailRow {
    inbox_item_id: Uuid,
    subscription_id: Uuid,
    delivered_at: OffsetDateTime,
    read_state: String,
    dismissed_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
    is_saved: bool,
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
    content_id: Uuid,
    canonical_url: String,
    resolved_url: Option<String>,
    content_host: String,
    site_name: Option<String>,
    content_source_kind: Option<String>,
    content_title: Option<String>,
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
struct InboxUpdateRow {
    read_state: String,
    dismissed_at: Option<OffsetDateTime>,
    read_at: Option<OffsetDateTime>,
    content_id: Uuid,
    source_id: Option<Uuid>,
}

#[derive(Clone, Copy)]
struct SourceSummaryParts<'a> {
    id: Uuid,
    source_url: &'a str,
    resolved_source_url: Option<&'a str>,
    host: &'a str,
    title: Option<&'a str>,
    description: Option<&'a str>,
    source_kind: &'a str,
    primary_feed_url: Option<&'a str>,
    refresh_status: &'a str,
    last_refreshed_at: Option<OffsetDateTime>,
}

#[derive(Clone, Copy)]
struct ContentSummaryParts<'a> {
    id: Uuid,
    canonical_url: &'a str,
    resolved_url: Option<&'a str>,
    host: &'a str,
    site_name: Option<&'a str>,
    source_kind: Option<&'a str>,
    title: Option<&'a str>,
    excerpt: Option<&'a str>,
    author: Option<&'a str>,
    published_at: Option<OffsetDateTime>,
    language_code: Option<&'a str>,
    has_favicon: bool,
    fetch_status: &'a str,
    parse_status: &'a str,
    parsed_at: Option<OffsetDateTime>,
}

impl SourceSubscriptionSummaryRow {
    fn source_summary_parts(&self) -> SourceSummaryParts<'_> {
        SourceSummaryParts {
            id: self.source_id,
            source_url: &self.source_url,
            resolved_source_url: self.resolved_source_url.as_deref(),
            host: &self.source_host,
            title: self.source_title.as_deref(),
            description: self.source_description.as_deref(),
            source_kind: &self.source_kind,
            primary_feed_url: self.primary_feed_url.as_deref(),
            refresh_status: &self.refresh_status,
            last_refreshed_at: self.last_refreshed_at,
        }
    }
}

impl InboxSummaryRow {
    fn source_summary_parts(&self) -> SourceSummaryParts<'_> {
        SourceSummaryParts {
            id: self.source_id,
            source_url: &self.source_url,
            resolved_source_url: self.resolved_source_url.as_deref(),
            host: &self.source_host,
            title: self.source_title.as_deref(),
            description: self.source_description.as_deref(),
            source_kind: &self.source_kind,
            primary_feed_url: self.primary_feed_url.as_deref(),
            refresh_status: &self.refresh_status,
            last_refreshed_at: self.last_refreshed_at,
        }
    }

    fn content_summary_parts(&self) -> ContentSummaryParts<'_> {
        ContentSummaryParts {
            id: self.content_id,
            canonical_url: &self.canonical_url,
            resolved_url: self.resolved_url.as_deref(),
            host: &self.content_host,
            site_name: self.site_name.as_deref(),
            source_kind: self.content_source_kind.as_deref(),
            title: self.content_title.as_deref(),
            excerpt: self.excerpt.as_deref(),
            author: self.author.as_deref(),
            published_at: self.published_at,
            language_code: self.language_code.as_deref(),
            has_favicon: self.has_favicon,
            fetch_status: &self.fetch_status,
            parse_status: &self.parse_status,
            parsed_at: self.parsed_at,
        }
    }
}

impl InboxDetailRow {
    fn source_summary_parts(&self) -> SourceSummaryParts<'_> {
        SourceSummaryParts {
            id: self.source_id,
            source_url: &self.source_url,
            resolved_source_url: self.resolved_source_url.as_deref(),
            host: &self.source_host,
            title: self.source_title.as_deref(),
            description: self.source_description.as_deref(),
            source_kind: &self.source_kind,
            primary_feed_url: self.primary_feed_url.as_deref(),
            refresh_status: &self.refresh_status,
            last_refreshed_at: self.last_refreshed_at,
        }
    }

    fn content_summary_parts(&self) -> ContentSummaryParts<'_> {
        ContentSummaryParts {
            id: self.content_id,
            canonical_url: &self.canonical_url,
            resolved_url: self.resolved_url.as_deref(),
            host: &self.content_host,
            site_name: self.site_name.as_deref(),
            source_kind: self.content_source_kind.as_deref(),
            title: self.content_title.as_deref(),
            excerpt: self.excerpt.as_deref(),
            author: self.author.as_deref(),
            published_at: self.published_at,
            language_code: self.language_code.as_deref(),
            has_favicon: self.has_favicon,
            fetch_status: &self.fetch_status,
            parse_status: &self.parse_status,
            parsed_at: self.parsed_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::{
        InboxContentDetail, InboxItemDetail, InboxSummaryRow, SourceRefreshStatus, SourceSummary,
        build_inbox_summary, decode_inbox_cursor, encode_inbox_cursor, normalize_page_size,
    };
    use crate::content::{ProcessingStatus, ReadState, SourceKind};
    use crate::embedded_content::{
        CompactContentBlock, CompactContentBody, build_compact_content_body,
    };
    use serde_json::json;
    use time::OffsetDateTime;
    use uuid::Uuid;

    #[test]
    fn parses_source_refresh_status_values() {
        assert_eq!(
            SourceRefreshStatus::from_str("no_feed").unwrap(),
            SourceRefreshStatus::NoFeed
        );
    }

    #[test]
    fn encodes_and_decodes_inbox_cursor_round_trip() {
        let row = InboxSummaryRow {
            inbox_item_id: Uuid::nil(),
            subscription_id: Uuid::nil(),
            delivered_at: OffsetDateTime::UNIX_EPOCH,
            read_state: "unread".to_string(),
            dismissed_at: None,
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: OffsetDateTime::UNIX_EPOCH,
            is_saved: false,
            source_id: Uuid::nil(),
            source_url: "https://example.com".to_string(),
            resolved_source_url: None,
            source_host: "example.com".to_string(),
            source_title: None,
            source_description: None,
            source_kind: "website".to_string(),
            refresh_status: "pending".to_string(),
            last_refreshed_at: None,
            primary_feed_url: None,
            content_id: Uuid::nil(),
            canonical_url: "https://example.com/post".to_string(),
            resolved_url: None,
            content_host: "example.com".to_string(),
            site_name: None,
            content_source_kind: Some("article".to_string()),
            content_title: None,
            excerpt: None,
            author: None,
            published_at: None,
            language_code: None,
            has_favicon: false,
            fetch_status: "pending".to_string(),
            parse_status: "pending".to_string(),
            parsed_at: None,
        };

        let encoded = encode_inbox_cursor(&row);
        let decoded = decode_inbox_cursor(&encoded).expect("cursor should decode");

        assert_eq!(decoded.inbox_item_id, Uuid::nil());
        assert_eq!(decoded.delivered_at, OffsetDateTime::UNIX_EPOCH);
    }

    #[test]
    fn rejects_out_of_range_page_sizes() {
        assert!(normalize_page_size(Some(0)).is_err());
        assert!(normalize_page_size(Some(101)).is_err());
    }

    #[test]
    fn builds_compact_body_from_parsed_document() {
        let body = build_compact_content_body(
            &json!({
                "kind": "thread",
                "blocks": [
                    {"type": "thread_post", "display_name": "OpenAI", "text": "First"},
                    {"type": "paragraph", "text": "Second"}
                ]
            }),
            Some(SourceKind::Thread),
        )
        .expect("body should build");

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
                        text: "First".to_string(),
                    },
                    CompactContentBlock::Paragraph {
                        text: "Second".to_string(),
                    },
                ],
            }
        );
    }

    #[test]
    fn builds_inbox_summary_with_unix_timestamps() {
        let row = InboxSummaryRow {
            inbox_item_id: Uuid::nil(),
            subscription_id: Uuid::nil(),
            delivered_at: OffsetDateTime::UNIX_EPOCH,
            read_state: "unread".to_string(),
            dismissed_at: None,
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: OffsetDateTime::UNIX_EPOCH,
            is_saved: true,
            source_id: Uuid::nil(),
            source_url: "https://example.com".to_string(),
            resolved_source_url: None,
            source_host: "example.com".to_string(),
            source_title: Some("Example".to_string()),
            source_description: None,
            source_kind: "website".to_string(),
            refresh_status: "succeeded".to_string(),
            last_refreshed_at: Some(OffsetDateTime::UNIX_EPOCH),
            primary_feed_url: Some("https://example.com/feed.xml".to_string()),
            content_id: Uuid::nil(),
            canonical_url: "https://example.com/post".to_string(),
            resolved_url: None,
            content_host: "example.com".to_string(),
            site_name: Some("Example".to_string()),
            content_source_kind: Some("article".to_string()),
            content_title: Some("Post".to_string()),
            excerpt: None,
            author: None,
            published_at: Some(OffsetDateTime::UNIX_EPOCH),
            language_code: Some("en".to_string()),
            has_favicon: false,
            fetch_status: "succeeded".to_string(),
            parse_status: "succeeded".to_string(),
            parsed_at: Some(OffsetDateTime::UNIX_EPOCH),
        };

        let summary = build_inbox_summary(row).expect("summary should build");
        let value = serde_json::to_value(&summary).expect("summary should serialize");
        assert_eq!(value["delivered_at"], json!(0));
        assert_eq!(value["is_saved"], json!(true));
        assert_eq!(value["source"]["refresh_status"], json!("succeeded"));
        assert_eq!(value["content"]["parsed_at"], json!(0));
    }

    #[test]
    fn serializes_inbox_detail_with_compact_body() {
        let detail = InboxItemDetail {
            id: Uuid::nil(),
            subscription_id: Uuid::nil(),
            delivered_at: 1,
            read_state: ReadState::Unread,
            dismissed_at: None,
            created_at: 2,
            updated_at: 3,
            is_saved: false,
            source: SourceSummary {
                id: Uuid::nil(),
                source_url: "https://example.com".to_string(),
                resolved_source_url: None,
                host: "example.com".to_string(),
                title: Some("Example".to_string()),
                description: None,
                source_kind: "website".to_string(),
                primary_feed_url: None,
                refresh_status: SourceRefreshStatus::Succeeded,
                last_refreshed_at: Some(4),
            },
            content: InboxContentDetail {
                id: Uuid::nil(),
                canonical_url: "https://example.com/post".to_string(),
                resolved_url: None,
                host: "example.com".to_string(),
                site_name: None,
                source_kind: Some(SourceKind::Article),
                title: Some("Post".to_string()),
                excerpt: None,
                author: None,
                published_at: Some(5),
                language_code: None,
                has_favicon: false,
                favicon_href: None,
                fetch_status: ProcessingStatus::Succeeded,
                parse_status: ProcessingStatus::Succeeded,
                parsed_at: Some(6),
                body: Some(CompactContentBody {
                    kind: SourceKind::Article,
                    blocks: vec![CompactContentBlock::Paragraph {
                        text: "Body".to_string(),
                    }],
                }),
            },
        };

        let value = serde_json::to_value(&detail).expect("detail should serialize");
        assert_eq!(value["content"]["body"]["kind"], json!("article"));
        assert_eq!(
            value["content"]["body"]["blocks"],
            json!([{ "t": "p", "x": "Body" }])
        );
    }
}
