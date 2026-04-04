use crate::{
    content::SourceKind,
    embedded_content::{CompactContentBlock, CompactContentBody},
    error::{ApiError, ApiResult},
};

pub const CONTENT_TYPE: &str = "application/vnd.motif.reader-package";
pub const MAGIC: [u8; 4] = *b"MTRP";
pub const VERSION: u16 = 1;
pub const MAX_TOKEN_BYTES: usize = 32;
pub const MAX_PREVIEW_BYTES: usize = 64;
pub const HEADER_LEN: usize = 32;
pub const PARAGRAPH_ENTRY_LEN: usize = 72;
pub const UNIT_ENTRY_LEN: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StageFont {
    Large,
    Medium,
    Small,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct UnitFlags {
    clause_pause: bool,
    sentence_pause: bool,
    paragraph_start: bool,
    paragraph_end: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PackageParagraph {
    start_unit_index: u32,
    preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PackageUnit {
    paragraph_index: u16,
    anchor_index: u8,
    char_count: u8,
    font: StageFont,
    flags: UnitFlags,
    display: String,
}

pub fn build_bytes(
    title: Option<&str>,
    body: &CompactContentBody,
    revision: u64,
) -> ApiResult<Vec<u8>> {
    let title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("UNTITLED ARTICLE");
    let paragraphs = normalize_paragraphs(body);
    if paragraphs.is_empty() {
        return Err(ApiError::conflict("Content package is not ready"));
    }

    let (paragraphs, units) = build_reader_model(&paragraphs)?;
    if units.is_empty() || paragraphs.is_empty() {
        return Err(ApiError::conflict("Content package is not ready"));
    }

    let title_bytes = truncate_utf8(title, u16::MAX as usize);
    let paragraph_table_offset = HEADER_LEN as u32 + title_bytes.len() as u32;
    let unit_table_offset =
        paragraph_table_offset + (paragraphs.len() * PARAGRAPH_ENTRY_LEN) as u32;

    let mut out = Vec::with_capacity(
        HEADER_LEN
            + title_bytes.len()
            + (paragraphs.len() * PARAGRAPH_ENTRY_LEN)
            + (units.len() * UNIT_ENTRY_LEN),
    );
    out.resize(HEADER_LEN, 0);
    out.extend_from_slice(title_bytes.as_bytes());

    for paragraph in &paragraphs {
        encode_paragraph(paragraph, &mut out);
    }

    for unit in &units {
        encode_unit(unit, &mut out);
    }

    out[0..4].copy_from_slice(&MAGIC);
    write_u16(&mut out, 4, VERSION);
    write_u16(&mut out, 6, 0);
    write_u16(&mut out, 8, title_bytes.len() as u16);
    write_u16(
        &mut out,
        10,
        u16::try_from(paragraphs.len()).map_err(|_| ApiError::conflict("Article is too long"))?,
    );
    write_u32(
        &mut out,
        12,
        u32::try_from(units.len()).map_err(|_| ApiError::conflict("Article is too long"))?,
    );
    write_u32(&mut out, 16, paragraph_table_offset);
    write_u32(&mut out, 20, unit_table_offset);
    write_u64(&mut out, 24, revision);

    Ok(out)
}

fn normalize_paragraphs(body: &CompactContentBody) -> Vec<String> {
    let mut paragraphs = Vec::new();

    for block in &body.blocks {
        match block {
            CompactContentBlock::Heading { text, .. }
            | CompactContentBlock::Paragraph { text }
            | CompactContentBlock::Quote { text }
            | CompactContentBlock::Code { text, .. } => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    paragraphs.push(trimmed.to_string());
                }
            }
            CompactContentBlock::List { ordered, items } => {
                for (index, item) in items.iter().enumerate() {
                    let trimmed = item.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    paragraphs.push(format_list_line(trimmed, *ordered, index));
                }
            }
        }
    }

    if paragraphs.is_empty()
        && matches!(
            body.kind,
            SourceKind::Article | SourceKind::Thread | SourceKind::Post
        )
    {
        paragraphs.push("READY".to_string());
    }

    paragraphs
}

fn build_reader_model(
    paragraphs: &[String],
) -> ApiResult<(Vec<PackageParagraph>, Vec<PackageUnit>)> {
    let mut paragraph_entries = Vec::with_capacity(paragraphs.len());
    let mut units = Vec::new();

    for (paragraph_offset, paragraph) in paragraphs.iter().enumerate() {
        let paragraph_index = u16::try_from(paragraph_offset + 1)
            .map_err(|_| ApiError::conflict("Article has too many paragraphs"))?;
        let start_unit_index =
            u32::try_from(units.len()).map_err(|_| ApiError::conflict("Article is too long"))?;
        paragraph_entries.push(PackageParagraph {
            start_unit_index,
            preview: preview_excerpt(paragraph),
        });

        let mut index = 0usize;
        let mut first_unit = true;

        while let Some((start, end)) = next_chunk_bounds(paragraph, index) {
            index = end;
            let chunk = &paragraph[start..end];

            if !contains_word_content(chunk) {
                attach_standalone_punctuation(&mut units, chunk);
                continue;
            }

            push_chunk(&mut units, paragraph_index, chunk, first_unit);
            first_unit = false;
        }

        if let Some(last) = units.last_mut() {
            last.flags.paragraph_end = true;
        }
    }

    Ok((paragraph_entries, units))
}

fn push_chunk(
    units: &mut Vec<PackageUnit>,
    paragraph_index: u16,
    chunk: &str,
    paragraph_start: bool,
) {
    let segments = split_for_stage(chunk);
    let segment_count = segments.len();

    for (segment_index, segment) in segments.into_iter().enumerate() {
        if segment.is_empty() {
            continue;
        }

        let display = truncate_utf8(segment, MAX_TOKEN_BYTES);
        let char_count = display.chars().count().min(u8::MAX as usize) as u8;
        let core = lexical_core(segment);
        let leading_chars = segment[..core.start].chars().count() as u8;
        let core_chars = core.text.chars().count();
        let anchor = leading_chars
            .saturating_add(preferred_anchor(core_chars) as u8)
            .min(char_count.saturating_sub(1));
        let mut flags = if segment_index + 1 == segment_count {
            classify_trailing_punctuation(segment, looks_like_abbreviation(segment))
        } else {
            UnitFlags::default()
        };

        if paragraph_start && segment_index == 0 {
            flags.paragraph_start = true;
        }

        units.push(PackageUnit {
            paragraph_index,
            anchor_index: anchor,
            char_count,
            font: font_for_token(char_count as usize),
            flags,
            display,
        });
    }
}

fn attach_standalone_punctuation(units: &mut [PackageUnit], chunk: &str) {
    let Some(last) = units.last_mut() else {
        return;
    };

    let flags = classify_trailing_punctuation(chunk, false);
    last.flags.clause_pause |= flags.clause_pause;
    last.flags.sentence_pause |= flags.sentence_pause;
}

fn preview_excerpt(paragraph: &str) -> String {
    let mut preview = String::new();
    let mut last_was_space = false;

    for ch in paragraph.chars() {
        if ch.is_whitespace() {
            if !last_was_space && !preview.is_empty() {
                if !try_push_char(&mut preview, ' ', MAX_PREVIEW_BYTES) {
                    break;
                }
            }
            last_was_space = true;
            continue;
        }

        last_was_space = false;
        if !try_push_char(&mut preview, ch, MAX_PREVIEW_BYTES) {
            break;
        }
    }

    preview
}

fn next_chunk_bounds(text: &str, start: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut head = start;

    while head < bytes.len() && bytes[head].is_ascii_whitespace() {
        head += 1;
    }

    if head >= bytes.len() {
        return None;
    }

    let mut tail = head;
    while tail < bytes.len() && !bytes[tail].is_ascii_whitespace() {
        tail += 1;
    }

    Some((head, tail))
}

fn split_for_stage(chunk: &str) -> Vec<&str> {
    if chunk.chars().count() <= 24 {
        return vec![chunk];
    }

    if let Some(split_byte) = hyphen_split_index(chunk) {
        return vec![&chunk[..split_byte], &chunk[split_byte..]];
    }

    vec![chunk]
}

fn hyphen_split_index(chunk: &str) -> Option<usize> {
    let midpoint = chunk.chars().count() / 2;
    let mut best_before = None;
    let mut best_after = None;

    for (char_index, (byte_index, ch)) in chunk.char_indices().enumerate() {
        if ch == '-' {
            if char_index <= midpoint {
                best_before = Some(byte_index + ch.len_utf8());
            } else if best_after.is_none() {
                best_after = Some(byte_index + ch.len_utf8());
            }
        }
    }

    best_before.or(best_after)
}

#[derive(Debug, Clone, Copy)]
struct CoreBounds<'a> {
    start: usize,
    text: &'a str,
}

