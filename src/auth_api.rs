use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::{HeaderMap, HeaderValue, StatusCode, header::AUTHORIZATION},
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::net::SocketAddr;
use uuid::Uuid;

use crate::{
    AppState,
    config::SupabaseConfig,
    error::{ApiError, ApiResult},
    profile::normalize_username,
    recommendations::{
        apply_recommendation_preferences, rollup_and_refresh_recommendation_state,
        validate_recommendation_preferences,
    },
    source_subscriptions::{subscribe_user_to_sources, validate_existing_source_ids},
};

#[derive(Clone)]
pub struct SupabaseAuthApi {
    api_key: Option<String>,
    api_url: String,
    client: Client,
    service_role_key: Option<String>,
}

impl SupabaseAuthApi {
    pub fn new(config: &SupabaseConfig) -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .user_agent(concat!(
                env!("CARGO_PKG_NAME"),
                "/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .expect("reqwest client should build");

        Self {
            api_key: config.publishable_key.clone(),
            api_url: format!("{}/auth/v1", config.url),
            client,
            service_role_key: config.service_role_key.clone(),
        }
    }

    pub async fn sign_up(&self, request: SignUpRequest) -> Result<AuthFlowResponse, ApiError> {
        let email = normalize_email(&request.email)?;
        let password = normalize_password(&request.password)?;
        let username = normalize_username(&request.username)?;

        self.send_auth_request(
            self.client.post(format!("{}/signup", self.api_url)),
            json!({
                "email": email,
                "password": password,
                "data": {
                    "username": username
                }
            }),
        )
        .await
    }

    pub async fn create_session(
        &self,
        request: CreateSessionRequest,
    ) -> Result<AuthFlowResponse, ApiError> {
        let email = normalize_email(&request.email)?;
        let password = normalize_password(&request.password)?;

        self.send_auth_request(
            self.client
                .post(format!("{}/token?grant_type=password", self.api_url)),
            json!({
                "email": email,
                "password": password,
            }),
        )
        .await
    }

    pub async fn refresh_session(
        &self,
        request: RefreshSessionRequest,
    ) -> Result<AuthFlowResponse, ApiError> {
        let refresh_token = normalize_refresh_token(&request.refresh_token)?;

        self.send_auth_request(
            self.client
                .post(format!("{}/token?grant_type=refresh_token", self.api_url)),
            json!({
                "refresh_token": refresh_token,
            }),
        )
        .await
    }

    pub fn supports_atomic_onboarding(&self) -> bool {
        self.service_role_key.is_some()
    }

    pub async fn delete_user(&self, user_id: Uuid) -> Result<(), ApiError> {
        let service_role_key = self.service_role_key.as_deref().ok_or_else(|| {
            ApiError::internal("SUPABASE_SERVICE_ROLE_KEY must be set to delete auth users")
        })?;
        let headers = build_auth_headers(service_role_key)?;
        let response = self
            .client
            .delete(format!("{}/admin/users/{}", self.api_url, user_id))
            .headers(headers)
            .send()
            .await
            .map_err(|error| {
                tracing::error!(error = %error, %user_id, "failed to call Supabase admin delete user API");
                ApiError::internal("Failed to reach Supabase auth API")
            })?;

        if response.status().is_success() {
            return Ok(());
        }

        let status = response.status();
        let body = response.bytes().await.map_err(|error| {
            tracing::error!(error = %error, %user_id, "failed to read Supabase auth delete user response body");
            ApiError::internal("Failed to read Supabase auth response")
        })?;
        let provider_error = serde_json::from_slice::<SupabaseAuthError>(&body).ok();
        let message = provider_error
            .as_ref()
            .and_then(SupabaseAuthError::message)
            .unwrap_or("Supabase auth delete user request failed");

        Err(ApiError::with_status(
            map_upstream_status(status),
            "auth_provider_error",
            message,
        ))
    }

    async fn send_auth_request(
        &self,
        request: reqwest::RequestBuilder,
        payload: Value,
    ) -> Result<AuthFlowResponse, ApiError> {
        let api_key = self.api_key.as_deref().ok_or_else(|| {
            ApiError::internal(
                "SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY must be set to use auth endpoints",
            )
        })?;

        let headers = build_auth_headers(api_key)?;

        let response = request
            .headers(headers)
            .json(&payload)
            .send()
            .await
            .map_err(|error| {
                tracing::error!(error = %error, "failed to call Supabase auth API");
                ApiError::internal("Failed to reach Supabase auth API")
            })?;

        let status = response.status();
        let body = response.bytes().await.map_err(|error| {
            tracing::error!(error = %error, "failed to read Supabase auth response body");
            ApiError::internal("Failed to read Supabase auth response")
        })?;

        if !status.is_success() {
            let provider_error = serde_json::from_slice::<SupabaseAuthError>(&body).ok();
            let message = provider_error
                .as_ref()
                .and_then(SupabaseAuthError::message)
                .unwrap_or("Supabase auth request failed");

            return Err(ApiError::with_status(
                map_upstream_status(status),
                "auth_provider_error",
                message,
            ));
        }

        let upstream = serde_json::from_slice::<SupabaseAuthResponse>(&body).map_err(|error| {
            tracing::error!(error = %error, "failed to decode Supabase auth success response");
            ApiError::internal("Supabase auth response was invalid")
        })?;

        Ok(AuthFlowResponse::from(upstream))
    }
}

pub async fn sign_up(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Json(payload): Json<SignUpRequest>,
) -> ApiResult<Json<AuthFlowResponse>> {
    let validated_preferences = validate_recommendation_preferences(
        &state.pool,
        &payload.topic_slugs,
        &payload.language_codes,
    )
    .await?;
    let validated_source_ids =
        validate_existing_source_ids(&state.pool, &payload.source_ids).await?;
    let has_onboarding = !validated_preferences.is_empty() || !validated_source_ids.is_empty();
    if has_onboarding && !state.auth_api.supports_atomic_onboarding() {
        return Err(ApiError::internal(
            "SUPABASE_SERVICE_ROLE_KEY must be set to use onboarding fields during signup",
        ));
    }

    enforce_auth_rate_limit(
        &state,
        remote_addr,
        AuthRouteKind::SignUp,
        normalize_email(&payload.email)?,
    )?;
    let response = state.auth_api.sign_up(payload).await?;
    if !has_onboarding {
        return Ok(Json(response));
    }

    let user_id = response
        .user
        .as_ref()
        .map(|user| user.id)
        .ok_or_else(|| ApiError::internal("Supabase signup response did not include a user"))?;

    let onboarding_result = async {
        let mut transaction = state.pool.begin().await.map_err(map_signup_error)?;
        apply_recommendation_preferences(&mut transaction, user_id, &validated_preferences).await?;
        subscribe_user_to_sources(
            &mut transaction,
            user_id,
            &validated_source_ids,
            "auth_signup",
        )
        .await?;
        rollup_and_refresh_recommendation_state(&mut transaction, user_id).await?;
        transaction.commit().await.map_err(map_signup_error)?;
        Ok::<(), ApiError>(())
    }
    .await;

    if let Err(error) = onboarding_result {
        if let Err(cleanup_error) = state.auth_api.delete_user(user_id).await {
            tracing::error!(
                error = ?cleanup_error,
                %user_id,
                "failed to roll back auth user after signup onboarding error",
            );
        }
        return Err(error);
    }

    Ok(Json(response))
}

pub async fn create_session(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Json(payload): Json<CreateSessionRequest>,
) -> ApiResult<Json<AuthFlowResponse>> {
    enforce_auth_rate_limit(
        &state,
        remote_addr,
        AuthRouteKind::Session,
        normalize_email(&payload.email)?,
    )?;
    state.auth_api.create_session(payload).await.map(Json)
}

pub async fn refresh_session(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Json(payload): Json<RefreshSessionRequest>,
) -> ApiResult<Json<AuthFlowResponse>> {
    enforce_auth_refresh_rate_limit(&state, remote_addr, &payload.refresh_token)?;
    state.auth_api.refresh_session(payload).await.map(Json)
}

fn build_auth_headers(api_key: &str) -> Result<HeaderMap, ApiError> {
    let mut headers = HeaderMap::new();
    let api_key_header = HeaderValue::from_str(api_key)
        .map_err(|_| ApiError::internal("Supabase publishable key is invalid"))?;
    headers.insert("apikey", api_key_header.clone());

    let authorization_header = HeaderValue::from_str(&format!("Bearer {api_key}"))
        .map_err(|_| ApiError::internal("Supabase publishable key is invalid"))?;
    headers.insert(AUTHORIZATION, authorization_header);

    Ok(headers)
}

pub(crate) fn normalize_email(input: &str) -> ApiResult<String> {
    let email = input.trim().to_ascii_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(ApiError::bad_request("email must be a valid email address"));
    }

