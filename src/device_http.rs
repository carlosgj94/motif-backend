use std::str;

use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::Request,
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, TRANSFER_ENCODING},
    },
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use serde::Serialize;

use crate::{
    AppState, auth_api, error::ApiError, profile, recommendations, saved_content,
    source_subscriptions,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/session/refresh", post(auth_api::refresh_session))
        .route("/me", get(profile::me))
        .route("/me/saved-content", get(saved_content::list_saved_content))
        .route(
            "/me/saved-content/{saved_content_id}",
            get(saved_content::get_saved_content),
        )
        .route("/me/inbox", get(source_subscriptions::list_inbox))
        .route(
            "/me/inbox/{inbox_item_id}",
            get(source_subscriptions::get_inbox_item),
        )
        .route(
            "/me/recommendations/content",
            get(recommendations::list_content_recommendations),
        )
        .route(
            "/me/content/{content_id}",
            get(recommendations::get_content_detail),
        )
        .fallback(device_not_found)
        .layer(middleware::from_fn(normalize_device_response))
}

async fn device_not_found() -> ApiError {
    ApiError::not_found("Route was not found")
}

async fn normalize_device_response(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    normalize_response(response).await
}

async fn normalize_response(response: Response) -> Response {
    let (mut parts, body) = response.into_parts();
    let bytes = match to_bytes(body, usize::MAX).await {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::error!(error = %error, "failed to buffer device response body");
            return finalize_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                HeaderMap::new(),
                encode_error_body(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to buffer device response body",
                ),
            );
        }
    };

    let status = parts.status;
    let is_json = is_json_response(&parts.headers);

    let body_bytes = if is_json {
        bytes
    } else if bytes.is_empty() && status.is_success() {
        bytes
    } else {
        encode_error_body(status, plain_text_message(status, &bytes))
    };

    scrub_transport_headers(&mut parts.headers);

    if body_bytes.is_empty() {
        if !parts.headers.contains_key(CONTENT_LENGTH) {
            parts
                .headers
                .insert(CONTENT_LENGTH, HeaderValue::from_static("0"));
        }

        return Response::from_parts(parts, Body::from(body_bytes));
    }

    parts
        .headers
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    insert_content_length(&mut parts.headers, body_bytes.len());

    Response::from_parts(parts, Body::from(body_bytes))
}

fn finalize_response(status: StatusCode, mut headers: HeaderMap, body: Bytes) -> Response {
    scrub_transport_headers(&mut headers);
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    insert_content_length(&mut headers, body.len());

    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

fn insert_content_length(headers: &mut HeaderMap, length: usize) {
    let value =
        HeaderValue::from_str(&length.to_string()).expect("content length header should be valid");
    headers.insert(CONTENT_LENGTH, value);
}

fn scrub_transport_headers(headers: &mut HeaderMap) {
    headers.remove(TRANSFER_ENCODING);
    headers.remove(CONTENT_ENCODING);
}

fn is_json_response(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
}

fn plain_text_message(status: StatusCode, bytes: &[u8]) -> String {
    let message = str::from_utf8(bytes).unwrap_or_default().trim();
    if message.is_empty() {
        status
            .canonical_reason()
            .unwrap_or("Request failed")
            .to_string()
    } else {
        message.to_string()
    }
}

fn encode_error_body(status: StatusCode, message: impl Into<String>) -> Bytes {
    let body = DeviceErrorBody {
        error: error_code_for_status(status),
        message: message.into(),
    };

    serde_json::to_vec(&body)
        .map(Bytes::from)
        .expect("device error body should serialize")
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

#[derive(Serialize)]
struct DeviceErrorBody {
    error: &'static str,
    message: String,
}

#[cfg(test)]
mod tests {
    use super::normalize_device_response;
    use super::*;
    use axum::{
        Json,
        extract::{Path, Query},
        http::Request,
        routing::get,
    };
    use serde::Deserialize;
    use serde_json::{Value, json};
    use tower::util::ServiceExt;
    use uuid::Uuid;

    #[derive(Deserialize)]
    struct LimitQuery {
        limit: u32,
    }

    fn test_app() -> Router {
        Router::new()
            .route("/ok", get(|| async { Json(json!({ "ok": true })) }))
            .route(
                "/large",
                get(|| async {
                    Json(json!({
                        "body": "device-transport".repeat(512),
                    }))
                }),
            )
            .route(
                "/json",
                post(|Json(payload): Json<Value>| async move { Json(payload) }),
            )
            .route(
                "/query",
                get(|Query(query): Query<LimitQuery>| async move {
                    Json(json!({ "limit": query.limit }))
                }),
            )
            .route(
                "/path/{id}",
                get(|Path(id): Path<Uuid>| async move { Json(json!({ "id": id })) }),
            )
            .layer(middleware::from_fn(normalize_device_response))
    }

    #[tokio::test]
    async fn successful_json_response_has_device_headers() {
        let response = test_app()
            .oneshot(Request::builder().uri("/ok").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "application/json");
        assert!(response.headers().get(TRANSFER_ENCODING).is_none());
        assert!(response.headers().get(CONTENT_ENCODING).is_none());
        let content_length = response.headers()[CONTENT_LENGTH]
            .to_str()
            .unwrap()
            .to_string();

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body, Bytes::from_static(br#"{"ok":true}"#));
        assert_eq!(content_length, body.len().to_string());
    }

    #[tokio::test]
    async fn malformed_json_body_returns_json_error() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/json")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from("{"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()[CONTENT_TYPE], "application/json");

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
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
                    .method("POST")
                    .uri("/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(response.headers()[CONTENT_TYPE], "application/json");

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
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
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()[CONTENT_TYPE], "application/json");

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "bad_request");
        assert!(
            body["message"]
                .as_str()
                .is_some_and(|message| message.starts_with("Failed to deserialize query string"))
        );
    }

    #[tokio::test]
    async fn invalid_path_returns_json_error() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .uri("/path/not-a-uuid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()[CONTENT_TYPE], "application/json");

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "bad_request");
        assert!(
            body["message"]
                .as_str()
                .is_some_and(|message| !message.is_empty())
        );
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
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(first.headers()[CONTENT_TYPE], "application/json");
        assert!(first.headers().get(TRANSFER_ENCODING).is_none());
        assert!(first.headers().get(CONTENT_ENCODING).is_none());
        assert_eq!(
            first.headers()[CONTENT_LENGTH].to_str().unwrap(),
            expected_large.len().to_string()
        );
        let first_body = to_bytes(first.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            String::from_utf8(first_body.to_vec()).unwrap(),
            expected_large
        );

        let second = app
            .oneshot(Request::builder().uri("/ok").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(second.headers()[CONTENT_TYPE], "application/json");
        assert!(second.headers().get(TRANSFER_ENCODING).is_none());
        assert!(second.headers().get(CONTENT_ENCODING).is_none());
        assert_eq!(
            second.headers()[CONTENT_LENGTH].to_str().unwrap(),
            expected_ok.len().to_string()
        );
        let second_body = to_bytes(second.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            String::from_utf8(second_body.to_vec()).unwrap(),
            expected_ok
        );
    }
}
