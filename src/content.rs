#![allow(dead_code)]

use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use url::Url;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

const TRACKING_QUERY_PARAMS: &[&str] = &[
    "fbclid", "gclid", "dclid", "gbraid", "wbraid", "igshid", "mc_cid", "mc_eid", "ref_src",
];

const TRACKING_QUERY_PREFIXES: &[&str] = &["utm_"];

pub const SEEDED_SYSTEM_TAGS: &[&str] = &[
    "technology",
    "science",
    "society",
    "business",
    "design",
    "culture",
    "politics",
    "health",
    "finance",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizedUrl {
    pub submitted_url: String,
    pub canonical_url: String,
    pub host: String,
}

impl NormalizedUrl {
    pub fn parse(input: &str) -> ApiResult<Self> {
        let submitted_url = input.trim();
        if submitted_url.is_empty() {
            return Err(ApiError::bad_request("url must not be empty"));
        }

        let mut url = match Url::parse(submitted_url) {
            Ok(url) => url,
            Err(_) => Url::parse(&format!("https://{submitted_url}"))
                .map_err(|_| ApiError::bad_request("url must be a valid absolute URL"))?,
        };

        match url.scheme() {
            "http" | "https" => {}
            _ => {
                return Err(ApiError::bad_request(
                    "url must use the http or https scheme",
                ));
            }
        }

        if !url.username().is_empty() || url.password().is_some() {
            return Err(ApiError::bad_request(
                "url must not include username or password",
            ));
        }

        if url.host_str().is_none() {
            return Err(ApiError::bad_request("url must include a host"));
        }

        let default_port = match url.scheme() {
            "http" => Some(80),
            "https" => Some(443),
            _ => None,
        };
        if let Some(explicit_port) = url.port()
            && Some(explicit_port) != default_port
        {
            return Err(ApiError::bad_request(
                "url must use the default port for its scheme",
            ));
        }

        url.set_fragment(None);

        if default_port == url.port() {
            let _ = url.set_port(None);
        }

        let retained_query_pairs: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(name, _)| !is_tracking_query_param(name))
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();

        if retained_query_pairs.is_empty() {
            url.set_query(None);
        } else {
            let mut pairs = url.query_pairs_mut();
            pairs.clear();
            for (name, value) in retained_query_pairs {
                pairs.append_pair(&name, &value);
            }
        }

        let host = url.host_str().expect("checked above").trim().to_string();

        Ok(Self {
            submitted_url: submitted_url.to_string(),
            canonical_url: url.into(),
            host,
        })
    }
}

fn is_tracking_query_param(name: &str) -> bool {
    TRACKING_QUERY_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
        || TRACKING_QUERY_PARAMS.contains(&name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadState {
    Unread,
    Reading,
    Read,
}

impl ReadState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unread => "unread",
            Self::Reading => "reading",
            Self::Read => "read",
        }
    }
}

impl FromStr for ReadState {
    type Err = ApiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "unread" => Ok(Self::Unread),
            "reading" => Ok(Self::Reading),
            "read" => Ok(Self::Read),
            _ => Err(ApiError::bad_request("read_state is invalid")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessingStatus {
    Pending,
    InProgress,
    Succeeded,
    Failed,
}

impl ProcessingStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}

impl FromStr for ProcessingStatus {
    type Err = ApiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "pending" => Ok(Self::Pending),
            "in_progress" => Ok(Self::InProgress),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            _ => Err(ApiError::bad_request("processing status is invalid")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TagScope {
    System,
    Custom,
}

impl TagScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Custom => "custom",
        }
    }
}

impl FromStr for TagScope {
    type Err = ApiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "system" => Ok(Self::System),
            "custom" => Ok(Self::Custom),
            _ => Err(ApiError::bad_request("tag scope is invalid")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Article,
    Thread,
    Post,
    Website,
    Video,
    Podcast,
    Pdf,
}

impl SourceKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Article => "article",
            Self::Thread => "thread",
            Self::Post => "post",
            Self::Website => "website",
            Self::Video => "video",
            Self::Podcast => "podcast",
            Self::Pdf => "pdf",
        }
    }
}

