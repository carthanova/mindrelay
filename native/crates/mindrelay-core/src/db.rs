use std::path::PathBuf;

use directories::ProjectDirs;
use rusqlite::{Connection, Result, params};

use crate::models::Transcript;

// ─── Search result ────────────────────────────────────────────────────────────

/// A transcript returned by a full-text search, together with its BM25 score.
/// Higher score = more relevant.
pub struct SearchResult {
    pub transcript: Transcript,
    /// BM25 relevance score (positive; higher = more relevant).
    pub score: f64,
}

pub struct Database {
    conn: Connection,
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

/// Map a SELECT row (`id, source, title, url, timestamp, messages, markdown`)
/// to a `Transcript`. Shared by all query methods.
fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Transcript> {
    let messages_json: String = row.get(5)?;
    let messages = serde_json::from_str(&messages_json).unwrap_or_default();
    Ok(Transcript {
        id: row.get(0)?,
        source: row.get(1)?,
        title: row.get(2)?,
        url: row.get(3)?,
        timestamp: row.get(4)?,
        messages,
        markdown: row.get(6)?,
    })
}

const SELECT_FIELDS: &str =
    "SELECT id, source, title, url, timestamp, messages, markdown FROM transcripts";

// ─── Database ─────────────────────────────────────────────────────────────────

impl Database {
    pub fn open_default() -> Result<Self> {
        let path = default_db_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        Self::open(&path)
    }

