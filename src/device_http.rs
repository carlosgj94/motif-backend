use std::net::SocketAddr;

use axum::{
    Json, Router,
    extract::{
        ConnectInfo, FromRequest, FromRequestParts, Path, Query, Request, State,
        rejection::{JsonRejection, PathRejection, QueryRejection},
    },
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Serialize, de::DeserializeOwned};
use uuid::Uuid;

use crate::{
    AppState, auth::AuthenticatedUser, auth_api, error, error::ApiError, profile, recommendations,
    saved_content, source_subscriptions,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/session/refresh", post(refresh_session))
        .route("/me", get(me))
        .route("/me/saved-content", get(list_saved_content))
        .route(
            "/me/saved-content/{saved_content_id}",
            get(get_saved_content),
        )
        .route(
            "/me/saved-content/{saved_content_id}/package",
            get(get_saved_content_package),
        )
        .route("/me/inbox", get(list_inbox))
        .route("/me/inbox/{inbox_item_id}", get(get_inbox_item))
        .route(
            "/me/inbox/{inbox_item_id}/package",
            get(get_inbox_item_package),
        )
        .route(
            "/me/recommendations/content",
            get(list_content_recommendations),
        )
        .route(
            "/me/recommendations/content/by-topic/{topic_slug}",
            get(list_content_recommendations_by_topic),
        )
        .route(
            "/me/recommendations/subtopics",
            get(list_recommendation_subtopics),
        )
        .route("/me/content/{content_id}", get(get_content_detail))
        .route("/me/content/{content_id}/package", get(get_content_package))
        .fallback(device_not_found)
        .method_not_allowed_fallback(device_method_not_allowed)
}

async fn refresh_session(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    DeviceJson(payload): DeviceJson<auth_api::RefreshSessionRequest>,
) -> Result<DeviceJson<auth_api::AuthFlowResponse>, ApiError> {
    auth_api::refresh_session(State(state), ConnectInfo(remote_addr), Json(payload))
        .await
        .map(map_json)
}

async fn me(
    user: AuthenticatedUser,
    State(state): State<AppState>,
) -> Result<DeviceJson<profile::MeResponse>, ApiError> {
    profile::me(user, State(state)).await.map(map_json)
}

async fn list_saved_content(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    DeviceQuery(query): DeviceQuery<saved_content::ListSavedContentQuery>,
) -> Result<DeviceJson<saved_content::SavedContentListResponse>, ApiError> {
    saved_content::list_saved_content(user, State(state), Query(query))
        .await
        .map(map_json)
}

async fn get_saved_content(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    DevicePath(saved_content_id): DevicePath<Uuid>,
) -> Result<DeviceJson<saved_content::SavedContentDetail>, ApiError> {
    saved_content::get_saved_content(user, State(state), Path(saved_content_id))
        .await
        .map(map_json)
}

async fn get_saved_content_package(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    DevicePath(saved_content_id): DevicePath<Uuid>,
) -> Result<Response, ApiError> {
    saved_content::get_saved_content_package(user, State(state), Path(saved_content_id)).await
}

async fn list_inbox(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    DeviceQuery(query): DeviceQuery<source_subscriptions::ListInboxQuery>,
) -> Result<DeviceJson<source_subscriptions::InboxListResponse>, ApiError> {
    source_subscriptions::list_inbox(user, State(state), Query(query))
        .await
        .map(map_json)
}

async fn get_inbox_item(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    DevicePath(inbox_item_id): DevicePath<Uuid>,
) -> Result<DeviceJson<source_subscriptions::InboxItemDetail>, ApiError> {
    source_subscriptions::get_inbox_item(user, State(state), Path(inbox_item_id))
        .await
        .map(map_json)
}

async fn get_inbox_item_package(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    DevicePath(inbox_item_id): DevicePath<Uuid>,
) -> Result<Response, ApiError> {
    source_subscriptions::get_inbox_item_package(user, State(state), Path(inbox_item_id)).await
}

async fn list_content_recommendations(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    DeviceQuery(query): DeviceQuery<recommendations::ListRecommendationsQuery>,
) -> Result<DeviceJson<recommendations::ContentRecommendationListResponse>, ApiError> {
    recommendations::list_content_recommendations(user, State(state), Query(query))
        .await
        .map(map_json)
}

async fn get_content_detail(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    DevicePath(content_id): DevicePath<Uuid>,
) -> Result<DeviceJson<recommendations::RecommendationContentDetail>, ApiError> {
    recommendations::get_content_detail(user, State(state), Path(content_id))
        .await
        .map(map_json)
}

