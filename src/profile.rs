use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedUser,
    error::{ApiError, ApiResult},
};

pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

pub async fn me(
    user: AuthenticatedUser,
    State(state): State<AppState>,
) -> ApiResult<Json<MeResponse>> {
    let profile = find_profile(&state.pool, user.user_id).await?;

    Ok(Json(MeResponse {
        user_id: user.user_id,
        email: user.email,
        role: user.role,
        aal: user.aal,
        profile,
    }))
}

pub async fn upsert_my_profile(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Json(payload): Json<UpsertProfileRequest>,
) -> ApiResult<Json<ProfileRecord>> {
    let username = normalize_username(&payload.username)?;
    let display_name = normalize_optional_field(payload.display_name, "display_name", 80)?;
    let avatar_url = normalize_optional_field(payload.avatar_url, "avatar_url", 2_048)?;

    let profile = sqlx::query_as::<_, ProfileRecord>(
        r#"
        insert into public.profiles (id, username, display_name, avatar_url)
        values ($1, $2, $3, $4)
        on conflict (id) do update
        set username = excluded.username,
            display_name = excluded.display_name,
            avatar_url = excluded.avatar_url,
            updated_at = timezone('utc', now())
        returning username, display_name, avatar_url
        "#,
    )
    .bind(user.user_id)
    .bind(&username)
    .bind(display_name)
    .bind(avatar_url)
    .fetch_one(&state.pool)
    .await
    .map_err(map_profile_error)?;

    Ok(Json(profile))
}

pub async fn public_profile(
    Path(username): Path<String>,
    State(state): State<AppState>,
) -> ApiResult<Json<ProfileRecord>> {
    let username = normalize_username(&username)?;

    let profile = sqlx::query_as::<_, ProfileRecord>(
        r#"
        select username, display_name, avatar_url
        from public.profiles
        where username = $1
        "#,
    )
    .bind(&username)
    .fetch_optional(&state.pool)
    .await
    .map_err(map_profile_error)?
    .ok_or_else(|| ApiError::not_found("Profile was not found"))?;

    Ok(Json(profile))
}

async fn find_profile(pool: &sqlx::PgPool, user_id: Uuid) -> ApiResult<Option<ProfileRecord>> {
    sqlx::query_as::<_, ProfileRecord>(
        r#"
        select username, display_name, avatar_url
        from public.profiles
        where id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(map_profile_error)
}

pub(crate) fn normalize_username(input: &str) -> ApiResult<String> {
    Username::parse(input).map(|username| username.0)
}

fn normalize_optional_field(
    value: Option<String>,
    field_name: &str,
    max_length: usize,
) -> ApiResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };

    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }

    if value.len() > max_length {
        return Err(ApiError::bad_request(format!(
            "{field_name} must be at most {max_length} characters"
        )));
    }

    Ok(Some(value.to_string()))
}

fn map_profile_error(error: sqlx::Error) -> ApiError {
    if let Some(database_error) = error.as_database_error()
        && database_error.code().as_deref() == Some("23505")
    {
        return ApiError::conflict("Username is already taken");
    }

    tracing::error!(error = %error, "profile query failed");
    ApiError::internal("Database operation failed")
}

#[derive(Debug, Serialize)]
pub struct MeResponse {
    user_id: Uuid,
    email: Option<String>,
    role: String,
    aal: Option<String>,
    profile: Option<ProfileRecord>,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    status: &'static str,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ProfileRecord {
    username: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpsertProfileRequest {
    username: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Username(String);

impl Username {
    fn parse(input: &str) -> ApiResult<Self> {
        let normalized = input.trim().to_ascii_lowercase();

        if !(3..=32).contains(&normalized.len()) {
            return Err(ApiError::bad_request(
                "username must be between 3 and 32 characters",
            ));
        }

        if !normalized.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        }) {
            return Err(ApiError::bad_request(
                "username may only contain lowercase letters, numbers, and underscores",
            ));
        }

        Ok(Self(normalized))
    }
}

#[cfg(test)]
mod tests {
    use super::Username;
    use axum::response::IntoResponse;

    #[test]
    fn normalizes_usernames_to_lowercase() {
        let username = Username::parse("  Motif_User  ").expect("username should be valid");
        assert_eq!(username.0, "motif_user");
    }

    #[test]
    fn rejects_short_usernames() {
        let error = Username::parse("ab").expect_err("username should be rejected");
        assert_eq!(
            error.into_response().status(),
            axum::http::StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn rejects_symbols() {
        assert!(Username::parse("motif-user").is_err());
    }
}
