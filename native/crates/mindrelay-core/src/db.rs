use std::path::PathBuf;

use directories::ProjectDirs;
use rusqlite::{Connection, Result, params};

use crate::models::Transcript;

pub struct Database {
    conn: Connection,
}

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
            CREATE INDEX IF NOT EXISTS idx_transcripts_source ON transcripts(source);
            CREATE INDEX IF NOT EXISTS idx_transcripts_url ON transcripts(url);",
        )
    }

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
        Ok(())
    }

    pub fn get_all(&self) -> Result<Vec<Transcript>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, source, title, url, timestamp, messages, markdown
             FROM transcripts ORDER BY timestamp DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let messages_json: String = row.get(5)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                messages_json,
                row.get::<_, String>(6)?,
            ))
        })?;

        let mut transcripts = Vec::new();
        for row in rows {
            let (id, source, title, url, timestamp, messages_json, markdown) = row?;
            let messages = serde_json::from_str(&messages_json).unwrap_or_default();
            transcripts.push(Transcript { id, source, title, url, timestamp, messages, markdown });
        }
        Ok(transcripts)
    }

    pub fn get_by_id(&self, id: &str) -> Result<Option<Transcript>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, source, title, url, timestamp, messages, markdown
             FROM transcripts WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |row| {
            let messages_json: String = row.get(5)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                messages_json,
                row.get::<_, String>(6)?,
            ))
        })?;

        if let Some(row) = rows.next() {
            let (id, source, title, url, timestamp, messages_json, markdown) = row?;
            let messages = serde_json::from_str(&messages_json).unwrap_or_default();
            return Ok(Some(Transcript { id, source, title, url, timestamp, messages, markdown }));
        }
        Ok(None)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM transcripts WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn delete_by_source(&self, source: &str) -> Result<()> {
        self.conn.execute("DELETE FROM transcripts WHERE source = ?1", params![source])?;
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        self.conn.execute("DELETE FROM transcripts", [])?;
        Ok(())
    }

    pub fn find_by_url(&self, url: &str) -> Result<Option<Transcript>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, source, title, url, timestamp, messages, markdown
             FROM transcripts WHERE url = ?1 ORDER BY timestamp DESC LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![url], |row| {
            let messages_json: String = row.get(5)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                messages_json,
                row.get::<_, String>(6)?,
            ))
        })?;

        if let Some(row) = rows.next() {
            let (id, source, title, url, timestamp, messages_json, markdown) = row?;
            let messages = serde_json::from_str(&messages_json).unwrap_or_default();
            return Ok(Some(Transcript { id, source, title, url, timestamp, messages, markdown }));
        }
        Ok(None)
    }
}

pub fn default_db_path() -> PathBuf {
    // Use empty qualifier/org so macOS resolves to ~/Library/Application Support/MindRelay
    // instead of ~/Library/Application Support/com.mindrelay.MindRelay
    ProjectDirs::from("", "", "MindRelay")
        .map(|d| d.data_local_dir().join("memory.db"))
        .unwrap_or_else(|| PathBuf::from("memory.db"))
}

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
}
