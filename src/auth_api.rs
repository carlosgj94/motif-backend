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
        RefreshSessionRequest, SignUpRequest, SupabaseAuthApi, build_auth_headers, normalize_email,
        normalize_password,
    };
    use crate::{
        AppState, auth::SupabaseAuth, config::SupabaseConfig, rate_limit::AuthRateLimiter,
    };
    use axum::{
        Json, Router,
        extract::{ConnectInfo, Query, State},
        http::{HeaderMap, header::AUTHORIZATION},
        response::IntoResponse,
        routing::post,
    };
    use serde::Deserialize;
    use serde_json::{Value, json};
    use sqlx::postgres::PgPoolOptions;
    use std::{
        collections::HashMap,
        net::SocketAddr,
        sync::{Arc, Mutex},
        time::Duration,
    };
    use tokio::sync::oneshot;
    use uuid::Uuid;

    #[derive(Debug)]
    struct CapturedRefreshRequest {
        query: HashMap<String, String>,
        auth_header: String,
        api_key_header: String,
        body: Value,
    }

    #[derive(Debug)]
    struct CapturedSignUpRequest {
        auth_header: String,
        api_key_header: String,
        body: Value,
    }

    #[derive(Clone)]
    struct CaptureState {
        sender: Arc<Mutex<Option<oneshot::Sender<CapturedRefreshRequest>>>>,
    }

    #[derive(Debug, Deserialize)]
    struct RefreshRequestBody {
        refresh_token: String,
    }

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

    async fn capture_refresh_request(
        State(state): State<CaptureState>,
        headers: HeaderMap,
        Query(query): Query<HashMap<String, String>>,
        Json(body): Json<RefreshRequestBody>,
    ) -> impl IntoResponse {
        let captured = CapturedRefreshRequest {
            query,
            auth_header: headers[AUTHORIZATION]
                .to_str()
                .expect("authorization header should be valid")
                .to_string(),
            api_key_header: headers["apikey"]
                .to_str()
                .expect("apikey header should be valid")
                .to_string(),
            body: json!({
                "refresh_token": body.refresh_token,
            }),
        };

        if let Some(sender) = state
            .sender
            .lock()
            .expect("mutex should not be poisoned")
            .take()
        {
            let _ = sender.send(captured);
        }

        Json(json!({
            "access_token": "new-access-token",
            "refresh_token": "new-refresh-token",
            "token_type": "bearer",
            "expires_in": 3600,
            "expires_at": 1775000000,
            "user": {
                "id": Uuid::nil(),
                "email": "user@example.com",
                "role": "authenticated",
                "email_confirmed_at": null,
                "user_metadata": {},
                "app_metadata": {}
            }
        }))
    }

    async fn capture_sign_up_request(
        State(state): State<CaptureState>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> impl IntoResponse {
        let captured = CapturedSignUpRequest {
            auth_header: headers[AUTHORIZATION]
                .to_str()
                .expect("authorization header should be valid")
                .to_string(),
            api_key_header: headers["apikey"]
                .to_str()
                .expect("apikey header should be valid")
                .to_string(),
            body,
        };

        if let Some(sender) = state
            .sender
            .lock()
            .expect("mutex should not be poisoned")
            .take()
        {
            let captured = CapturedRefreshRequest {
                query: HashMap::new(),
                auth_header: captured.auth_header,
                api_key_header: captured.api_key_header,
                body: captured.body,
            };
            let _ = sender.send(captured);
        }

        Json(json!({
            "user": {
                "id": Uuid::nil(),
                "email": "user@example.com",
                "role": "authenticated",
                "email_confirmed_at": null,
                "user_metadata": {
                    "username": "reader01"
                },
                "app_metadata": {}
            }
        }))
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
        let headers = build_auth_headers("test-key").expect("headers should build");
        assert_eq!(headers["apikey"], "test-key");
        assert_eq!(headers[AUTHORIZATION], "Bearer test-key");
    }

    #[test]
    fn rejects_empty_refresh_token() {
        assert!(super::normalize_refresh_token("   ").is_err());
    }

    #[tokio::test]
    async fn refresh_session_uses_refresh_token_grant_type() {
        let (sender, receiver) = oneshot::channel();
        let capture_state = CaptureState {
            sender: Arc::new(Mutex::new(Some(sender))),
        };
        let app = Router::new()
            .route("/auth/v1/token", post(capture_refresh_request))
            .with_state(capture_state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let address = listener
            .local_addr()
            .expect("listener should have local addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("server should run");
        });

        let config = test_supabase_config(format!("http://{address}"), "publishable-test-key");
        let auth_api = SupabaseAuthApi::new(&config);
        let response = auth_api
            .refresh_session(RefreshSessionRequest {
                refresh_token: "refresh-token-123".to_string(),
            })
            .await
            .expect("refresh should succeed");

        let captured = receiver.await.expect("request should be captured");
        server.abort();

        assert_eq!(
            captured.query.get("grant_type").map(String::as_str),
            Some("refresh_token")
        );
        assert_eq!(captured.auth_header, "Bearer publishable-test-key");
        assert_eq!(captured.api_key_header, "publishable-test-key");
        assert_eq!(
            captured.body,
            json!({ "refresh_token": "refresh-token-123" })
        );
        assert_eq!(
            response
                .session
                .expect("session should be present")
                .access_token,
            "new-access-token"
        );
    }

    #[tokio::test]
    async fn sign_up_uses_only_auth_fields() {
        let (sender, receiver) = oneshot::channel();
        let capture_state = CaptureState {
            sender: Arc::new(Mutex::new(Some(sender))),
        };
        let app = Router::new()
            .route("/auth/v1/signup", post(capture_sign_up_request))
            .with_state(capture_state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let address = listener
            .local_addr()
            .expect("listener should have local addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("server should run");
        });

        let config = test_supabase_config(format!("http://{address}"), "publishable-test-key");
        let auth_api = SupabaseAuthApi::new(&config);
        let response = auth_api
            .sign_up(SignUpRequest {
                username: "reader01".to_string(),
                email: "user@example.com".to_string(),
                password: "password123".to_string(),
            })
            .await
            .expect("sign up should succeed");

        let captured = receiver.await.expect("request should be captured");
        server.abort();

        assert_eq!(captured.auth_header, "Bearer publishable-test-key");
        assert_eq!(captured.api_key_header, "publishable-test-key");
        assert_eq!(
            captured.body,
            json!({
                "email": "user@example.com",
                "password": "password123",
                "data": {
                    "username": "reader01"
                }
            })
        );
        assert_eq!(
            response.user.expect("user should be present").email,
            Some("user@example.com".to_string())
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
}
