use std::str::FromStr;

use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;

use crate::{
    content::{ProcessingStatus, ReadState, SourceKind, TagScope},
    error::{ApiError, ApiResult},
};

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct CompactContentBody {
    pub kind: SourceKind,
    pub blocks: Vec<CompactContentBlock>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(tag = "t")]
pub enum CompactContentBlock {
    #[serde(rename = "h")]
    Heading {
        #[serde(rename = "l")]
        level: u8,
        #[serde(rename = "x")]
        text: String,
    },
    #[serde(rename = "p")]
    Paragraph {
        #[serde(rename = "x")]
        text: String,
    },
    #[serde(rename = "q")]
    Quote {
        #[serde(rename = "x")]
        text: String,
    },
    #[serde(rename = "l")]
    List {
        #[serde(rename = "o")]
        ordered: bool,
        #[serde(rename = "i")]
        items: Vec<String>,
    },
    #[serde(rename = "c")]
    Code {
        #[serde(rename = "lang", skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        #[serde(rename = "x")]
        text: String,
    },
}

pub fn parse_db_read_state(value: &str) -> ApiResult<ReadState> {
    ReadState::from_str(value).map_err(|_| ApiError::internal("Stored read state was invalid"))
}

pub fn parse_db_processing_status(value: &str) -> ApiResult<ProcessingStatus> {
    ProcessingStatus::from_str(value)
        .map_err(|_| ApiError::internal("Stored processing status was invalid"))
}

pub fn parse_db_tag_scope(value: &str) -> ApiResult<TagScope> {
    TagScope::from_str(value).map_err(|_| ApiError::internal("Stored tag scope was invalid"))
}

pub fn parse_optional_source_kind(value: Option<&str>) -> ApiResult<Option<SourceKind>> {
    value
        .map(SourceKind::from_str)
        .transpose()
        .map_err(|_| ApiError::internal("Stored source kind was invalid"))
}

pub fn timestamp_seconds(value: OffsetDateTime) -> i64 {
    value.unix_timestamp()
}

pub fn maybe_timestamp_seconds(value: Option<OffsetDateTime>) -> Option<i64> {
    value.map(timestamp_seconds)
}

pub fn build_compact_content_body(
    parsed_document: &Value,
    fallback_source_kind: Option<SourceKind>,
) -> Option<CompactContentBody> {
    let blocks = parsed_document.get("blocks")?.as_array()?;
    let mut compact_blocks = Vec::new();
    for block in blocks {
        append_compact_content_blocks(block, &mut compact_blocks);
    }

    if compact_blocks.is_empty() {
        return None;
    }

    let kind = parsed_document
        .get("kind")
        .and_then(Value::as_str)
        .and_then(parse_compact_body_kind)
        .or_else(|| fallback_source_kind.filter(|kind| is_compact_body_kind(*kind)))
        .unwrap_or(SourceKind::Article);

    Some(CompactContentBody {
        kind,
        blocks: compact_blocks,
    })
}

fn append_compact_content_blocks(value: &Value, out: &mut Vec<CompactContentBlock>) {
    let Some(block) = value.as_object() else {
        return;
    };

    let Some(block_type) = json_string(block, "type") else {
        return;
    };

    match block_type {
        "heading" => {
            let Some(text) = json_string(block, "text")
                .map(str::trim)
                .filter(|text| !text.is_empty())
            else {
                return;
            };
            let level = block
                .get("level")
                .and_then(Value::as_u64)
                .map(|value| value.clamp(1, 6) as u8)
                .unwrap_or(2);

            out.push(CompactContentBlock::Heading {
                level,
                text: text.to_string(),
            });
        }
        "paragraph" => {
            let Some(text) = json_string(block, "text")
                .map(str::trim)
                .filter(|text| !text.is_empty())
            else {
                return;
            };
            out.push(CompactContentBlock::Paragraph {
                text: text.to_string(),
            });
        }
        "quote" => {
            let Some(text) = json_string(block, "text")
                .map(str::trim)
                .filter(|text| !text.is_empty())
            else {
                return;
            };
            out.push(CompactContentBlock::Quote {
                text: text.to_string(),
            });
        }
        "list" => {
            let items = block
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>();
            if items.is_empty() {
                return;
            }

            out.push(CompactContentBlock::List {
                ordered: json_string(block, "style") == Some("numbered"),
                items,
            });
        }
        "code" => {
            let Some(text) = json_string(block, "text")
                .map(str::trim)
                .filter(|text| !text.is_empty())
            else {
                return;
            };
            out.push(CompactContentBlock::Code {
                language: json_string(block, "language")
                    .map(str::trim)
                    .filter(|language| !language.is_empty())
                    .map(str::to_string),
                text: text.to_string(),
            });
        }
        "thread_post" => append_thread_post_blocks(block, out),
        _ => {}
    }
}

fn append_thread_post_blocks(block: &serde_json::Map<String, Value>, out: &mut Vec<CompactContentBlock>) {
    if let Some(heading) = build_thread_post_heading(block) {
        out.push(CompactContentBlock::Heading {
            level: 3,
            text: heading,
        });
    }

    let Some(text) = json_string(block, "text")
        .map(str::trim)
        .filter(|text| !text.is_empty())
    else {
        return;
    };

    out.push(CompactContentBlock::Paragraph {
        text: text.to_string(),
    });
}

fn build_thread_post_heading(block: &serde_json::Map<String, Value>) -> Option<String> {
    let display_name = json_string(block, "display_name")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let author_handle = json_string(block, "author_handle")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_start_matches('@'));

    match (display_name, author_handle) {
        (Some(display_name), Some(author_handle))
            if display_name
                .trim_start_matches('@')
                .eq_ignore_ascii_case(author_handle) =>
        {
            Some(display_name.to_string())
        }
        (Some(display_name), Some(author_handle)) => {
            Some(format!("{display_name} (@{author_handle})"))
        }
        (Some(display_name), None) => Some(display_name.to_string()),
        (None, Some(author_handle)) => Some(format!("@{author_handle}")),
        (None, None) => None,
    }
}

fn parse_compact_body_kind(value: &str) -> Option<SourceKind> {
    match value {
        "article" => Some(SourceKind::Article),
        "thread" => Some(SourceKind::Thread),
        "post" => Some(SourceKind::Post),
        _ => None,
    }
}

fn is_compact_body_kind(kind: SourceKind) -> bool {
    matches!(
        kind,
        SourceKind::Article | SourceKind::Thread | SourceKind::Post
    )
}

fn json_string<'a>(value: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}