impl FromStr for SourceKind {
    type Err = ApiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "article" => Ok(Self::Article),
            "thread" => Ok(Self::Thread),
            "post" => Ok(Self::Post),
            "website" => Ok(Self::Website),
            "video" => Ok(Self::Video),
            "podcast" => Ok(Self::Podcast),
            "pdf" => Ok(Self::Pdf),
            _ => Err(ApiError::bad_request("source_kind is invalid")),
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FaviconData {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub source_url: Option<String>,
    pub fetched_at: Option<OffsetDateTime>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentRecord {
    pub id: Uuid,
    pub canonical_url: String,
    pub resolved_url: Option<String>,
    pub host: String,
    pub site_name: Option<String>,
    pub source_kind: Option<SourceKind>,
    pub title: Option<String>,
    pub excerpt: Option<String>,
    pub author: Option<String>,
    pub published_at: Option<OffsetDateTime>,
    pub language_code: Option<String>,
    pub cover_image_url: Option<String>,
    pub favicon: Option<FaviconData>,
    pub parsed_document: Option<Value>,
    pub parsed_at: Option<OffsetDateTime>,
    pub parser_name: Option<String>,
    pub parser_version: Option<String>,
    pub fetch_status: ProcessingStatus,
    pub parse_status: ProcessingStatus,
    pub last_fetch_attempt_at: Option<OffsetDateTime>,
    pub last_parse_attempt_at: Option<OffsetDateTime>,
    pub last_fetch_error: Option<String>,
    pub last_parse_error: Option<String>,
    pub fetch_attempt_count: i32,
    pub parse_attempt_count: i32,
    pub last_http_status: Option<i32>,
    pub last_successful_fetch_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedContent {
    pub id: Uuid,
    pub user_id: Uuid,
    pub content_item_id: Uuid,
    pub submitted_url: String,
    pub read_state: ReadState,
    pub is_favorited: bool,
    pub archived_at: Option<OffsetDateTime>,
    pub last_opened_at: Option<OffsetDateTime>,
    pub read_completed_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: Uuid,
    pub owner_user_id: Option<Uuid>,
    pub scope: TagScope,
    pub slug: String,
    pub label: String,
    pub description: Option<String>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedContentTag {
    pub saved_content_id: Uuid,
    pub tag_id: Uuid,
    pub created_at: OffsetDateTime,
}

pub fn normalize_tag_slug(input: &str) -> ApiResult<String> {
    let mut slug = String::with_capacity(input.len());
    let mut previous_was_separator = false;

    for character in input.trim().chars() {
        let normalized = character.to_ascii_lowercase();

        if normalized.is_ascii_alphanumeric() {
            slug.push(normalized);
            previous_was_separator = false;
            continue;
        }

        if matches!(normalized, ' ' | '-' | '_') && !previous_was_separator && !slug.is_empty() {
            slug.push('-');
            previous_was_separator = true;
        }
    }

    while slug.ends_with('-') {
        slug.pop();
    }

    if slug.is_empty() {
        return Err(ApiError::bad_request("tag must contain letters or numbers"));
    }

    if slug.len() > 63 {
        return Err(ApiError::bad_request(
            "tag slug must be at most 63 characters",
        ));
    }

    Ok(slug)
}

#[cfg(test)]
mod tests {
    use super::{
        NormalizedUrl, ProcessingStatus, ReadState, SEEDED_SYSTEM_TAGS, SourceKind, TagScope,
        normalize_tag_slug,
    };
    use std::str::FromStr;

    #[test]
    fn adds_https_scheme_when_missing() {
        let normalized =
            NormalizedUrl::parse("Example.com/articles?id=1").expect("url should parse");
        assert_eq!(normalized.host, "example.com");
        assert_eq!(
            normalized.canonical_url,
            "https://example.com/articles?id=1"
        );
    }

    #[test]
    fn strips_fragments_and_tracking_query_params() {
        let normalized = NormalizedUrl::parse(
            "https://example.com/path?utm_source=newsletter&id=42&fbclid=test#section",
        )
        .expect("url should parse");

        assert_eq!(normalized.canonical_url, "https://example.com/path?id=42");
    }

    #[test]
    fn trims_default_ports() {
        let normalized =
            NormalizedUrl::parse("https://example.com:443/posts").expect("url should parse");

        assert_eq!(normalized.canonical_url, "https://example.com/posts");
    }

    #[test]
    fn rejects_non_http_urls() {
        assert!(NormalizedUrl::parse("mailto:test@example.com").is_err());
    }

    #[test]
    fn rejects_userinfo_urls() {
        assert!(NormalizedUrl::parse("https://user:pass@example.com/posts").is_err());
    }

    #[test]
    fn rejects_non_default_ports() {
        assert!(NormalizedUrl::parse("https://example.com:444/posts").is_err());
    }

    #[test]
    fn normalizes_tag_slugs() {
        assert_eq!(
            normalize_tag_slug("  Machine Learning / AI  ").expect("tag should normalize"),
            "machine-learning-ai"
        );
    }

    #[test]
    fn exposes_seeded_system_tags() {
        assert_eq!(SEEDED_SYSTEM_TAGS.len(), 9);
        assert!(SEEDED_SYSTEM_TAGS.contains(&"technology"));
    }

    #[test]
    fn parses_read_state_values() {
        assert_eq!(ReadState::from_str("reading").unwrap().as_str(), "reading");
    }

    #[test]
    fn parses_processing_status_values() {
        assert_eq!(
            ProcessingStatus::from_str("in_progress").unwrap().as_str(),
            "in_progress"
        );
    }

    #[test]
    fn parses_tag_scope_values() {
        assert_eq!(TagScope::from_str("custom").unwrap().as_str(), "custom");
    }

    #[test]
    fn parses_source_kind_values() {
        assert_eq!(SourceKind::from_str("thread").unwrap().as_str(), "thread");
    }
}
