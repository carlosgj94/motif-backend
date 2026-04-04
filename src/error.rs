use axum::{
    body::{Body, Bytes},
    http::{
        HeaderValue, StatusCode,
        header::{CONTENT_LENGTH, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
};
use serde::Serialize;

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    pub fn with_status(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self::new(status, code, message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "conflict", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_server_error",
            message,
        )
    }

    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = serialize_json(&ErrorBody {
            error: self.code,
            message: self.message,
        })
        .expect("error body serialization should not fail");

        json_response(self.status, body)
    }
}

pub(crate) fn serialize_json<T: Serialize>(value: &T) -> Result<Bytes, serde_json::Error> {
    serde_json::to_vec(value).map(Bytes::from)
}

pub(crate) fn json_response(status: StatusCode, body: Bytes) -> Response {
    let content_length = HeaderValue::from_str(&body.len().to_string())
        .expect("content length header should be valid");
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
        .headers_mut()
        .insert(CONTENT_LENGTH, content_length);
    response
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    message: String,
}