async fn get_content_package(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    DevicePath(content_id): DevicePath<Uuid>,
) -> Result<Response, ApiError> {
    recommendations::get_content_package(user, State(state), Path(content_id)).await
}

async fn list_content_recommendations_by_topic(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    DevicePath(topic_slug): DevicePath<String>,
    DeviceQuery(query): DeviceQuery<recommendations::ListRecommendationsQuery>,
) -> Result<DeviceJson<recommendations::ContentRecommendationListResponse>, ApiError> {
    recommendations::list_content_recommendations_by_topic(
        user,
        State(state),
        Path(topic_slug),
        Query(query),
    )
    .await
    .map(map_json)
}

async fn list_recommendation_subtopics(
    user: AuthenticatedUser,
    State(state): State<AppState>,
) -> Result<DeviceJson<recommendations::RecommendationSubtopicListResponse>, ApiError> {
    recommendations::list_user_recommendation_subtopics(user, State(state))
        .await
        .map(map_json)
}

async fn device_not_found() -> ApiError {
    ApiError::not_found("Route was not found")
}

async fn device_method_not_allowed() -> ApiError {
    ApiError::with_status(
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
        "Method not allowed",
    )
}

fn map_json<T>(Json(value): Json<T>) -> DeviceJson<T> {
    DeviceJson(value)
}

fn map_rejection(status: StatusCode, message: String) -> ApiError {
    ApiError::with_status(status, error_code_for_status(status), message)
}

fn error_code_for_status(status: StatusCode) -> &'static str {
    match status {
        StatusCode::BAD_REQUEST => "bad_request",
        StatusCode::UNAUTHORIZED => "unauthorized",
        StatusCode::FORBIDDEN => "forbidden",
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::METHOD_NOT_ALLOWED => "method_not_allowed",
        StatusCode::CONFLICT => "conflict",
        StatusCode::UNSUPPORTED_MEDIA_TYPE => "unsupported_media_type",
        StatusCode::UNPROCESSABLE_ENTITY => "unprocessable_entity",
        StatusCode::TOO_MANY_REQUESTS => "rate_limited",
        _ if status.is_server_error() => "internal_server_error",
        _ => "request_error",
    }
}

struct DeviceJson<T>(T);

impl<T> IntoResponse for DeviceJson<T>
where
    T: Serialize,
{
    fn into_response(self) -> Response {
        match error::serialize_json(&self.0) {
            Ok(body) => error::json_response(StatusCode::OK, body),
            Err(serialize_error) => {
                tracing::error!(error = %serialize_error, "failed to serialize device response body");
                ApiError::internal("Failed to serialize device response body").into_response()
            }
        }
    }
}

impl<S, T> FromRequest<S> for DeviceJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(req, state)
            .await
            .map(map_json)
            .map_err(map_json_rejection)
    }
}

struct DeviceQuery<T>(T);

impl<S, T> FromRequestParts<S> for DeviceQuery<T>
where
    S: Send + Sync,
    T: DeserializeOwned + Send,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Query::<T>::from_request_parts(parts, state)
            .await
            .map(|Query(value)| Self(value))
            .map_err(map_query_rejection)
    }
}

struct DevicePath<T>(T);

impl<S, T> FromRequestParts<S> for DevicePath<T>
where
    S: Send + Sync,
    T: DeserializeOwned + Send,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Path::<T>::from_request_parts(parts, state)
            .await
            .map(|Path(value)| Self(value))
            .map_err(map_path_rejection)
    }
}

fn map_json_rejection(rejection: JsonRejection) -> ApiError {
    map_rejection(rejection.status(), rejection.body_text())
}

fn map_query_rejection(rejection: QueryRejection) -> ApiError {
    map_rejection(rejection.status(), rejection.body_text())
}

