use crate::models::{Message, Transcript};

// ─── Limits ───────────────────────────────────────────────────────────────────

pub const VALID_SOURCES: &[&str] = &["claude", "chatgpt", "gemini", "grok", "obsidian"];
const VALID_ROLES: &[&str] = &["user", "assistant"];

const MAX_ID_LEN: usize = 200;
const MAX_TITLE_LEN: usize = 500;
const MAX_URL_LEN: usize = 2048;
const MAX_MESSAGES: usize = 500;
const MAX_CONTENT_BYTES: usize = 100_000;   // 100 KB per message
const MAX_MARKDOWN_BYTES: usize = 1_048_576; // 1 MB

// ─── Error type ───────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct ValidationError(pub String);

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "validation error: {}", self.0)
    }
}

impl std::error::Error for ValidationError {}

// ─── Transcript validation ────────────────────────────────────────────────────

impl Transcript {
    /// Validate and normalize all fields in place.
    ///
    /// **Reject** (return Err) for structural problems: empty id, unknown source,
    /// invalid role, empty messages, out-of-range counts, zero/negative timestamp.
    ///
    /// **Normalize** (truncate or fill default) for size issues so callers never
    /// lose data over an arbitrary limit: title → "Untitled" if blank, long fields
    /// truncated to their ceiling, markdown silently trimmed.
    pub fn validate_and_normalize(&mut self) -> Result<(), ValidationError> {
        self.validate_id()?;
        self.validate_source()?;
        self.normalize_title();
        self.normalize_url();
        self.validate_timestamp()?;
        self.validate_messages()?;
        self.normalize_markdown();
        Ok(())
    }

    fn validate_id(&mut self) -> Result<(), ValidationError> {
        self.id = self.id.trim().to_string();
        if self.id.is_empty() {
            return Err(ValidationError("id is empty".into()));
        }
        if self.id.len() > MAX_ID_LEN {
            return Err(ValidationError(format!(
                "id length {} exceeds limit of {}",
                self.id.len(),
                MAX_ID_LEN
            )));
        }
        Ok(())
    }

    fn validate_source(&mut self) -> Result<(), ValidationError> {
        self.source = self.source.trim().to_lowercase();
        if !VALID_SOURCES.contains(&self.source.as_str()) {
            return Err(ValidationError(format!(
                "source '{}' must be one of: {}",
                self.source,
                VALID_SOURCES.join(", ")
            )));
        }
        Ok(())
    }

    fn normalize_title(&mut self) {
        self.title = self.title.trim().to_string();
        if self.title.is_empty() {
            self.title = "Untitled".to_string();
        } else if self.title.len() > MAX_TITLE_LEN {
            self.title = truncate_str(&self.title, MAX_TITLE_LEN).to_string();
        }
    }

    fn normalize_url(&mut self) {
        self.url = self.url.trim().to_string();
        if self.url.len() > MAX_URL_LEN {
            self.url = truncate_str(&self.url, MAX_URL_LEN).to_string();
        }
    }

    fn validate_timestamp(&self) -> Result<(), ValidationError> {
        if self.timestamp <= 0 {
            return Err(ValidationError(format!(
                "timestamp {} must be positive",
                self.timestamp
            )));
        }
        Ok(())
    }

    fn validate_messages(&mut self) -> Result<(), ValidationError> {
        if self.messages.is_empty() {
            return Err(ValidationError("messages array is empty".into()));
        }
        if self.messages.len() > MAX_MESSAGES {
            return Err(ValidationError(format!(
                "messages count {} exceeds limit of {}",
                self.messages.len(),
                MAX_MESSAGES
            )));
        }
        for (i, msg) in self.messages.iter_mut().enumerate() {
            normalize_message(msg, i)?;
        }
        Ok(())
    }

    fn normalize_markdown(&mut self) {
        if self.markdown.len() > MAX_MARKDOWN_BYTES {
            self.markdown = truncate_str(&self.markdown, MAX_MARKDOWN_BYTES).to_string();
        }
    }
}

fn normalize_message(msg: &mut Message, index: usize) -> Result<(), ValidationError> {
    msg.role = msg.role.trim().to_lowercase();
    if !VALID_ROLES.contains(&msg.role.as_str()) {
        return Err(ValidationError(format!(
            "message[{}].role '{}' must be 'user' or 'assistant'",
            index, msg.role
        )));
    }
    msg.content = msg.content.trim().to_string();
    if msg.content.is_empty() {
        return Err(ValidationError(format!(
            "message[{}].content is empty",
            index
        )));
    }
    if msg.content.len() > MAX_CONTENT_BYTES {
        let truncated = truncate_str(&msg.content, MAX_CONTENT_BYTES);
        msg.content = format!("{}…", truncated);
    }
    Ok(())
}

