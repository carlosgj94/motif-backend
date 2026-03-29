use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;

use crate::content::NormalizedUrl;

#[derive(Debug, Clone, FromRow)]
pub(crate) struct ContentProcessingState {
    pub(crate) id: Uuid,
    pub(crate) fetch_status: String,
    pub(crate) parse_status: String,
    pub(crate) has_parsed_document: bool,
}

pub(crate) async fn get_or_create_content(
    transaction: &mut Transaction<'_, Postgres>,
    normalized_url: &NormalizedUrl,
) -> Result<ContentProcessingState, sqlx::Error> {
    sqlx::query_as::<_, ContentProcessingState>(
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
}

pub(crate) async fn enqueue_content_processing(
    transaction: &mut Transaction<'_, Postgres>,
    content_id: Uuid,
    trigger: &str,
    delay_seconds: i32,
) -> Result<(), sqlx::Error> {
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
    .await?;

    Ok(())
}

pub(crate) async fn invoke_content_processor(
    transaction: &mut Transaction<'_, Postgres>,
    content_id: Uuid,
    trigger: &str,
) -> Result<(), sqlx::Error> {
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
    .await?;

    if job_id.is_none() {
        tracing::warn!(
            %content_id,
            trigger,
            "content processor invoke skipped because required Vault secrets are missing",
        );
    }

    Ok(())
}

pub(crate) fn should_enqueue_content_processing(content: &ContentProcessingState) -> bool {
    !content.has_parsed_document
        || matches!(
            (content.fetch_status.as_str(), content.parse_status.as_str()),
            ("pending", _) | ("failed", _) | (_, "pending") | (_, "failed")
        )
}