    pub fn open(path: &PathBuf) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    /// In-memory database for testing.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS transcripts (
                id         TEXT PRIMARY KEY,
                source     TEXT NOT NULL,
                title      TEXT NOT NULL,
                url        TEXT NOT NULL DEFAULT '',
                timestamp  INTEGER NOT NULL,
                messages   TEXT NOT NULL,
                markdown   TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_transcripts_timestamp ON transcripts(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_transcripts_source    ON transcripts(source);
            CREATE INDEX IF NOT EXISTS idx_transcripts_url       ON transcripts(url);
            CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
                transcript_id UNINDEXED,
                title,
                messages_text,
                tokenize = 'unicode61'
            );
            INSERT INTO transcripts_fts(transcript_id, title, messages_text)
                SELECT id, title, ''
                FROM transcripts
                WHERE id NOT IN (SELECT transcript_id FROM transcripts_fts);",
        )
    }

    // ─── FTS helpers ──────────────────────────────────────────────────────────

    /// Execute a statement against an FTS5 virtual table, discarding any
    /// auxiliary rows the FTS5 engine may return (rusqlite's `execute` would
    /// otherwise return `ExecuteReturnedResults`).
    fn fts_exec<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<()> {
        let mut stmt = self.conn.prepare(sql)?;
        let mut rows = stmt.query(params)?;
        while rows.next()?.is_some() {} // drain FTS5 internal result rows
        Ok(())
    }

    /// Insert or replace a transcript's FTS entry (delete + insert).
    fn fts_upsert(&self, t: &Transcript) -> Result<()> {
        let messages_text: String = t.messages.iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        self.fts_exec("DELETE FROM transcripts_fts WHERE transcript_id = ?1", params![t.id])?;
        self.fts_exec(
            "INSERT INTO transcripts_fts(transcript_id, title, messages_text) VALUES (?1, ?2, ?3)",
            params![t.id, t.title, messages_text],
        )?;
        Ok(())
    }

    // ─── Writes ───────────────────────────────────────────────────────────────

    pub fn put(&self, t: &Transcript) -> Result<()> {
        let messages_json = serde_json::to_string(&t.messages).unwrap_or_default();
        self.conn.execute(
            "INSERT INTO transcripts (id, source, title, url, timestamp, messages, markdown, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s','now'))
             ON CONFLICT(id) DO UPDATE SET
               source = excluded.source,
               title = excluded.title,
               url = excluded.url,
               timestamp = excluded.timestamp,
               messages = excluded.messages,
               markdown = excluded.markdown,
               updated_at = excluded.updated_at",
            params![t.id, t.source, t.title, t.url, t.timestamp, messages_json, t.markdown],
        )?;
        self.fts_upsert(t)?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.fts_exec("DELETE FROM transcripts_fts WHERE transcript_id = ?1", params![id])?;
        self.conn.execute("DELETE FROM transcripts WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn delete_by_source(&self, source: &str) -> Result<()> {
        // Delete FTS entries first (while the transcripts rows still exist for the subquery)
        self.fts_exec(
            "DELETE FROM transcripts_fts WHERE transcript_id IN (SELECT id FROM transcripts WHERE source = ?1)",
            params![source],
        )?;
        self.conn.execute("DELETE FROM transcripts WHERE source = ?1", params![source])?;
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        self.fts_exec("DELETE FROM transcripts_fts", [])?;
        self.conn.execute("DELETE FROM transcripts", [])?;
        Ok(())
    }

    // ─── Read helpers ─────────────────────────────────────────────────────────

    /// Execute `sql` with `params` and collect all matching rows into a Vec.
    fn query_vec<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<Vec<Transcript>> {
        let mut stmt = self.conn.prepare(sql)?;
        let mut out = Vec::new();
        for row in stmt.query_map(params, map_row)? {
            out.push(row?);
        }
        Ok(out)
    }

    /// Execute `sql` with `params` and return the first matching row, if any.
    fn query_one<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<Option<Transcript>> {
        let mut stmt = self.conn.prepare(sql)?;
        for row in stmt.query_map(params, map_row)? {
            return Ok(Some(row?));
        }
        Ok(None)
    }

    // ─── Reads ────────────────────────────────────────────────────────────────

    /// All transcripts ordered by timestamp descending.
    pub fn get_all(&self) -> Result<Vec<Transcript>> {
        self.query_vec(
            &format!("{SELECT_FIELDS} ORDER BY timestamp DESC"),
            [],
        )
    }

    /// Most recent `limit` transcripts (capped at 1 000).
    pub fn get_recent(&self, limit: u32) -> Result<Vec<Transcript>> {
        let limit = limit.min(1_000) as i64;
        self.query_vec(
            &format!("{SELECT_FIELDS} ORDER BY timestamp DESC LIMIT ?1"),
            params![limit],
        )
    }

    /// All transcripts from `source`, ordered by timestamp descending.
    pub fn get_by_source(&self, source: &str) -> Result<Vec<Transcript>> {
        self.query_vec(
            &format!("{SELECT_FIELDS} WHERE source = ?1 ORDER BY timestamp DESC"),
            params![source],
        )
    }

    /// Transcripts whose timestamp falls in `[since_ms, until_ms]`, ordered by
    /// timestamp descending.
    pub fn get_by_date_range(&self, since_ms: i64, until_ms: i64) -> Result<Vec<Transcript>> {
        self.query_vec(
            &format!("{SELECT_FIELDS} WHERE timestamp >= ?1 AND timestamp <= ?2 ORDER BY timestamp DESC"),
            params![since_ms, until_ms],
        )
    }

    /// Single transcript by ID.
    pub fn get_by_id(&self, id: &str) -> Result<Option<Transcript>> {
        self.query_one(
            &format!("{SELECT_FIELDS} WHERE id = ?1"),
            params![id],
        )
    }

    /// Most recent transcript for a URL.
    pub fn find_by_url(&self, url: &str) -> Result<Option<Transcript>> {
        self.query_one(
            &format!("{SELECT_FIELDS} WHERE url = ?1 ORDER BY timestamp DESC LIMIT 1"),
            params![url],
        )
    }

    // ─── Full-text search ─────────────────────────────────────────────────────

    /// Search transcripts using FTS5 BM25 ranking.
    /// Returns up to `limit` results ordered by relevance descending.
    /// Returns an empty Vec (not an error) for empty or unsearchable queries.
    pub fn search_text(&self, query: &str, limit: u32) -> Result<Vec<SearchResult>> {
        let limit = limit.min(200) as i64;
        let sanitized = match sanitize_fts_query(query) {
            Some(q) => q,
            None => return Ok(Vec::new()),
        };
        let sql = format!(
            "SELECT t.id, t.source, t.title, t.url, t.timestamp, t.messages, t.markdown,
                    (-bm25(transcripts_fts)) as score
             FROM transcripts_fts
             JOIN transcripts t ON t.id = transcripts_fts.transcript_id
             WHERE transcripts_fts MATCH ?1
             ORDER BY score DESC
             LIMIT {limit}"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let mut out = Vec::new();
        for row in stmt.query_map(params![sanitized], |row| {
            let messages_json: String = row.get(5)?;
            let messages = serde_json::from_str(&messages_json).unwrap_or_default();
            let transcript = Transcript {
                id: row.get(0)?,
                source: row.get(1)?,
                title: row.get(2)?,
                url: row.get(3)?,
                timestamp: row.get(4)?,
                messages,
                markdown: row.get(6)?,
            };
            let score: f64 = row.get(7)?;
            Ok((transcript, score))
        })? {
            let (transcript, score) = row?;
            out.push(SearchResult { transcript, score });
        }
        Ok(out)
    }

    /// Rebuild the FTS index from scratch (useful after bulk imports).
    /// Returns the number of rows indexed.
    pub fn rebuild_fts_index(&self) -> Result<usize> {
        self.fts_exec("DELETE FROM transcripts_fts", [])?;
        let transcripts = self.get_all()?;
        let count = transcripts.len();
        for t in &transcripts {
            self.fts_upsert(t)?;
        }
        Ok(count)
    }
}

// ─── FTS query sanitizer ──────────────────────────────────────────────────────

/// Strip FTS5 operator characters and reserved keywords from a raw user query
/// so it can be passed safely to `MATCH`. Returns `None` if nothing remains.
fn sanitize_fts_query(raw: &str) -> Option<String> {
    // FTS5 reserved operator keywords — must be excluded as standalone tokens
    const FTS5_OPERATORS: &[&str] = &["AND", "OR", "NOT"];

    // Replace any char that is not alphanumeric, hyphen, or apostrophe with a space.
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '\'' || c == '-' { c } else { ' ' })
        .collect();

    let terms: Vec<&str> = cleaned
        .split_whitespace()
        .filter(|t| !FTS5_OPERATORS.contains(t))
        .collect();

    if terms.is_empty() { None } else { Some(terms.join(" ")) }
}