fn lexical_core(chunk: &str) -> CoreBounds<'_> {
    let mut start = chunk.len();
    let mut end = 0usize;

    for (byte_index, ch) in chunk.char_indices() {
        if ch.is_alphanumeric() {
            if start == chunk.len() {
                start = byte_index;
            }
            end = byte_index + ch.len_utf8();
        }
    }

    if start == chunk.len() {
        return CoreBounds {
            start: 0,
            text: chunk,
        };
    }

    CoreBounds {
        start,
        text: &chunk[start..end],
    }
}

fn contains_word_content(chunk: &str) -> bool {
    chunk.chars().any(|ch| ch.is_alphanumeric())
}

fn classify_trailing_punctuation(chunk: &str, abbreviation: bool) -> UnitFlags {
    let mut flags = UnitFlags::default();
    let core = lexical_core(chunk);
    let trailing = &chunk[core.start + core.text.len()..];

    if trailing.contains(['!', '?']) {
        flags.sentence_pause = true;
        return flags;
    }

    if trailing.contains('.') && !abbreviation {
        flags.sentence_pause = true;
        return flags;
    }

    if trailing.contains([',', ';', ':', '—']) {
        flags.clause_pause = true;
    }

    flags
}

fn looks_like_abbreviation(chunk: &str) -> bool {
    let trimmed = lexical_core(chunk).text;
    let mut period_count = 0usize;
    let mut letter_count = 0usize;

    for ch in trimmed.chars() {
        if ch == '.' {
            period_count += 1;
        } else if ch.is_ascii_alphabetic() {
            letter_count += 1;
        } else {
            return false;
        }
    }

    period_count > 0 && letter_count > period_count
}

