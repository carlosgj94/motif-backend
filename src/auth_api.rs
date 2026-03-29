use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::{HeaderMap, HeaderValue, StatusCode, header::AUTHORIZATION},
};
use reqwest::{Client, Method, Request, Response};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::net::SocketAddr;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedSession,
    config::SupabaseConfig,
    error::{ApiError, ApiResult},
    profile::normalize_username,
};

#[derive(Clone)]
pub struct SupabaseAuthApi {
    api_key: Option<String>,
    api_url: String,
    client: Client,
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
        }
    }

    pub async fn sign_up(&self, request: SignUpRequest) -> Result<AuthFlowResponse, ApiError> {
        let email = normalize_email(&request.email)?;
        let password = normalize_password(&request.password)?;
        let username = normalize_username(&request.username)?;
        let request = self.build_public_auth_request(
            Method::POST,
            "signup",
            Some(&json!({
                "email": email,
                "password": password,
                "data": {
                    "username": username
                }
            })),
        )?;

        self.send_json_auth_request::<SupabaseAuthResponse>(request)
            .await
            .map(AuthFlowResponse::from)
    }

    pub async fn create_session(
        &self,
        request: CreateSessionRequest,
    ) -> Result<AuthFlowResponse, ApiError> {
        let email = normalize_email(&request.email)?;
        let password = normalize_password(&request.password)?;
        let request = self.build_public_auth_request(
            Method::POST,
            "token?grant_type=password",
            Some(&json!({
                "email": email,
                "password": password,
            })),
        )?;

        self.send_json_auth_request::<SupabaseAuthResponse>(request)
            .await
            .map(AuthFlowResponse::from)
    }

    pub async fn refresh_session(
        &self,
        request: RefreshSessionRequest,
    ) -> Result<AuthFlowResponse, ApiError> {
        let refresh_token = normalize_refresh_token(&request.refresh_token)?;
        let request = self.build_public_auth_request(
            Method::POST,
            "token?grant_type=refresh_token",
            Some(&json!({
                "refresh_token": refresh_token,
            })),
        )?;

        self.send_json_auth_request::<SupabaseAuthResponse>(request)
            .await
            .map(AuthFlowResponse::from)
    }

    pub async fn reauthenticate(&self, access_token: &str) -> Result<(), ApiError> {
        let request =
            self.build_user_auth_request(Method::GET, "reauthenticate", access_token, None)?;

        self.send_status_only_auth_request(request).await
    }

    pub async fn update_password(
        &self,
        access_token: &str,
        request: UpdatePasswordRequest,
    ) -> Result<(), ApiError> {
        let new_password = normalize_password(&request.new_password)?;
        let nonce = normalize_optional_nonce(request.nonce.as_deref())?;
        let mut payload = json!({
            "password": new_password,
        });

        if let Some(nonce) = nonce {
            payload["nonce"] = Value::String(nonce);
        }

        let request =
            self.build_user_auth_request(Method::PUT, "user", access_token, Some(&payload))?;
        self.send_status_only_auth_request(request).await
    }

    fn build_public_auth_request(
        &self,
        method: Method,
        path: &str,
        payload: Option<&Value>,
    ) -> Result<Request, ApiError> {
        let api_key = self.publishable_key()?;
        self.build_auth_request(method, path, api_key, payload)
    }

    fn build_user_auth_request(
        &self,
        method: Method,
        path: &str,
        access_token: &str,
        payload: Option<&Value>,
    ) -> Result<Request, ApiError> {
        self.build_auth_request(method, path, access_token, payload)
    }

    fn build_auth_request(
        &self,
        method: Method,
        path: &str,
        bearer_token: &str,
        payload: Option<&Value>,
    ) -> Result<Request, ApiError> {
        let api_key = self.publishable_key()?;
        let headers = build_auth_headers(api_key, bearer_token)?;
        let url = format!("{}/{}", self.api_url, path.trim_start_matches('/'));
        let request = self.client.request(method, url).headers(headers);
        let request = if let Some(payload) = payload {
            request.json(payload)
        } else {
            request
        };

        request
            .build()
            .map_err(|_| ApiError::internal("Supabase auth request could not be built"))
    }

    async fn send_request(&self, request: Request) -> Result<(StatusCode, Vec<u8>), ApiError> {
        let response = self.client.execute(request).await.map_err(|error| {
            tracing::error!(error = %error, "failed to call Supabase auth API");
            ApiError::internal("Failed to reach Supabase auth API")
        })?;

        let status = response.status();
        let body = read_response_body(response).await?;
        Ok((status, body))
    }

    async fn send_json_auth_request<T: DeserializeOwned>(
        &self,
        request: Request,
    ) -> Result<T, ApiError> {
        let (status, body) = self.send_request(request).await?;
        ensure_auth_success(status, &body)?;

        serde_json::from_slice::<T>(&body).map_err(|error| {
            tracing::error!(error = %error, "failed to decode Supabase auth success response");
            ApiError::internal("Supabase auth response was invalid")
        })
    }

    async fn send_status_only_auth_request(&self, request: Request) -> Result<(), ApiError> {
        let (status, body) = self.send_request(request).await?;
        ensure_auth_success(status, &body)
    }

    fn publishable_key(&self) -> Result<&str, ApiError> {
        self.api_key.as_deref().ok_or_else(|| {
            ApiError::internal(
                "SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY must be set to use auth endpoints",
            )
        })
    }
}