pub fn default_db_path() -> PathBuf {
    // Use empty qualifier/org so macOS resolves to ~/Library/Application Support/MindRelay
    // instead of ~/Library/Application Support/com.mindrelay.MindRelay
    ProjectDirs::from("", "", "MindRelay")
        .map(|d| d.data_local_dir().join("memory.db"))
        .unwrap_or_else(|| PathBuf::from("memory.db"))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Message;

    fn make_transcript(id: &str) -> Transcript {
        Transcript {
            id: id.to_string(),
            source: "claude".to_string(),
            title: "Test".to_string(),
            url: "https://claude.ai/chat/test".to_string(),
            timestamp: 1700000000,
            messages: vec![
                Message { role: "user".to_string(), content: "Hello".to_string() },
                Message { role: "assistant".to_string(), content: "Hi there".to_string() },
            ],
            markdown: "".to_string(),
        }
    }

    fn make_at(id: &str, source: &str, ts: i64) -> Transcript {
        let mut t = make_transcript(id);
        t.source = source.to_string();
        t.timestamp = ts;
        t
    }

    #[test]
    fn test_put_and_get_all() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_transcript("t1")).unwrap();
        db.put(&make_transcript("t2")).unwrap();
        let all = db.get_all().unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn test_put_is_upsert() {
        let db = Database::open_in_memory().unwrap();
        let mut t = make_transcript("t1");
        db.put(&t).unwrap();
        t.title = "Updated".to_string();
        db.put(&t).unwrap();
        let all = db.get_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "Updated");
    }

    #[test]
    fn test_delete() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_transcript("t1")).unwrap();
        db.delete("t1").unwrap();
        assert_eq!(db.get_all().unwrap().len(), 0);
    }

    #[test]
    fn test_delete_by_source() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_transcript("t1")).unwrap();
        let mut t2 = make_transcript("t2");
        t2.source = "chatgpt".to_string();
        db.put(&t2).unwrap();
        db.delete_by_source("claude").unwrap();
        let all = db.get_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].source, "chatgpt");
    }

    #[test]
    fn test_clear() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_transcript("t1")).unwrap();
        db.put(&make_transcript("t2")).unwrap();
        db.clear().unwrap();
        assert_eq!(db.get_all().unwrap().len(), 0);
    }

    #[test]
    fn test_find_by_url() {
        let db = Database::open_in_memory().unwrap();
        let t = make_transcript("t1");
        db.put(&t).unwrap();
        let found = db.find_by_url("https://claude.ai/chat/test").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().id, "t1");
    }

    #[test]
    fn test_get_by_id() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_transcript("t1")).unwrap();
        let found = db.get_by_id("t1").unwrap();
        assert!(found.is_some());
        let missing = db.get_by_id("nope").unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn test_get_recent_returns_at_most_limit() {
        let db = Database::open_in_memory().unwrap();
        for i in 0..10 {
            db.put(&make_at(&format!("t{i}"), "claude", 1_700_000_000 + i)).unwrap();
        }
        let recent = db.get_recent(3).unwrap();
        assert_eq!(recent.len(), 3);
        // Should be descending by timestamp
        assert!(recent[0].timestamp >= recent[1].timestamp);
    }

    #[test]
    fn test_get_recent_cap_at_1000() {
        let db = Database::open_in_memory().unwrap();
        // get_recent(9999) should not panic, just cap internally
        let result = db.get_recent(9999);
        assert!(result.is_ok());
    }

    #[test]
    fn test_get_by_source() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_at("c1", "claude", 1_700_000_001)).unwrap();
        db.put(&make_at("c2", "claude", 1_700_000_002)).unwrap();
        db.put(&make_at("g1", "chatgpt", 1_700_000_003)).unwrap();
        let claude = db.get_by_source("claude").unwrap();
        assert_eq!(claude.len(), 2);
        assert!(claude.iter().all(|t| t.source == "claude"));
        let gpt = db.get_by_source("chatgpt").unwrap();
        assert_eq!(gpt.len(), 1);
    }

    #[test]
    fn test_get_by_date_range() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_at("old", "claude", 1_000)).unwrap();
        db.put(&make_at("mid", "claude", 5_000)).unwrap();
        db.put(&make_at("new", "claude", 9_000)).unwrap();
        let range = db.get_by_date_range(2_000, 8_000).unwrap();
        assert_eq!(range.len(), 1);
        assert_eq!(range[0].id, "mid");
    }

    #[test]
    fn test_get_all_ordered_by_timestamp_desc() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_at("a", "claude", 1_000)).unwrap();
        db.put(&make_at("b", "claude", 3_000)).unwrap();
        db.put(&make_at("c", "claude", 2_000)).unwrap();
        let all = db.get_all().unwrap();
        assert_eq!(all[0].id, "b");
        assert_eq!(all[1].id, "c");
        assert_eq!(all[2].id, "a");
    }

    // ── FTS search tests ──────────────────────────────────────────────────────

    fn make_searchable(id: &str, title: &str, content: &str) -> Transcript {
        let mut t = make_transcript(id);
        t.title = title.to_string();
        t.messages = vec![
            Message { role: "user".to_string(), content: content.to_string() },
        ];
        t
    }

    #[test]
    fn test_search_finds_title_match() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_searchable("t1", "buffering spike yesterday", "some content")).unwrap();
        db.put(&make_searchable("t2", "unrelated topic", "different text")).unwrap();
        let results = db.search_text("buffering", 10).unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].transcript.id, "t1");
    }

    #[test]
    fn test_search_finds_message_content() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_searchable("t1", "some title", "memory leak in production")).unwrap();
        db.put(&make_searchable("t2", "another title", "unrelated discussion")).unwrap();
        let results = db.search_text("memory leak", 10).unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].transcript.id, "t1");
    }

    #[test]
    fn test_search_empty_query_returns_empty() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_searchable("t1", "title", "content")).unwrap();
        let results = db.search_text("", 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_operators_stripped_safely() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_searchable("t1", "hello world", "some content")).unwrap();
        // Raw FTS5 operators must not cause a parse error
        let results = db.search_text("hello AND OR NOT * ^ \"", 10).unwrap();
        // Just checking it doesn't panic or error
        let _ = results;
    }

    #[test]
    fn test_search_scores_higher_relevance_first() {
        let db = Database::open_in_memory().unwrap();
        // t1 mentions "crash" once; t2 mentions it many times — t2 should rank higher
        db.put(&make_searchable("t1", "crash once", "crash")).unwrap();
        db.put(&make_searchable("t2", "crash many times",
            "crash crash crash crash crash crash crash crash crash crash")).unwrap();
        let results = db.search_text("crash", 10).unwrap();
        assert!(results.len() >= 2);
        // Scores should be positive
        for r in &results { assert!(r.score > 0.0, "score must be positive"); }
        // t2 should rank higher (more occurrences = higher BM25)
        assert_eq!(results[0].transcript.id, "t2");
    }

    #[test]
    fn test_search_respects_limit() {
        let db = Database::open_in_memory().unwrap();
        for i in 0..10 {
            db.put(&make_searchable(&format!("t{i}"), "relevant title", "keyword content")).unwrap();
        }
        let results = db.search_text("keyword", 3).unwrap();
        assert_eq!(results.len(), 3);
    }

    #[test]
    fn test_fts_updated_on_delete() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_searchable("t1", "unique xyzzy term", "xyzzy")).unwrap();
        assert!(!db.search_text("xyzzy", 10).unwrap().is_empty());
        db.delete("t1").unwrap();
        assert!(db.search_text("xyzzy", 10).unwrap().is_empty());
    }

    #[test]
    fn test_fts_updated_on_clear() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_searchable("t1", "zorkblat title", "zorkblat")).unwrap();
        db.clear().unwrap();
        assert!(db.search_text("zorkblat", 10).unwrap().is_empty());
    }

    #[test]
    fn test_fts_updated_on_delete_by_source() {
        let db = Database::open_in_memory().unwrap();
        let mut t = make_searchable("t1", "grokterm title", "grokterm");
        t.source = "grok".to_string();
        db.put(&t).unwrap();
        assert!(!db.search_text("grokterm", 10).unwrap().is_empty());
        db.delete_by_source("grok").unwrap();
        assert!(db.search_text("grokterm", 10).unwrap().is_empty());
    }

    #[test]
    fn test_rebuild_fts_index_reindexes_all() {
        let db = Database::open_in_memory().unwrap();
        db.put(&make_searchable("t1", "rebuild test", "uniquetoken123")).unwrap();
        db.put(&make_searchable("t2", "another rebuild test", "uniquetoken123 extra")).unwrap();
        let count = db.rebuild_fts_index().unwrap();
        assert_eq!(count, 2);
        let results = db.search_text("uniquetoken123", 10).unwrap();
        assert_eq!(results.len(), 2);
    }
}