fn preferred_anchor(core_chars: usize) -> usize {
    match core_chars {
        0..=1 => 0,
        2..=5 => 1,
        6..=9 => 2,
        10..=13 => 3,
        _ => 4,
    }
}

fn font_for_token(char_count: usize) -> StageFont {
    match char_count {
        0..=11 => StageFont::Large,
        12..=17 => StageFont::Medium,
        _ => StageFont::Small,
    }
}

fn format_list_line(item: &str, ordered: bool, index: usize) -> String {
    if ordered {
        format!("{}. {}", index + 1, item)
    } else {
        format!("- {}", item)
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if !try_push_char(&mut out, ch, max_bytes) {
            break;
        }
    }
    out
}

fn try_push_char(target: &mut String, ch: char, max_bytes: usize) -> bool {
    let len = ch.len_utf8();
    if target.len().saturating_add(len) > max_bytes {
        return false;
    }
    target.push(ch);
    true
}

fn encode_paragraph(paragraph: &PackageParagraph, out: &mut Vec<u8>) {
    let start = out.len();
    out.resize(start + PARAGRAPH_ENTRY_LEN, 0);
    write_u32(out, start, paragraph.start_unit_index);
    out[start + 4] = paragraph.preview.len().min(u8::MAX as usize) as u8;
    out[start + 8..start + 8 + paragraph.preview.len()]
        .copy_from_slice(paragraph.preview.as_bytes());
}

fn encode_unit(unit: &PackageUnit, out: &mut Vec<u8>) {
    let start = out.len();
    out.resize(start + UNIT_ENTRY_LEN, 0);
    write_u16(out, start, unit.paragraph_index);
    out[start + 2] = unit.anchor_index;
    out[start + 3] = unit.char_count;
    out[start + 4] = font_to_byte(unit.font);
    out[start + 5] = flags_to_byte(unit.flags);
    out[start + 6] = unit.display.len().min(u8::MAX as usize) as u8;
    out[start + 8..start + 8 + unit.display.len()].copy_from_slice(unit.display.as_bytes());
}

fn font_to_byte(font: StageFont) -> u8 {
    match font {
        StageFont::Large => 0,
        StageFont::Medium => 1,
        StageFont::Small => 2,
    }
}

fn flags_to_byte(flags: UnitFlags) -> u8 {
    (u8::from(flags.clause_pause))
        | (u8::from(flags.sentence_pause) << 1)
        | (u8::from(flags.paragraph_start) << 2)
        | (u8::from(flags.paragraph_end) << 3)
}

fn write_u16(buffer: &mut [u8], offset: usize, value: u16) {
    buffer[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32(buffer: &mut [u8], offset: usize, value: u32) {
    buffer[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u64(buffer: &mut [u8], offset: usize, value: u64) {
    buffer[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_binary_reader_package_from_compact_body() {
        let bytes = build_bytes(
            Some("Example article"),
            &CompactContentBody {
                kind: SourceKind::Article,
                blocks: vec![
                    CompactContentBlock::Paragraph {
                        text: "First paragraph for Motif.".to_string(),
                    },
                    CompactContentBlock::List {
                        ordered: true,
                        items: vec!["Alpha".to_string(), "Beta".to_string()],
                    },
                ],
            },
            42,
        )
        .expect("package should build");

        assert_eq!(&bytes[..4], b"MTRP");
        assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), VERSION);
        assert_eq!(
            u16::from_le_bytes([bytes[8], bytes[9]]),
            "Example article".len() as u16
        );
        assert_eq!(u16::from_le_bytes([bytes[10], bytes[11]]), 3);
        assert!(u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) >= 4);
    }
}