    Ok(email)
}

fn normalize_password(input: &str) -> ApiResult<String> {
    let password = input.trim().to_string();
    if password.len() < 8 {
        return Err(ApiError::bad_request(
            "password must be at least 8 characters long",
        ));
    }

    Ok(password)
}

fn normalize_refresh_token(input: &str) -> ApiResult<String> {
    let refresh_token = input.trim().to_string();
    if refresh_token.is_empty() {
        return Err(ApiError::bad_request("refresh_token must be provided"));
    }

    Ok(refresh_token)
}

fn map_upstream_status(status: StatusCode) -> StatusCode {
    match status {
        StatusCode::BAD_REQUEST
        | StatusCode::UNAUTHORIZED
        | StatusCode::FORBIDDEN
        | StatusCode::UNPROCESSABLE_ENTITY
        | StatusCode::TOO_MANY_REQUESTS => status,
        _ => StatusCode::BAD_GATEWAY,
    }
}

enum AuthRouteKind {
    SignUp,
    Session,
}

fn enforce_auth_rate_limit(
    state: &AppState,
    remote_addr: SocketAddr,
    route: AuthRouteKind,
    email: String,
) -> ApiResult<()> {
    match route {
        AuthRouteKind::SignUp => state
            .auth_rate_limiter
            .check_sign_up(remote_addr.ip(), &email),
        AuthRouteKind::Session => state
            .auth_rate_limiter
            .check_session(remote_addr.ip(), &email),
    }
}