fn map_path_rejection(rejection: PathRejection) -> ApiError {
    map_rejection(rejection.status(), rejection.body_text())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth::SupabaseAuth, auth_api::SupabaseAuthApi, config::SupabaseConfig, rate_limit::AuthRateLimiter};
    use axum::{
        http::{Method, Request},
        routing::get,
    };
    use serde::Deserialize;
    use serde_json::{Value, json};
    use sqlx::postgres::PgPoolOptions;
    use std::time::Duration;
    use tower::util::ServiceExt;

    #[derive(Deserialize)]
    struct LimitQuery {
        limit: u32,
    }

    fn test_app() -> Router {
        Router::new()
            .route("/ok", get(|| async { DeviceJson(json!({ "ok": true })) }))
            .route(
                "/large",
                get(|| async {
                    DeviceJson(json!({
                        "body": "device-transport".repeat(512),
                    }))
                }),
            )
            .route(
                "/json",
                post(|DeviceJson(payload): DeviceJson<Value>| async move {
                    DeviceJson(payload)
                }),
            )
            .route(
                "/query",
                get(|DeviceQuery(query): DeviceQuery<LimitQuery>| async move {
                    DeviceJson(json!({ "limit": query.limit }))
                }),
            )
            .route(
                "/path/{id}",
                get(|DevicePath(id): DevicePath<Uuid>| async move {
                    DeviceJson(json!({ "id": id }))
                }),
            )
            .fallback(device_not_found)
            .method_not_allowed_fallback(device_method_not_allowed)
    }

    fn test_state() -> AppState {
        let config = SupabaseConfig {
            url: "http://127.0.0.1:9999".to_string(),
            issuer: "http://127.0.0.1:9999/auth/v1".to_string(),
            jwks_url: "http://127.0.0.1:9999/auth/v1/.well-known/jwks.json".to_string(),
            audience: "authenticated".to_string(),
            jwks_cache_ttl: Duration::from_secs(300),
            publishable_key: Some("publishable-test-key".to_string()),
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

    #[tokio::test]
    async fn successful_json_response_has_device_headers() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .uri("/ok")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "application/json");
        assert_eq!(response.headers()["content-length"], "11");

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(body, axum::body::Bytes::from_static(br#"{"ok":true}"#));
    }

    #[tokio::test]
    async fn malformed_json_body_returns_json_error() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/json")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from("{"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()["content-type"], "application/json");

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "bad_request");
        assert!(body["message"].as_str().is_some_and(|message| {
            message.starts_with("Failed to parse the request body as JSON")
        }));
    }

    #[tokio::test]
    async fn missing_json_content_type_returns_json_error() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/json")
                    .body(axum::body::Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(response.headers()["content-type"], "application/json");

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "unsupported_media_type");
        assert_eq!(
            body["message"],
            "Expected request with `Content-Type: application/json`"
        );
    }

    #[tokio::test]
    async fn invalid_query_returns_json_error() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .uri("/query?limit=abc")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()["content-type"], "application/json");

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "bad_request");
        assert!(
            body["message"].as_str().is_some_and(|message| {
                message.starts_with("Failed to deserialize query string")
            })
        );
    }

    #[tokio::test]
    async fn invalid_path_returns_json_error() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .uri("/path/not-a-uuid")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()["content-type"], "application/json");

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "bad_request");
        assert!(
            body["message"]
                .as_str()
                .is_some_and(|message| !message.is_empty())
        );
    }

    #[tokio::test]
    async fn method_not_allowed_returns_json_error() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/ok")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(response.headers()["content-type"], "application/json");

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "method_not_allowed");
        assert_eq!(body["message"], "Method not allowed");
    }

    #[tokio::test]
    async fn not_found_returns_json_error() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .uri("/missing")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()["content-type"], "application/json");

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "not_found");
        assert_eq!(body["message"], "Route was not found");
    }

    #[tokio::test]
    async fn multiple_responses_set_content_length_independently() {
        let expected_large = serde_json::to_string(&json!({
            "body": "device-transport".repeat(512),
        }))
        .unwrap();
        let expected_ok = serde_json::to_string(&json!({ "ok": true })).unwrap();

        let app = test_app();

        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/large")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(first.headers()["content-type"], "application/json");
        assert_eq!(
            first.headers()["content-length"].to_str().unwrap(),
            expected_large.len().to_string()
        );
        let first_body = axum::body::to_bytes(first.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8(first_body.to_vec()).unwrap(),
            expected_large
        );

        let second = app
            .oneshot(
                Request::builder()
                    .uri("/ok")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(second.headers()["content-type"], "application/json");
        assert_eq!(
            second.headers()["content-length"].to_str().unwrap(),
            expected_ok.len().to_string()
        );
        let second_body = axum::body::to_bytes(second.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8(second_body.to_vec()).unwrap(),
            expected_ok
        );
    }

    #[tokio::test]
    async fn recommendation_topic_routes_exist_and_require_auth() {
        let app = router().with_state(test_state());

        let subtopics = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/me/recommendations/subtopics")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(subtopics.status(), StatusCode::UNAUTHORIZED);

        let filtered = app
            .oneshot(
                Request::builder()
                    .uri("/me/recommendations/content/by-topic/programming")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(filtered.status(), StatusCode::UNAUTHORIZED);
    }
}