async fn read_response_body(response: Response) -> Result<Vec<u8>, ApiError> {
    response
        .bytes()
        .await
        .map(|body| body.to_vec())
        .map_err(|error| {
            tracing::error!(error = %error, "failed to read Supabase auth response body");
            ApiError::internal("Failed to read Supabase auth response")
        })
}

fn ensure_auth_success(status: StatusCode, body: &[u8]) -> Result<(), ApiError> {
    if status.is_success() {
        return Ok(());
    }

    let provider_error = serde_json::from_slice::<SupabaseAuthError>(body).ok();
    let message = provider_error
        .as_ref()
        .and_then(SupabaseAuthError::message)
        .unwrap_or("Supabase auth request failed");

    Err(ApiError::with_status(
        map_upstream_status(status),
        "auth_provider_error",
        message,
    ))
}

pub async fn reauthenticate_password(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    session: AuthenticatedSession,
) -> ApiResult<StatusCode> {
    enforce_password_reauthenticate_rate_limit(&state, remote_addr, session.user.user_id)?;
    state.auth_api.reauthenticate(&session.access_token).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_password(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    session: AuthenticatedSession,
    Json(payload): Json<UpdatePasswordRequest>,
) -> ApiResult<StatusCode> {
    enforce_password_change_rate_limit(&state, remote_addr, session.user.user_id)?;
    state
        .auth_api
        .update_password(&session.access_token, payload)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn sign_up(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Json(payload): Json<SignUpRequest>,
) -> ApiResult<Json<AuthFlowResponse>> {
    enforce_auth_rate_limit(
        &state,
        remote_addr,
        AuthRouteKind::SignUp,
        normalize_email(&payload.email)?,
    )?;
    state.auth_api.sign_up(payload).await.map(Json)
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

fn build_auth_headers(api_key: &str, bearer_token: &str) -> Result<HeaderMap, ApiError> {
    let mut headers = HeaderMap::new();
    let api_key_header = HeaderValue::from_str(api_key)
        .map_err(|_| ApiError::internal("Supabase publishable key is invalid"))?;
    headers.insert("apikey", api_key_header.clone());

    let authorization_header = HeaderValue::from_str(&format!("Bearer {bearer_token}"))
        .map_err(|_| ApiError::internal("Supabase authorization token is invalid"))?;
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

fn normalize_optional_nonce(input: Option<&str>) -> ApiResult<Option<String>> {
    let Some(input) = input else {
        return Ok(None);
    };

    let nonce = input.trim().to_string();
    if nonce.is_empty() {
        return Err(ApiError::bad_request("nonce must not be empty"));
    }

    Ok(Some(nonce))
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

fn enforce_password_reauthenticate_rate_limit(
    state: &AppState,
    remote_addr: SocketAddr,
    user_id: Uuid,
) -> ApiResult<()> {
    state
        .auth_rate_limiter
        .check_password_reauthenticate(remote_addr.ip(), &user_id.to_string())
}

fn enforce_password_change_rate_limit(
    state: &AppState,
    remote_addr: SocketAddr,
    user_id: Uuid,
) -> ApiResult<()> {
    state
        .auth_rate_limiter
        .check_password_change(remote_addr.ip(), &user_id.to_string())
}

#[derive(Debug, Clone, Deserialize)]
pub struct SignUpRequest {
    pub username: String,
    pub email: String,
    pub password: String,
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

#[derive(Debug, Deserialize)]
pub struct UpdatePasswordRequest {
    pub new_password: String,
    pub nonce: Option<String>,
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
    use super::{
        RefreshSessionRequest, SignUpRequest, SupabaseAuthApi, UpdatePasswordRequest,
        build_auth_headers, normalize_email, normalize_optional_nonce, normalize_password,
    };
    use crate::{
        AppState,
        auth::{AuthenticatedSession, AuthenticatedUser, SupabaseAuth},
        config::SupabaseConfig,
        rate_limit::AuthRateLimiter,
    };
    use axum::{
        Json,
        extract::{ConnectInfo, State},
        http::header::AUTHORIZATION,
        response::IntoResponse,
    };
    use reqwest::{Method, Request};
    use serde_json::{Value, json};
    use sqlx::postgres::PgPoolOptions;
    use std::{net::SocketAddr, time::Duration};
    use uuid::Uuid;

    fn test_supabase_config(url: String, publishable_key: &str) -> SupabaseConfig {
        SupabaseConfig {
            url: url.clone(),
            issuer: format!("{url}/auth/v1"),
            jwks_url: format!("{url}/auth/v1/.well-known/jwks.json"),
            audience: "authenticated".to_string(),
            jwks_cache_ttl: Duration::from_secs(300),
            publishable_key: Some(publishable_key.to_string()),
        }
    }

    fn test_app_state() -> AppState {
        let config =
            test_supabase_config("http://127.0.0.1:9999".to_string(), "publishable-test-key");

        AppState {
            auth: SupabaseAuth::new(config.clone()),
            auth_api: SupabaseAuthApi::new(&config),
            auth_rate_limiter: AuthRateLimiter::default(),
            pool: PgPoolOptions::new()
                .connect_lazy("postgresql://postgres:postgres@localhost/postgres")
                .expect("lazy pool should parse"),
        }
    }

    fn test_auth_api() -> SupabaseAuthApi {
        let config =
            test_supabase_config("http://127.0.0.1:9999".to_string(), "publishable-test-key");
        SupabaseAuthApi::new(&config)
    }

    fn test_authenticated_session() -> AuthenticatedSession {
        AuthenticatedSession {
            access_token: "user-access-token".to_string(),
            user: AuthenticatedUser {
                user_id: Uuid::nil(),
                email: Some("user@example.com".to_string()),
                role: "authenticated".to_string(),
                aal: Some("aal1".to_string()),
                session_id: Some("00000000-0000-0000-0000-000000000000".to_string()),
                app_metadata: Some(json!({})),
                user_metadata: Some(json!({})),
            },
        }
    }

    fn request_json_body(request: &Request) -> Value {
        let body = request
            .body()
            .and_then(|body| body.as_bytes())
            .expect("request body should be buffered");

        serde_json::from_slice(body).expect("request body should decode as json")
    }

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
        let headers = build_auth_headers("test-key", "test-key").expect("headers should build");
        assert_eq!(headers["apikey"], "test-key");
        assert_eq!(headers[AUTHORIZATION], "Bearer test-key");
    }

    #[test]
    fn rejects_empty_refresh_token() {
        assert!(super::normalize_refresh_token("   ").is_err());
    }

    #[tokio::test]
    async fn refresh_session_request_uses_refresh_token_grant_type() {
        let auth_api = test_auth_api();
        let request = auth_api
            .build_public_auth_request(
                Method::POST,
                "token?grant_type=refresh_token",
                Some(&json!({ "refresh_token": "refresh-token-123" })),
            )
            .expect("request should build");

        assert_eq!(request.method(), Method::POST);
        assert_eq!(request.url().path(), "/auth/v1/token");
        assert_eq!(request.url().query(), Some("grant_type=refresh_token"));
        assert_eq!(request.headers()["apikey"], "publishable-test-key");
        assert_eq!(
            request.headers()[AUTHORIZATION],
            "Bearer publishable-test-key"
        );
        assert_eq!(
            request_json_body(&request),
            json!({ "refresh_token": "refresh-token-123" })
        );
    }

    #[test]
    fn sign_up_request_uses_only_auth_fields() {
        let auth_api = test_auth_api();
        let request = auth_api
            .build_public_auth_request(
                Method::POST,
                "signup",
                Some(&json!({
                    "email": "user@example.com",
                    "password": "password123",
                    "data": {
                        "username": "reader01"
                    }
                })),
            )
            .expect("request should build");

        assert_eq!(request.method(), Method::POST);
        assert_eq!(request.url().path(), "/auth/v1/signup");
        assert_eq!(request.headers()["apikey"], "publishable-test-key");
        assert_eq!(
            request.headers()[AUTHORIZATION],
            "Bearer publishable-test-key"
        );
        assert_eq!(
            request_json_body(&request),
            json!({
                "email": "user@example.com",
                "password": "password123",
                "data": {
                    "username": "reader01"
                }
            })
        );
    }

    #[test]
    fn reauthenticate_request_uses_user_access_token() {
        let auth_api = test_auth_api();
        let request = auth_api
            .build_user_auth_request(Method::GET, "reauthenticate", "user-access-token", None)
            .expect("request should build");

        assert_eq!(request.method(), Method::GET);
        assert_eq!(request.url().path(), "/auth/v1/reauthenticate");
        assert_eq!(request.headers()["apikey"], "publishable-test-key");
        assert_eq!(request.headers()[AUTHORIZATION], "Bearer user-access-token");
        assert!(request.body().is_none());
    }

    #[test]
    fn update_password_request_includes_nonce_when_present() {
        let auth_api = test_auth_api();
        let request = auth_api
            .build_user_auth_request(
                Method::PUT,
                "user",
                "user-access-token",
                Some(&json!({
                    "password": "new-password-123",
                    "nonce": "123456",
                })),
            )
            .expect("request should build");

        assert_eq!(request.method(), Method::PUT);
        assert_eq!(request.url().path(), "/auth/v1/user");
        assert_eq!(request.headers()["apikey"], "publishable-test-key");
        assert_eq!(request.headers()[AUTHORIZATION], "Bearer user-access-token");
        assert_eq!(
            request_json_body(&request),
            json!({
                "password": "new-password-123",
                "nonce": "123456",
            })
        );
    }

    #[test]
    fn sign_up_request_ignores_extra_onboarding_fields() {
        let request = serde_json::from_value::<SignUpRequest>(json!({
            "username": "reader01",
            "email": "user@example.com",
            "password": "password123",
            "topic_slugs": ["technology"],
            "language_codes": ["en"],
            "source_ids": [Uuid::nil()],
        }))
        .expect("signup request should deserialize");

        assert_eq!(request.username, "reader01");
        assert_eq!(request.email, "user@example.com");
        assert_eq!(request.password, "password123");
    }

    #[test]
    fn rejects_empty_nonce() {
        assert!(normalize_optional_nonce(Some("   ")).is_err());
    }

    #[tokio::test]
    async fn refresh_session_handler_rejects_empty_refresh_token() {
        let state = test_app_state();
        let result = super::refresh_session(
            State(state),
            ConnectInfo("127.0.0.1:4000".parse::<SocketAddr>().unwrap()),
            Json(RefreshSessionRequest {
                refresh_token: "   ".to_string(),
            }),
        )
        .await;

        let response = result.expect_err("refresh should fail").into_response();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn update_password_handler_rejects_short_passwords() {
        let state = test_app_state();
        let result = super::update_password(
            State(state),
            ConnectInfo("127.0.0.1:4000".parse::<SocketAddr>().unwrap()),
            test_authenticated_session(),
            Json(UpdatePasswordRequest {
                new_password: "short".to_string(),
                nonce: None,
            }),
        )
        .await;

        let response = result
            .expect_err("password update should fail")
            .into_response();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn update_password_handler_rejects_empty_nonce() {
        let state = test_app_state();
        let result = super::update_password(
            State(state),
            ConnectInfo("127.0.0.1:4000".parse::<SocketAddr>().unwrap()),
            test_authenticated_session(),
            Json(UpdatePasswordRequest {
                new_password: "long-enough-password".to_string(),
                nonce: Some("   ".to_string()),
            }),
        )
        .await;

        let response = result
            .expect_err("password update should fail")
            .into_response();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn reauthenticate_password_handler_rate_limits_per_user() {
        let state = test_app_state();
        let remote_addr = "127.0.0.1:4000".parse::<SocketAddr>().unwrap();
        let user_id = Uuid::nil();

        for _ in 0..3 {
            state
                .auth_rate_limiter
                .check_password_reauthenticate(remote_addr.ip(), &user_id.to_string())
                .expect("attempt should pass");
        }

        let result = super::reauthenticate_password(
            State(state),
            ConnectInfo(remote_addr),
            test_authenticated_session(),
        )
        .await;

        let response = result
            .expect_err("reauth should be rate limited")
            .into_response();
        assert_eq!(response.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn update_password_handler_rate_limits_per_user() {
        let state = test_app_state();
        let remote_addr = "127.0.0.1:4000".parse::<SocketAddr>().unwrap();
        let user_id = Uuid::nil();

        for _ in 0..10 {
            state
                .auth_rate_limiter
                .check_password_change(remote_addr.ip(), &user_id.to_string())
                .expect("attempt should pass");
        }

        let result = super::update_password(
            State(state),
            ConnectInfo(remote_addr),
            test_authenticated_session(),
            Json(UpdatePasswordRequest {
                new_password: "long-enough-password".to_string(),
                nonce: None,
            }),
        )
        .await;

        let response = result
            .expect_err("password update should be rate limited")
            .into_response();
        assert_eq!(response.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
    }
}
