use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    extract::FromRequestParts,
    http::{header::AUTHORIZATION, request::Parts},
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::{AppState, config::SupabaseConfig, error::ApiError};

#[derive(Clone)]
pub struct SupabaseAuth {
    audience: String,
    cache_ttl: Duration,
    client: Client,
    issuer: String,
    jwks_cache: Arc<RwLock<Option<CachedJwks>>>,
    jwks_url: String,
}

impl SupabaseAuth {
    pub fn new(config: SupabaseConfig) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(concat!(
                env!("CARGO_PKG_NAME"),
                "/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .expect("reqwest client should build");

        Self {
            audience: config.audience,
            cache_ttl: config.jwks_cache_ttl,
            client,
            issuer: config.issuer,
            jwks_cache: Arc::new(RwLock::new(None)),
            jwks_url: config.jwks_url,
        }
    }

    pub async fn verify_access_token(&self, token: &str) -> Result<AuthenticatedUser, ApiError> {
        let header = decode_header(token).map_err(|error| {
            tracing::warn!(error = %error, "failed to decode JWT header");
            ApiError::unauthorized("Authorization token is malformed")
        })?;

        ensure_supported_algorithm(header.alg)?;

        let kid = header
            .kid
            .as_deref()
            .ok_or_else(|| ApiError::unauthorized("Authorization token is missing a key id"))?;

        let decoding_key = self.decoding_key_for(kid).await?;
        let claims = self.decode_claims(token, &decoding_key, header.alg).await?;

        AuthenticatedUser::from_claims(claims)
    }

    async fn decode_claims(
        &self,
        token: &str,
        decoding_key: &DecodingKey,
        algorithm: Algorithm,
    ) -> Result<AccessClaims, ApiError> {
        let mut validation = Validation::new(algorithm);
        validation.set_audience(&[self.audience.as_str()]);
        validation.set_issuer(&[self.issuer.as_str()]);
        validation.set_required_spec_claims(&["aud", "exp", "iss", "sub"]);

        decode::<AccessClaims>(token, decoding_key, &validation)
            .map(|token_data| token_data.claims)
            .map_err(|error| {
                tracing::warn!(error = %error, "failed to verify Supabase JWT");
                ApiError::unauthorized("Authorization token is invalid or expired")
            })
    }

    async fn decoding_key_for(&self, kid: &str) -> Result<DecodingKey, ApiError> {
        if let Some(key) = self.decoding_key_from_cache(kid).await? {
            return Ok(key);
        }

        self.decoding_key_forced_refresh(kid).await
    }

    async fn decoding_key_from_cache(&self, kid: &str) -> Result<Option<DecodingKey>, ApiError> {
        let cache = self.jwks_cache.read().await;
        let Some(cached) = cache.as_ref() else {
            return Ok(None);
        };

        if cached.fetched_at.elapsed() >= self.cache_ttl {
            return Ok(None);
        }

        let Some(jwk) = cached.jwks.find(kid) else {
            return Ok(None);
        };

        let key = DecodingKey::try_from(jwk).map_err(|error| {
            tracing::error!(error = %error, kid, "failed to convert JWK into decoding key");
            ApiError::unauthorized("Authorization token uses an unsupported signing key")
        })?;

        Ok(Some(key))
    }

    async fn decoding_key_forced_refresh(&self, kid: &str) -> Result<DecodingKey, ApiError> {
        let jwks = self.fetch_jwks().await?;
        let jwk = jwks
            .find(kid)
            .ok_or_else(|| ApiError::unauthorized("Authorization token uses an unknown key"))?;

        DecodingKey::try_from(jwk).map_err(|error| {
            tracing::error!(error = %error, kid, "failed to convert refreshed JWK");
            ApiError::unauthorized("Authorization token uses an unsupported signing key")
        })
    }

    async fn fetch_jwks(&self) -> Result<JwkSet, ApiError> {
        let response = self
            .client
            .get(&self.jwks_url)
            .send()
            .await
            .map_err(|error| {
                tracing::error!(error = %error, jwks_url = %self.jwks_url, "failed to fetch JWKS");
                ApiError::internal("Failed to fetch Supabase signing keys")
            })?;

        let response = response.error_for_status().map_err(|error| {
            tracing::error!(error = %error, jwks_url = %self.jwks_url, "JWKS endpoint returned an error");
            ApiError::internal("Supabase signing key endpoint returned an error")
        })?;

        let jwks = response.json::<JwkSet>().await.map_err(|error| {
            tracing::error!(error = %error, "failed to parse JWKS response");
            ApiError::internal("Supabase signing key payload was invalid")
        })?;

        let mut cache = self.jwks_cache.write().await;
        *cache = Some(CachedJwks {
            fetched_at: Instant::now(),
            jwks: jwks.clone(),
        });

        Ok(jwks)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthenticatedUser {
    pub user_id: Uuid,
    pub email: Option<String>,
    pub role: String,
    pub aal: Option<String>,
    pub session_id: Option<String>,
    pub app_metadata: Option<Value>,
    pub user_metadata: Option<Value>,
}

impl AuthenticatedUser {
    fn from_claims(claims: AccessClaims) -> Result<Self, ApiError> {
        if claims.role != "authenticated" {
            return Err(ApiError::forbidden(
                "Authorization token is not an authenticated user session",
            ));
        }

        let user_id = Uuid::parse_str(&claims.sub).map_err(|error| {
            tracing::warn!(error = %error, sub = %claims.sub, "failed to parse JWT subject");
            ApiError::unauthorized("Authorization token subject is invalid")
        })?;

        Ok(Self {
            user_id,
            email: claims.email,
            role: claims.role,
            aal: claims.aal,
            session_id: claims.session_id,
            app_metadata: claims.app_metadata,
            user_metadata: claims.user_metadata,
        })
    }
}

impl FromRequestParts<AppState> for AuthenticatedUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = extract_bearer_token(parts.headers.get(AUTHORIZATION))
            .ok_or_else(|| ApiError::unauthorized("Missing bearer authorization header"))?;

        state.auth.verify_access_token(token).await
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
struct AccessClaims {
    #[allow(dead_code)]
    aud: AudienceClaim,
    exp: usize,
    iss: String,
    sub: String,
    role: String,
    email: Option<String>,
    aal: Option<String>,
    session_id: Option<String>,
    app_metadata: Option<Value>,
    user_metadata: Option<Value>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum AudienceClaim {
    One(String),
    Many(Vec<String>),
}

#[derive(Clone)]
struct CachedJwks {
    fetched_at: Instant,
    jwks: JwkSet,
}

fn ensure_supported_algorithm(algorithm: Algorithm) -> Result<(), ApiError> {
    match algorithm {
        Algorithm::RS256
        | Algorithm::RS384
        | Algorithm::RS512
        | Algorithm::ES256
        | Algorithm::ES384 => Ok(()),
        _ => Err(ApiError::unauthorized(
            "Authorization token uses an unsupported signing algorithm",
        )),
    }
}

fn extract_bearer_token(value: Option<&axum::http::HeaderValue>) -> Option<&str> {
    let header = value?.to_str().ok()?;
    let (scheme, token) = header.split_once(' ')?;

    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }

    let token = token.trim();
    if token.is_empty() {
        return None;
    }

    Some(token)
}

#[cfg(test)]
mod tests {
    use super::extract_bearer_token;
    use axum::http::HeaderValue;

    #[test]
    fn extracts_a_bearer_token() {
        let header = HeaderValue::from_static("Bearer abc.def.ghi");
        assert_eq!(extract_bearer_token(Some(&header)), Some("abc.def.ghi"));
    }

    #[test]
    fn rejects_wrong_auth_scheme() {
        let header = HeaderValue::from_static("Basic dXNlcjpwYXNz");
        assert_eq!(extract_bearer_token(Some(&header)), None);
    }

    #[test]
    fn rejects_empty_token() {
        let header = HeaderValue::from_static("Bearer ");
        assert_eq!(extract_bearer_token(Some(&header)), None);
    }
}