/// Truncate `s` to at most `max_bytes` bytes at a UTF-8 character boundary.
fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !s.is_char_boundary(boundary) {
        boundary -= 1;
    }
    &s[..boundary]
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make() -> Transcript {
        Transcript {
            id: "abc123".into(),
            source: "claude".into(),
            title: "Test conversation".into(),
            url: "https://claude.ai/chat/abc".into(),
            timestamp: 1_700_000_000,
            messages: vec![
                Message { role: "user".into(), content: "Hello".into() },
                Message { role: "assistant".into(), content: "Hi there".into() },
            ],
            markdown: String::new(),
        }
    }

    #[test]
    fn valid_transcript_passes() {
        assert!(make().validate_and_normalize().is_ok());
    }

    #[test]
    fn rejects_empty_id() {
        let mut t = make();
        t.id = String::new();
        assert!(t.validate_and_normalize().is_err());
    }

    #[test]
    fn rejects_whitespace_only_id() {
        let mut t = make();
        t.id = "   ".into();
        assert!(t.validate_and_normalize().is_err());
    }

    #[test]
    fn rejects_oversized_id() {
        let mut t = make();
        t.id = "a".repeat(MAX_ID_LEN + 1);
        assert!(t.validate_and_normalize().is_err());
    }

    #[test]
    fn rejects_unknown_source() {
        let mut t = make();
        t.source = "openai".into();
        assert!(t.validate_and_normalize().is_err());
    }

    #[test]
    fn normalizes_source_case() {
        let mut t = make();
        t.source = "Claude".into();
        t.validate_and_normalize().unwrap();
        assert_eq!(t.source, "claude");
    }

    #[test]
    fn empty_title_becomes_untitled() {
        let mut t = make();
        t.title = "   ".into();
        t.validate_and_normalize().unwrap();
        assert_eq!(t.title, "Untitled");
    }

    #[test]
    fn title_truncated_at_limit() {
        let mut t = make();
        t.title = "x".repeat(MAX_TITLE_LEN + 50);
        t.validate_and_normalize().unwrap();
        assert_eq!(t.title.len(), MAX_TITLE_LEN);
    }

    #[test]
    fn rejects_zero_timestamp() {
        let mut t = make();
        t.timestamp = 0;
        assert!(t.validate_and_normalize().is_err());
    }

    #[test]
    fn rejects_negative_timestamp() {
        let mut t = make();
        t.timestamp = -1;
        assert!(t.validate_and_normalize().is_err());
    }

    #[test]
    fn rejects_empty_messages() {
        let mut t = make();
        t.messages = vec![];
        assert!(t.validate_and_normalize().is_err());
    }

    #[test]
    fn rejects_too_many_messages() {
        let mut t = make();
        t.messages = (0..=MAX_MESSAGES)
            .map(|i| Message {
                role: if i % 2 == 0 { "user".into() } else { "assistant".into() },
                content: "x".into(),
            })
            .collect();
        assert!(t.validate_and_normalize().is_err());
    }

    #[test]
    fn rejects_invalid_role() {
        let mut t = make();
        t.messages[0].role = "system".into();
        assert!(t.validate_and_normalize().is_err());
    }

    #[test]
    fn normalizes_role_case() {
        let mut t = make();
        t.messages[0].role = "User".into();
        t.validate_and_normalize().unwrap();
        assert_eq!(t.messages[0].role, "user");
    }

    #[test]
    fn rejects_empty_message_content() {
        let mut t = make();
        t.messages[0].content = "   ".into();
        assert!(t.validate_and_normalize().is_err());
    }

    #[test]
    fn truncates_oversized_content() {
        let mut t = make();
        t.messages[0].content = "a".repeat(MAX_CONTENT_BYTES + 10_000);
        t.validate_and_normalize().unwrap();
        // content is truncated + "…" (3 bytes) so must be ≤ ceiling + 3
        assert!(t.messages[0].content.len() <= MAX_CONTENT_BYTES + 3);
    }

    #[test]
    fn truncates_oversized_markdown() {
        let mut t = make();
        t.markdown = "m".repeat(MAX_MARKDOWN_BYTES + 1);
        t.validate_and_normalize().unwrap();
        assert!(t.markdown.len() <= MAX_MARKDOWN_BYTES);
    }

    #[test]
    fn trims_whitespace_from_string_fields() {
        let mut t = make();
        t.id = "  abc123  ".into();
        t.title = "  Test  ".into();
        t.url = "  https://claude.ai/chat/abc  ".into();
        t.messages[0].content = "  Hello  ".into();
        t.validate_and_normalize().unwrap();
        assert_eq!(t.id, "abc123");
        assert_eq!(t.title, "Test");
        assert_eq!(t.url, "https://claude.ai/chat/abc");
        assert_eq!(t.messages[0].content, "Hello");
    }
}