fn enforce_auth_refresh_rate_limit(
    state: &AppState,
    remote_addr: SocketAddr,
    refresh_token: &str,
) -> ApiResult<()> {
    state
        .auth_rate_limiter
        .check_session_refresh(remote_addr.ip(), refresh_token)
}

fn map_signup_error(error: sqlx::Error) -> ApiError {
    tracing::error!(error = %error, "signup onboarding transaction failed");
    ApiError::internal("Database operation failed")
}

#[derive(Debug, Clone, Deserialize)]
pub struct SignUpRequest {
    pub username: String,
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub topic_slugs: Vec<String>,
    #[serde(default)]
    pub language_codes: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RefreshSessionRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct AuthFlowResponse {
    session: Option<AuthSession>,
    user: Option<AuthUser>,
}

impl From<SupabaseAuthResponse> for AuthFlowResponse {
    fn from(value: SupabaseAuthResponse) -> Self {
        let session = match (
            value.access_token,
            value.refresh_token,
            value.token_type,
            value.expires_in,
        ) {
            (Some(access_token), Some(refresh_token), Some(token_type), Some(expires_in)) => {
                Some(AuthSession {
                    access_token,
                    refresh_token,
                    token_type,
                    expires_in,
                    expires_at: value.expires_at,
                })
            }
            _ => None,
        };

        Self {
            session,
            user: value.user.map(AuthUser::from),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AuthSession {
    access_token: String,
    refresh_token: String,
    token_type: String,
    expires_in: i64,
    expires_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct AuthUser {
    id: Uuid,
    email: Option<String>,
    role: Option<String>,
    email_confirmed_at: Option<String>,
    user_metadata: Option<Value>,
    app_metadata: Option<Value>,
}

impl From<SupabaseUser> for AuthUser {
    fn from(value: SupabaseUser) -> Self {
        Self {
            id: value.id,
            email: value.email,
            role: value.role,
            email_confirmed_at: value.email_confirmed_at,
            user_metadata: value.user_metadata,
            app_metadata: value.app_metadata,
        }
    }
}

#[derive(Debug, Deserialize)]
struct SupabaseAuthResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<i64>,
    expires_at: Option<i64>,
    user: Option<SupabaseUser>,
}

#[derive(Debug, Deserialize)]
struct SupabaseUser {
    id: Uuid,
    email: Option<String>,
    role: Option<String>,
    email_confirmed_at: Option<String>,
    user_metadata: Option<Value>,
    app_metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct SupabaseAuthError {
    error: Option<String>,
    error_description: Option<String>,
    msg: Option<String>,
}

impl SupabaseAuthError {
    fn message(&self) -> Option<&str> {
        self.msg
            .as_deref()
            .or(self.error_description.as_deref())
            .or(self.error.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::{build_auth_headers, normalize_email, normalize_password};
    use axum::http::header::AUTHORIZATION;

    #[test]
    fn normalizes_email_to_lowercase() {
        assert_eq!(
            normalize_email("  USER@Example.COM ").expect("email should be valid"),
            "user@example.com"
        );
    }

    #[test]
    fn rejects_short_passwords() {
        assert!(normalize_password("short").is_err());
    }

    #[test]
    fn builds_headers_with_api_key() {
        let headers = build_auth_headers("test-key").expect("headers should build");
        assert_eq!(headers["apikey"], "test-key");
        assert_eq!(headers[AUTHORIZATION], "Bearer test-key");
    }
}
