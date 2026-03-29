mod logger;
mod protocol;

use std::collections::{HashMap, HashSet};
use std::io::{self, BufWriter};
use std::time::{Duration, Instant};

use mindrelay_core::{Database, Transcript, Vault, VALID_SOURCES};
use serde_json::{json, Value};

// ─── Session store (deduplication) ───────────────────────────────────────────

const SESSION_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60); // 2 hours

struct SessionState {
    seen: HashSet<String>,
    last_active: Instant,
}

struct SessionStore {
    sessions: HashMap<String, SessionState>,
}

impl SessionStore {
    fn new() -> Self {
        Self { sessions: HashMap::new() }
    }

    /// Evict sessions that have been idle longer than SESSION_TIMEOUT.
    fn gc(&mut self) {
        self.sessions.retain(|_, s| s.last_active.elapsed() < SESSION_TIMEOUT);
    }

    fn is_seen(&self, session_id: &str, id: &str) -> bool {
        self.sessions.get(session_id).map_or(false, |s| s.seen.contains(id))
    }

    fn mark_seen(&mut self, session_id: &str, ids: &[String]) {
        let state = self.sessions.entry(session_id.to_string()).or_insert_with(|| SessionState {
            seen: HashSet::new(),
            last_active: Instant::now(),
        });
        state.last_active = Instant::now();
        for id in ids {
            state.seen.insert(id.clone());
        }
    }

    fn end(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }
}

/// Maximum serialized bytes per CHUNK_DATA message body.
/// This is the size of the `data` array, not the full message envelope.
/// Chrome's hard limit is 1 MB per native message; 200 KB gives plenty of
/// room for the JSON wrapper fields and any field-level escaping.
const CHUNK_DATA_BYTES: usize = 200_000;

// ─── Chunking helper ──────────────────────────────────────────────────────────

/// Bin-pack `transcripts` into batches that each serialize to at most
/// `CHUNK_DATA_BYTES` bytes. Always returns at least one batch (may be empty).
fn chunk_transcripts(transcripts: Vec<Transcript>) -> Vec<Vec<Transcript>> {
    let mut batches: Vec<Vec<Transcript>> = Vec::new();
    let mut current: Vec<Transcript> = Vec::new();
    let mut current_size: usize = 2; // opening+closing `[]`

    for t in transcripts {
        let item_bytes = serde_json::to_vec(&t).unwrap_or_default();
        let item_size = item_bytes.len() + 1; // +1 for comma separator
        if !current.is_empty() && current_size + item_size > CHUNK_DATA_BYTES {
            batches.push(current);
            current = Vec::new();
            current_size = 2;
        }
        current_size += item_size;
        current.push(t);
    }
    if !current.is_empty() {
        batches.push(current);
    }
    if batches.is_empty() {
        batches.push(Vec::new()); // always emit at least one CHUNK_DATA
    }
    batches
}

// ─── Chunked response helper ──────────────────────────────────────────────────

/// Build the CHUNK_START / CHUNK_DATA… / CHUNK_END message sequence for any
/// query that returns a list of transcripts.
fn chunk_response(rid: &str, transcripts: Vec<mindrelay_core::Transcript>) -> Vec<Value> {
    let batches = chunk_transcripts(transcripts);
    let total = batches.len();
    let mut messages: Vec<Value> = Vec::with_capacity(total + 2);
    messages.push(json!({
        "type": "CHUNK_START",
        "requestId": rid,
        "version": 1,
        "totalChunks": total
    }));
    for (i, batch) in batches.into_iter().enumerate() {
        messages.push(json!({
            "type": "CHUNK_DATA",
            "requestId": rid,
            "version": 1,
            "chunkIndex": i,
            "data": batch
        }));
    }
    messages.push(json!({
        "type": "CHUNK_END",
        "requestId": rid,
        "version": 1,
        "ok": true
    }));
    messages
}

// ─── App launcher ─────────────────────────────────────────────────────────────

/// Launch the MindRelay desktop app by bundle ID / process name.
/// Returns a JSON response suitable for sending back to the extension.
fn open_app() -> Value {
    #[cfg(target_os = "macos")]
    {
        match std::process::Command::new("open")
            .args(["-b", "com.mindrelay.app"])
            .spawn()
        {
            Ok(_) => json!({"ok": true}),
            Err(e) => json!({"ok": false, "error": format!("failed to open app: {e}")}),
        }
    }
    #[cfg(target_os = "windows")]
    {
        match std::process::Command::new("cmd")
            .args(["/c", "start", "", "MindRelay"])
            .spawn()
        {
            Ok(_) => json!({"ok": true}),
            Err(e) => json!({"ok": false, "error": format!("failed to open app: {e}")}),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        json!({"ok": false, "error": "OPEN_APP not supported on this platform"})
    }
}

// ─── Message dispatcher ───────────────────────────────────────────────────────

/// Top-level handler: validate the envelope, dispatch, then inject `requestId`
/// and `version` into every response that does not already carry those fields
/// (CHUNK_START / CHUNK_DATA / CHUNK_END pre-stamp them inside `dispatch`).
fn handle_message(
    db: &Database,
    vault: &Vault,
    logger: &logger::Logger,
    sessions: &mut SessionStore,
    msg: &Value,
) -> Vec<Value> {
    let request_id = msg.get("requestId").and_then(|v| v.as_str());
    let version = msg.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
    let msg_type = msg["type"].as_str().unwrap_or("unknown");

    if version == 0 {
        logger.warn(&format!("message '{msg_type}' missing version field"));
    }
    logger.info(&format!(
        "recv type={msg_type} requestId={}",
        request_id.unwrap_or("-")
    ));

    let responses = dispatch(db, vault, logger, sessions, msg);

    // Inject requestId + version into any response that doesn't already have them.
    // `entry().or_insert()` is idempotent — pre-stamped chunk messages are left alone.
    responses
        .into_iter()
        .map(|mut r| {
            if let Some(obj) = r.as_object_mut() {
                obj.entry("requestId")
                    .or_insert_with(|| json!(request_id.unwrap_or("")));
                obj.entry("version").or_insert(json!(1));
            }
            r
        })
        .collect()
}

fn dispatch(
    db: &Database,
    vault: &Vault,
    logger: &logger::Logger,
    sessions: &mut SessionStore,
    msg: &Value,
) -> Vec<Value> {
    match msg["type"].as_str().unwrap_or("") {
        "PING" => vec![json!({"ok": true, "pong": true})],

        "PUT" => {
            let raw = match msg.get("data") {
                Some(v) => v.clone(),
                None => return vec![json!({"ok": false, "error": "missing field: data"})],
            };
            let mut t: Transcript = match serde_json::from_value(raw) {
                Ok(v) => v,
                Err(e) => {
                    return vec![json!({"ok": false, "error": format!("malformed transcript: {e}")})]
                }
            };
            if let Err(e) = t.validate_and_normalize() {
                return vec![json!({"ok": false, "error": e.to_string()})];
            }
            if let Err(e) = db.put(&t) {
                return vec![json!({"ok": false, "error": e.to_string()})];
            }
            if let Err(e) = vault.put(&t) {
                logger.warn(&format!("vault write warning: {e}"));
            }
            vec![json!({"ok": true, "id": t.id})]
        }

        "GET_ALL" => {
            let rid = msg.get("requestId").and_then(|v| v.as_str()).unwrap_or("");
            match db.get_all() {
                Err(e) => vec![json!({"ok": false, "error": e.to_string()})],
                Ok(transcripts) => chunk_response(rid, transcripts),
            }
        }

        "GET_RECENT" => {
            let rid = msg.get("requestId").and_then(|v| v.as_str()).unwrap_or("");
            let limit = msg.get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(50)
                .min(1_000) as u32;
            match db.get_recent(limit) {
                Err(e) => vec![json!({"ok": false, "error": e.to_string()})],
                Ok(transcripts) => chunk_response(rid, transcripts),
            }
        }

        "GET_BY_SOURCE" => {
            let rid = msg.get("requestId").and_then(|v| v.as_str()).unwrap_or("");
            let source = match msg["source"].as_str() {
                Some(s) => s.trim().to_lowercase(),
                None => return vec![json!({"ok": false, "error": "missing field: source"})],
            };
            if !VALID_SOURCES.contains(&source.as_str()) {
                return vec![json!({"ok": false, "error": format!(
                    "source '{}' must be one of: {}", source, VALID_SOURCES.join(", ")
                )})];
            }
            match db.get_by_source(&source) {
                Err(e) => vec![json!({"ok": false, "error": e.to_string()})],
                Ok(transcripts) => chunk_response(rid, transcripts),
            }
        }

        "GET_BY_DATE_RANGE" => {
            let rid = msg.get("requestId").and_then(|v| v.as_str()).unwrap_or("");
            let since_ms = msg.get("sinceMs").and_then(|v| v.as_i64()).unwrap_or(0);
            let until_ms = msg.get("untilMs")
                .and_then(|v| v.as_i64())
                .unwrap_or(i64::MAX);
            if since_ms < 0 || until_ms < 0 {
                return vec![json!({"ok": false, "error": "sinceMs and untilMs must be non-negative"})];
            }
            if since_ms > until_ms {
                return vec![json!({"ok": false, "error": "sinceMs must be <= untilMs"})];
            }
            match db.get_by_date_range(since_ms, until_ms) {
                Err(e) => vec![json!({"ok": false, "error": e.to_string()})],
                Ok(transcripts) => chunk_response(rid, transcripts),
            }
        }

        "BACKUP_VAULT" => {
            // Auto-generate a timestamped backup path adjacent to the vault root.
            let vault_root = vault.records_dir
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| vault.records_dir.clone());
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let folder_name = vault_root
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("MindRelayVault");
            let dest = vault_root
                .parent()
                .unwrap_or(&vault_root)
                .join(format!("{folder_name}_backup_{ts}"));
            match vault.backup(&dest) {
                Ok(()) => vec![json!({"ok": true, "dest": dest.to_string_lossy()})],
                Err(e) => vec![json!({"ok": false, "error": e.to_string()})],
            }
        }

        "DELETE" => {
            let id = match msg["id"].as_str() {
                Some(s) if !s.trim().is_empty() => s.trim().to_string(),
                _ => return vec![json!({"ok": false, "error": "missing or empty field: id"})],
            };
            if id.len() > 200 {
                return vec![json!({"ok": false, "error": "id exceeds 200 chars"})];
            }
            if let Err(e) = db.delete(&id) {
                return vec![json!({"ok": false, "error": e.to_string()})];
            }
            if let Err(e) = vault.delete(&id) {
                logger.warn(&format!("vault delete warning: {e}"));
            }
            vec![json!({"ok": true, "id": id})]
        }

        "DELETE_BY_SOURCE" => {
            let source = match msg["source"].as_str() {
                Some(s) => s.trim().to_lowercase(),
                None => return vec![json!({"ok": false, "error": "missing field: source"})],
            };
            if !VALID_SOURCES.contains(&source.as_str()) {
                return vec![json!({"ok": false, "error": format!(
                    "source '{}' must be one of: {}", source, VALID_SOURCES.join(", ")
                )})];
            }
            if let Err(e) = db.delete_by_source(&source) {
                return vec![json!({"ok": false, "error": e.to_string()})];
            }
            if let Err(e) = vault.delete_by_source(&source) {
                logger.warn(&format!("vault delete_by_source warning: {e}"));
            }
            vec![json!({"ok": true})]
        }

        "CLEAR" => {
            if let Err(e) = db.clear() {
                return vec![json!({"ok": false, "error": e.to_string()})];
            }
            if let Err(e) = vault.clear() {
                logger.warn(&format!("vault clear warning: {e}"));
            }
            vec![json!({"ok": true})]
        }

        "FIND_BY_URL" => {
            let url = match msg["url"].as_str() {
                Some(s) if !s.trim().is_empty() => s.trim(),
                _ => return vec![json!({"ok": false, "error": "missing or empty field: url"})],
            };
            if url.len() > 2048 {
                return vec![json!({"ok": false, "error": "url exceeds 2048 chars"})];
            }
            match db.find_by_url(url) {
                Ok(t) => vec![json!({"ok": true, "data": t})],
                Err(e) => vec![json!({"ok": false, "error": e.to_string()})],
            }
        }

        "OPEN_APP" => vec![open_app()],

        "RELEVANCE_SEARCH" => {
            let session_id = match msg.get("sessionId").and_then(|v| v.as_str()) {
                Some(s) if !s.trim().is_empty() && s.len() <= 200 => s.trim().to_string(),
                Some(_) => return vec![json!({"ok": false, "error": "sessionId must be 1–200 chars"})],
                None => return vec![json!({"ok": false, "error": "missing field: sessionId"})],
            };
            let query = match msg.get("query").and_then(|v| v.as_str()) {
                Some(s) if !s.trim().is_empty() && s.len() <= 1000 => s.trim().to_string(),
                Some(_) => return vec![json!({"ok": false, "error": "query must be 1–1000 chars"})],
                None => return vec![json!({"ok": false, "error": "missing field: query"})],
            };
            let top_k = msg.get("topK").and_then(|v| v.as_u64()).unwrap_or(8).min(50) as u32;
            let min_score = msg.get("minScore").and_then(|v| v.as_f64()).unwrap_or(0.0);

            // Lazy GC: evict timed-out sessions before each search
            sessions.gc();

            // Fetch more candidates than needed so dedup doesn't leave us short
            let candidates = match db.search_text(&query, top_k * 3) {
                Ok(c) => c,
                Err(e) => return vec![json!({"ok": false, "error": e.to_string()})],
            };

            let mut dedup_filtered: usize = 0;
            let mut results: Vec<mindrelay_core::SearchResult> = Vec::new();
            for candidate in candidates {
                if candidate.score < min_score { continue; }
                if sessions.is_seen(&session_id, &candidate.transcript.id) {
                    dedup_filtered += 1;
                    continue;
                }
                results.push(candidate);
                if results.len() >= top_k as usize { break; }
            }

            let returned_ids: Vec<String> = results.iter().map(|r| r.transcript.id.clone()).collect();
            sessions.mark_seen(&session_id, &returned_ids);

            let results_json: Vec<Value> = results.into_iter().map(|r| {
                let mut v = serde_json::to_value(&r.transcript).unwrap_or(Value::Null);
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("_score".to_string(), json!(r.score));
                }
                v
            }).collect();

            vec![json!({
                "ok": true,
                "sessionId": session_id,
                "results": results_json,
                "dedupFiltered": dedup_filtered
            })]
        }

        "SESSION_END" => {
            let session_id = match msg.get("sessionId").and_then(|v| v.as_str()) {
                Some(s) if !s.trim().is_empty() => s.trim().to_string(),
                _ => return vec![json!({"ok": false, "error": "missing or empty field: sessionId"})],
            };
            sessions.end(&session_id);
            vec![json!({"ok": true})]
        }

        other => {
            vec![json!({"ok": false, "error": format!("unknown message type: '{other}'")})]
        }
    }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

fn main() -> io::Result<()> {
    let db = match Database::open_default() {
        Ok(db) => db,
        Err(e) => {
            eprintln!("[mindrelay-host] failed to open database: {e}");
            std::process::exit(1);
        }
    };

    let vault = match Vault::open_default() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[mindrelay-host] failed to open vault: {e}");
            std::process::exit(1);
        }
    };

    // Log file lives in the vault's hidden metadata directory.
    // vault.records_dir = <vault_base>/records  →  parent = <vault_base>
    let log_path = vault
        .records_dir
        .parent()
        .unwrap_or(&vault.records_dir)
        .join(".mindrelay")
        .join("logs")
        .join("mindrelay-host.log");
    let logger = logger::Logger::new(log_path);
    logger.info("mindrelay-host started");

    let mut sessions = SessionStore::new();

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdin = stdin.lock();
    let mut stdout = BufWriter::new(stdout.lock());

    loop {
        match protocol::read_message(&mut stdin)? {
            None => {
                logger.info("stdin EOF — shutting down");
                break;
            }
            Some(msg) => {
                let responses = handle_message(&db, &vault, &logger, &mut sessions, &msg);
                for response in responses {
                    protocol::write_message(&mut stdout, &response)?;
                }
            }
        }
    }

    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use mindrelay_core::{Message, Vault};
    use tempfile::TempDir;

    // ── Test helpers ──────────────────────────────────────────────────────────

    struct Env {
        db: Database,
        vault: Vault,
        logger: logger::Logger,
        sessions: SessionStore,
        _dir: TempDir,
    }

    impl Env {
        fn new() -> Self {
            let dir = TempDir::new().unwrap();
            let db = Database::open(&dir.path().join("test.db")).unwrap();
            let vault = Vault::open(dir.path().join("vault")).unwrap();
            let logger = logger::Logger::new(dir.path().join("test.log"));
            Env { db, vault, logger, sessions: SessionStore::new(), _dir: dir }
        }

        /// Send a message through the full handle_message pipeline.
        fn send(&mut self, msg: Value) -> Vec<Value> {
            handle_message(&self.db, &self.vault, &self.logger, &mut self.sessions, &msg)
        }

        /// Convenience: send and return the single response (panics if not 1).
        fn send1(&mut self, msg: Value) -> Value {
            let mut r = self.send(msg);
            assert_eq!(r.len(), 1, "expected single response, got {}", r.len());
            r.remove(0)
        }

        /// Reassemble a chunked response into a flat list of transcripts.
        fn reassemble(responses: Vec<Value>) -> Vec<Transcript> {
            let start = responses.iter().find(|r| r["type"] == "CHUNK_START").unwrap();
            let total = start["totalChunks"].as_u64().unwrap() as usize;
            let mut chunks: Vec<Option<Vec<Value>>> = vec![None; total];
            for r in &responses {
                if r["type"] == "CHUNK_DATA" {
                    let idx = r["chunkIndex"].as_u64().unwrap() as usize;
                    let data = r["data"].as_array().unwrap().clone();
                    chunks[idx] = Some(data);
                }
            }
            let end = responses.iter().find(|r| r["type"] == "CHUNK_END").unwrap();
            assert_eq!(end["ok"], true, "CHUNK_END ok must be true");
            chunks.into_iter().flatten().flatten()
                .map(|v| serde_json::from_value::<Transcript>(v).unwrap())
                .collect()
        }
    }

    fn make_t(id: &str, source: &str, ts: i64) -> Transcript {
        Transcript {
            id: id.to_string(),
            source: source.to_string(),
            title: format!("Convo {id}"),
            messages: vec![Message { role: "user".to_string(), content: "Hello world".to_string() }],
            markdown: format!("# Convo {id}"),
            timestamp: ts,
            url: format!("https://claude.ai/chat/{id}"),
        }
    }

    fn make_large_t(id: &str) -> Transcript {
        // ~210 KB of content — forces one transcript per chunk batch
        Transcript {
            id: id.to_string(),
            source: "claude".to_string(),
            title: format!("Large {id}"),
            messages: vec![Message { role: "user".to_string(), content: "x".repeat(210_000) }],
            markdown: String::new(),
            timestamp: 1_700_000_000_000,
            url: format!("https://claude.ai/chat/{id}"),
        }
    }

    // ── chunk_transcripts unit tests ──────────────────────────────────────────

    #[test]
    fn chunk_empty_vec_yields_one_empty_batch() {
        let batches = chunk_transcripts(vec![]);
        assert_eq!(batches.len(), 1);
        assert!(batches[0].is_empty());
    }

    #[test]
    fn chunk_small_items_stay_in_one_batch() {
        let ts: Vec<Transcript> = (0..5).map(|i| make_t(&format!("id{i}"), "claude", 1_000 + i)).collect();
        let batches = chunk_transcripts(ts);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 5);
    }

    #[test]
    fn chunk_large_items_split_into_multiple_batches() {
        let ts: Vec<Transcript> = (0..3).map(|i| make_large_t(&format!("id{i}"))).collect();
        let batches = chunk_transcripts(ts);
        assert_eq!(batches.len(), 3);
        for batch in &batches {
            assert_eq!(batch.len(), 1);
        }
    }

    // ── PING ──────────────────────────────────────────────────────────────────

    #[test]
    fn ping_returns_pong() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "PING", "requestId": "p1", "version": 1}));
        assert_eq!(r["ok"], true);
        assert_eq!(r["pong"], true);
    }

    // ── PUT ───────────────────────────────────────────────────────────────────

    #[test]
    fn put_stores_in_db_and_vault() {
        let mut env = Env::new();
        let t = make_t("abc", "claude", 1_700_000_001);
        let r = env.send1(json!({"type": "PUT", "requestId": "r1", "version": 1, "data": t}));
        assert_eq!(r["ok"], true);
        assert_eq!(r["id"], "abc");

        // DB
        let found = env.db.get_by_id("abc").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().source, "claude");

        // Vault file
        let vault_file = env.vault.records_dir.join("abc.json");
        assert!(vault_file.exists());
    }

    #[test]
    fn put_upserts_existing_id() {
        let mut env = Env::new();
        let t = make_t("dup", "claude", 1_700_000_001);
        env.send1(json!({"type": "PUT", "requestId": "r1", "version": 1, "data": t}));
        let mut updated = make_t("dup", "claude", 1_700_000_002);
        updated.title = "Updated title".to_string();
        let r = env.send1(json!({"type": "PUT", "requestId": "r2", "version": 1, "data": updated}));
        assert_eq!(r["ok"], true);
        let found = env.db.get_by_id("dup").unwrap().unwrap();
        assert_eq!(found.title, "Updated title");
    }

    #[test]
    fn put_rejects_missing_data_field() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "PUT", "requestId": "r1", "version": 1}));
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("missing field: data"));
    }

    #[test]
    fn put_rejects_invalid_source() {
        let mut env = Env::new();
        let mut t = make_t("x1", "openai", 1_700_000_001); // invalid source
        t.source = "openai".to_string();
        let r = env.send1(json!({"type": "PUT", "requestId": "r1", "version": 1, "data": t}));
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().to_lowercase().contains("source"));
    }

    #[test]
    fn put_rejects_empty_messages() {
        let mut env = Env::new();
        let mut t = make_t("x2", "claude", 1_700_000_001);
        t.messages = vec![];
        let r = env.send1(json!({"type": "PUT", "requestId": "r1", "version": 1, "data": t}));
        assert_eq!(r["ok"], false);
    }

    #[test]
    fn put_rejects_empty_id() {
        let mut env = Env::new();
        let mut t = make_t("", "claude", 1_700_000_001);
        t.id = String::new();
        let r = env.send1(json!({"type": "PUT", "requestId": "r1", "version": 1, "data": t}));
        assert_eq!(r["ok"], false);
    }

    // ── GET_ALL ───────────────────────────────────────────────────────────────

    #[test]
    fn get_all_empty_db_returns_valid_chunk_sequence() {
        let mut env = Env::new();
        let responses = env.send(json!({"type": "GET_ALL", "requestId": "g1", "version": 1}));

        // Must have CHUNK_START, ≥1 CHUNK_DATA, CHUNK_END
        assert!(responses.iter().any(|r| r["type"] == "CHUNK_START"));
        assert!(responses.iter().any(|r| r["type"] == "CHUNK_DATA"));
        assert!(responses.iter().any(|r| r["type"] == "CHUNK_END"));

        let transcripts = Env::reassemble(responses);
        assert!(transcripts.is_empty());
    }

    #[test]
    fn get_all_chunk_structure_is_correct() {
        let mut env = Env::new();
        for i in 0..5 {
            let t = make_t(&format!("t{i}"), "chatgpt", 1_700_000_000 + i);
            env.db.put(&t).unwrap();
        }
        let responses = env.send(json!({"type": "GET_ALL", "requestId": "ga1", "version": 1}));

        let start = responses.iter().find(|r| r["type"] == "CHUNK_START").unwrap();
        let total_chunks = start["totalChunks"].as_u64().unwrap() as usize;

        let data_msgs: Vec<&Value> = responses.iter().filter(|r| r["type"] == "CHUNK_DATA").collect();
        assert_eq!(data_msgs.len(), total_chunks, "CHUNK_DATA count must equal totalChunks");

        let end = responses.iter().find(|r| r["type"] == "CHUNK_END").unwrap();
        assert_eq!(end["ok"], true);

        // All chunk indices 0..total_chunks must be present
        let indices: std::collections::HashSet<u64> = data_msgs.iter()
            .map(|r| r["chunkIndex"].as_u64().unwrap())
            .collect();
        for i in 0..total_chunks as u64 {
            assert!(indices.contains(&i), "missing chunkIndex {i}");
        }
    }

    #[test]
    fn get_all_large_payload_creates_multiple_chunks() {
        let mut env = Env::new();
        // Each transcript is ~210 KB — must each land in its own chunk
        for i in 0..3 {
            env.db.put(&make_large_t(&format!("big{i}"))).unwrap();
        }
        let responses = env.send(json!({"type": "GET_ALL", "requestId": "big1", "version": 1}));
        let start = responses.iter().find(|r| r["type"] == "CHUNK_START").unwrap();
        assert!(start["totalChunks"].as_u64().unwrap() >= 3, "3 large transcripts must span ≥3 chunks");
    }

    #[test]
    fn get_all_reassembled_data_matches_put_data() {
        let mut env = Env::new();
        let ids = ["r1", "r2", "r3"];
        for id in ids {
            let t = make_t(id, "gemini", 1_700_000_000);
            env.db.put(&t).unwrap();
        }
        let responses = env.send(json!({"type": "GET_ALL", "requestId": "ra1", "version": 1}));
        let reassembled = Env::reassemble(responses);
        assert_eq!(reassembled.len(), 3);
        let mut got_ids: Vec<&str> = reassembled.iter().map(|t| t.id.as_str()).collect();
        got_ids.sort_unstable();
        assert_eq!(got_ids, ["r1", "r2", "r3"]);
    }

    #[test]
    fn get_all_request_id_propagated_to_all_chunk_messages() {
        let mut env = Env::new();
        env.db.put(&make_t("x", "grok", 1_000)).unwrap();
        let responses = env.send(json!({"type": "GET_ALL", "requestId": "myrid", "version": 1}));
        for r in &responses {
            assert_eq!(
                r["requestId"].as_str().unwrap(),
                "myrid",
                "requestId must be propagated to {}", r["type"]
            );
        }
    }

    // ── GET_RECENT ────────────────────────────────────────────────────────────

    #[test]
    fn get_recent_returns_at_most_limit() {
        let mut env = Env::new();
        for i in 0..20i64 {
            env.db.put(&make_t(&format!("t{i}"), "claude", 1_700_000_000 + i)).unwrap();
        }
        let responses = env.send(json!({"type": "GET_RECENT", "requestId": "gr1", "version": 1, "limit": 7}));
        let got = Env::reassemble(responses);
        assert_eq!(got.len(), 7);
    }

    #[test]
    fn get_recent_returns_newest_first() {
        let mut env = Env::new();
        for i in 0..10i64 {
            env.db.put(&make_t(&format!("t{i}"), "claude", i * 1000)).unwrap();
        }
        let responses = env.send(json!({"type": "GET_RECENT", "requestId": "gr2", "version": 1, "limit": 3}));
        let got = Env::reassemble(responses);
        assert_eq!(got.len(), 3);
        // Newest first: timestamps 9000, 8000, 7000
        assert!(got[0].timestamp > got[1].timestamp);
        assert!(got[1].timestamp > got[2].timestamp);
    }

    #[test]
    fn get_recent_defaults_to_50_when_limit_absent() {
        let mut env = Env::new();
        for i in 0..60i64 {
            env.db.put(&make_t(&format!("t{i}"), "claude", i)).unwrap();
        }
        let responses = env.send(json!({"type": "GET_RECENT", "requestId": "gr3", "version": 1}));
        let got = Env::reassemble(responses);
        assert_eq!(got.len(), 50);
    }

    #[test]
    fn get_recent_limit_zero_returns_empty() {
        let mut env = Env::new();
        env.db.put(&make_t("t0", "claude", 1_000)).unwrap();
        let responses = env.send(json!({"type": "GET_RECENT", "requestId": "gr4", "version": 1, "limit": 0}));
        let got = Env::reassemble(responses);
        assert!(got.is_empty());
    }

    // ── GET_BY_SOURCE ─────────────────────────────────────────────────────────

    #[test]
    fn get_by_source_filters_correctly() {
        let mut env = Env::new();
        env.db.put(&make_t("c1", "claude", 1_000)).unwrap();
        env.db.put(&make_t("c2", "claude", 2_000)).unwrap();
        env.db.put(&make_t("g1", "chatgpt", 3_000)).unwrap();
        env.db.put(&make_t("g2", "gemini", 4_000)).unwrap();

        let responses = env.send(json!({"type": "GET_BY_SOURCE", "requestId": "gs1", "version": 1, "source": "claude"}));
        let got = Env::reassemble(responses);
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|t| t.source == "claude"));
    }

    #[test]
    fn get_by_source_rejects_invalid_source() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "GET_BY_SOURCE", "requestId": "gs2", "version": 1, "source": "openai"}));
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().to_lowercase().contains("source"));
    }

    #[test]
    fn get_by_source_missing_source_field_returns_error() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "GET_BY_SOURCE", "requestId": "gs3", "version": 1}));
        assert_eq!(r["ok"], false);
    }

    // ── GET_BY_DATE_RANGE ─────────────────────────────────────────────────────

    #[test]
    fn get_by_date_range_filters_correctly() {
        let mut env = Env::new();
        env.db.put(&make_t("old", "claude", 1_000)).unwrap();
        env.db.put(&make_t("mid", "claude", 5_000)).unwrap();
        env.db.put(&make_t("new", "claude", 9_000)).unwrap();

        let responses = env.send(json!({"type": "GET_BY_DATE_RANGE", "requestId": "dr1", "version": 1, "sinceMs": 2_000, "untilMs": 8_000}));
        let got = Env::reassemble(responses);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "mid");
    }

    #[test]
    fn get_by_date_range_inclusive_bounds() {
        let mut env = Env::new();
        env.db.put(&make_t("a", "claude", 100)).unwrap();
        env.db.put(&make_t("b", "claude", 200)).unwrap();
        env.db.put(&make_t("c", "claude", 300)).unwrap();

        // Exact boundary match
        let responses = env.send(json!({"type": "GET_BY_DATE_RANGE", "requestId": "dr2", "version": 1, "sinceMs": 100, "untilMs": 200}));
        let got = Env::reassemble(responses);
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn get_by_date_range_rejects_since_after_until() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "GET_BY_DATE_RANGE", "requestId": "dr3", "version": 1, "sinceMs": 9_000, "untilMs": 1_000}));
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("sinceMs"));
    }

    #[test]
    fn get_by_date_range_rejects_negative_timestamps() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "GET_BY_DATE_RANGE", "requestId": "dr4", "version": 1, "sinceMs": -1, "untilMs": 9_000}));
        assert_eq!(r["ok"], false);
    }

    // ── DELETE ────────────────────────────────────────────────────────────────

    #[test]
    fn delete_removes_from_db_and_vault() {
        let mut env = Env::new();
        let t = make_t("del1", "claude", 1_000);
        env.db.put(&t).unwrap();
        env.vault.put(&t).unwrap();

        let r = env.send1(json!({"type": "DELETE", "requestId": "d1", "version": 1, "id": "del1"}));
        assert_eq!(r["ok"], true);

        assert!(env.db.get_by_id("del1").unwrap().is_none());
        assert!(!env.vault.records_dir.join("del1.json").exists());
    }

    #[test]
    fn delete_missing_id_field_returns_error() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "DELETE", "requestId": "d2", "version": 1}));
        assert_eq!(r["ok"], false);
    }

    #[test]
    fn delete_oversized_id_returns_error() {
        let mut env = Env::new();
        let long_id = "a".repeat(201);
        let r = env.send1(json!({"type": "DELETE", "requestId": "d3", "version": 1, "id": long_id}));
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("id"));
    }

    // ── DELETE_BY_SOURCE ──────────────────────────────────────────────────────

    #[test]
    fn delete_by_source_removes_matching_entries() {
        let mut env = Env::new();
        for id in ["s1", "s2"] {
            let t = make_t(id, "grok", 1_000);
            env.db.put(&t).unwrap();
            env.vault.put(&t).unwrap();
        }
        env.db.put(&make_t("keep", "gemini", 2_000)).unwrap();

        let r = env.send1(json!({"type": "DELETE_BY_SOURCE", "requestId": "ds1", "version": 1, "source": "grok"}));
        assert_eq!(r["ok"], true);

        let remaining = env.db.get_all().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "keep");
    }

    #[test]
    fn delete_by_source_rejects_invalid_source() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "DELETE_BY_SOURCE", "requestId": "ds2", "version": 1, "source": "twitter"}));
        assert_eq!(r["ok"], false);
    }

    // ── CLEAR ─────────────────────────────────────────────────────────────────

    #[test]
    fn clear_removes_all_transcripts() {
        let mut env = Env::new();
        for id in ["c1", "c2", "c3"] {
            let t = make_t(id, "claude", 1_000);
            env.db.put(&t).unwrap();
            env.vault.put(&t).unwrap();
        }
        let r = env.send1(json!({"type": "CLEAR", "requestId": "cl1", "version": 1}));
        assert_eq!(r["ok"], true);
        assert!(env.db.get_all().unwrap().is_empty());
    }

    // ── FIND_BY_URL ───────────────────────────────────────────────────────────

    #[test]
    fn find_by_url_returns_matching_transcript() {
        let mut env = Env::new();
        let t = make_t("u1", "claude", 1_000);
        env.db.put(&t).unwrap();

        let r = env.send1(json!({"type": "FIND_BY_URL", "requestId": "fu1", "version": 1, "url": "https://claude.ai/chat/u1"}));
        assert_eq!(r["ok"], true);
        assert_eq!(r["data"]["id"], "u1");
    }

    #[test]
    fn find_by_url_returns_null_data_when_not_found() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "FIND_BY_URL", "requestId": "fu2", "version": 1, "url": "https://claude.ai/chat/nope"}));
        assert_eq!(r["ok"], true);
        assert!(r["data"].is_null());
    }

    #[test]
    fn find_by_url_rejects_oversized_url() {
        let mut env = Env::new();
        let long_url = format!("https://claude.ai/{}", "a".repeat(2100));
        let r = env.send1(json!({"type": "FIND_BY_URL", "requestId": "fu3", "version": 1, "url": long_url}));
        assert_eq!(r["ok"], false);
    }

    // ── BACKUP_VAULT ──────────────────────────────────────────────────────────

    #[test]
    fn backup_vault_creates_backup_directory() {
        let mut env = Env::new();
        let t = make_t("bv1", "claude", 1_000);
        env.db.put(&t).unwrap();
        env.vault.put(&t).unwrap();

        let responses = env.send(json!({"type": "BACKUP_VAULT", "requestId": "bk1", "version": 1}));
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0]["ok"], true);

        let dest = responses[0]["dest"].as_str().unwrap();
        let dest_path = std::path::Path::new(dest);
        assert!(dest_path.exists(), "backup destination must exist");
        assert!(dest_path.join("records").is_dir());
    }

    // ── requestId / version injection ─────────────────────────────────────────

    #[test]
    fn request_id_injected_into_non_chunk_response() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "PING", "requestId": "inject-me", "version": 1}));
        assert_eq!(r["requestId"], "inject-me");
        assert_eq!(r["version"], 1);
    }

    #[test]
    fn version_defaults_to_1_in_all_responses() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "PING", "version": 1}));
        assert_eq!(r["version"], 1);
    }

    #[test]
    fn unknown_message_type_returns_error() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "DOES_NOT_EXIST", "requestId": "u1", "version": 1}));
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("unknown message type"));
    }

    // ── Reinstall / startup-sync simulation ───────────────────────────────────
    // Models: extension uninstalled → all IndexedDB data gone → reinstall →
    // syncFromHost calls GET_ALL → data repopulated from host vault.

    #[test]
    fn reinstall_flow_get_all_repopulates_fresh_db() {
        let mut env = Env::new();

        // Step 1: write 5 transcripts into the host db (simulates prior usage)
        for i in 0..5i64 {
            env.db.put(&make_t(&format!("re{i}"), "claude", 1_700_000_000 + i)).unwrap();
        }

        // Step 2: "reinstall" → open a fresh db (simulates IndexedDB wiped)
        let fresh_db = Database::open_in_memory().unwrap();
        assert!(fresh_db.get_all().unwrap().is_empty(), "fresh DB must be empty");

        // Step 3: GET_ALL from host → reassemble
        let responses = env.send(json!({"type": "GET_ALL", "requestId": "sync1", "version": 1}));
        let host_transcripts = Env::reassemble(responses);
        assert_eq!(host_transcripts.len(), 5, "host must return all 5");

        // Step 4: import into fresh db (simulates syncFromHost logic)
        for t in &host_transcripts {
            fresh_db.put(t).unwrap();
        }
        let repopulated = fresh_db.get_all().unwrap();
        assert_eq!(repopulated.len(), 5, "fresh DB must have all 5 after sync");
    }

    // ── Malformed message robustness ──────────────────────────────────────────

    #[test]
    fn completely_empty_object_returns_error() {
        let mut env = Env::new();
        let r = env.send1(json!({}));
        assert_eq!(r["ok"], false);
    }

    #[test]
    fn put_with_completely_wrong_shape_returns_error() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "PUT", "requestId": "m1", "version": 1, "data": {"garbage": true}}));
        assert_eq!(r["ok"], false);
    }

    #[test]
    fn get_by_date_range_equal_bounds_returns_exact_match() {
        let mut env = Env::new();
        env.db.put(&make_t("exact", "claude", 5_000)).unwrap();
        env.db.put(&make_t("other", "claude", 6_000)).unwrap();
        let responses = env.send(json!({"type": "GET_BY_DATE_RANGE", "requestId": "eq1", "version": 1, "sinceMs": 5_000, "untilMs": 5_000}));
        let got = Env::reassemble(responses);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "exact");
    }

    // ── RELEVANCE_SEARCH ──────────────────────────────────────────────────────

    fn make_search_t(id: &str, title: &str, content: &str) -> Transcript {
        Transcript {
            id: id.to_string(),
            source: "claude".to_string(),
            title: title.to_string(),
            messages: vec![Message { role: "user".to_string(), content: content.to_string() }],
            markdown: String::new(),
            timestamp: 1_700_000_000,
            url: format!("https://claude.ai/chat/{id}"),
        }
    }

    #[test]
    fn relevance_search_returns_matching_results() {
        let mut env = Env::new();
        env.send1(json!({"type": "PUT", "requestId": "p1", "version": 1,
            "data": make_search_t("s1", "memory leak investigation", "heap allocation spike")}));
        env.send1(json!({"type": "PUT", "requestId": "p2", "version": 1,
            "data": make_search_t("s2", "unrelated cooking tips", "pasta recipe")}));

        let r = env.send1(json!({
            "type": "RELEVANCE_SEARCH",
            "requestId": "rs1",
            "version": 1,
            "sessionId": "sess-abc",
            "query": "memory leak heap"
        }));
        assert_eq!(r["ok"], true);
        let results = r["results"].as_array().unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0]["id"], "s1");
        // Each result must carry a _score field
        assert!(results[0]["_score"].as_f64().unwrap() > 0.0);
    }

    #[test]
    fn relevance_search_deduplicates_across_turns() {
        let mut env = Env::new();
        env.send1(json!({"type": "PUT", "requestId": "p1", "version": 1,
            "data": make_search_t("d1", "crash report alpha", "server crash alpha")}));
        env.send1(json!({"type": "PUT", "requestId": "p2", "version": 1,
            "data": make_search_t("d2", "crash report beta", "server crash beta")}));

        // First search: both results available
        let r1 = env.send1(json!({
            "type": "RELEVANCE_SEARCH", "requestId": "rs1", "version": 1,
            "sessionId": "sess-dedup", "query": "server crash", "topK": 10
        }));
        let first_ids: Vec<String> = r1["results"].as_array().unwrap()
            .iter().map(|v| v["id"].as_str().unwrap().to_string()).collect();
        assert!(!first_ids.is_empty());

        // Second search same session: previously returned IDs must not reappear
        let r2 = env.send1(json!({
            "type": "RELEVANCE_SEARCH", "requestId": "rs2", "version": 1,
            "sessionId": "sess-dedup", "query": "server crash", "topK": 10
        }));
        let second_ids: Vec<String> = r2["results"].as_array().unwrap()
            .iter().map(|v| v["id"].as_str().unwrap().to_string()).collect();
        for id in &first_ids {
            assert!(!second_ids.contains(id), "id {id} should have been deduped");
        }
        // dedupFiltered must report how many were skipped
        assert_eq!(r2["dedupFiltered"].as_u64().unwrap(), first_ids.len() as u64);
    }

    #[test]
    fn relevance_search_different_sessions_not_deduped() {
        let mut env = Env::new();
        env.send1(json!({"type": "PUT", "requestId": "p1", "version": 1,
            "data": make_search_t("x1", "unique zorkblat", "zorkblat")}));

        let r1 = env.send1(json!({
            "type": "RELEVANCE_SEARCH", "requestId": "rs1", "version": 1,
            "sessionId": "sess-A", "query": "zorkblat"
        }));
        assert!(!r1["results"].as_array().unwrap().is_empty());

        // Different session — should NOT be deduped
        let r2 = env.send1(json!({
            "type": "RELEVANCE_SEARCH", "requestId": "rs2", "version": 1,
            "sessionId": "sess-B", "query": "zorkblat"
        }));
        assert!(!r2["results"].as_array().unwrap().is_empty());
    }

    #[test]
    fn relevance_search_missing_session_id_returns_error() {
        let mut env = Env::new();
        let r = env.send1(json!({
            "type": "RELEVANCE_SEARCH", "requestId": "rs1", "version": 1,
            "query": "something"
        }));
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("sessionId"));
    }

    #[test]
    fn relevance_search_missing_query_returns_error() {
        let mut env = Env::new();
        let r = env.send1(json!({
            "type": "RELEVANCE_SEARCH", "requestId": "rs1", "version": 1,
            "sessionId": "sess-x"
        }));
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("query"));
    }

    #[test]
    fn relevance_search_empty_db_returns_empty_results() {
        let mut env = Env::new();
        let r = env.send1(json!({
            "type": "RELEVANCE_SEARCH", "requestId": "rs1", "version": 1,
            "sessionId": "sess-empty", "query": "anything"
        }));
        assert_eq!(r["ok"], true);
        assert!(r["results"].as_array().unwrap().is_empty());
    }

    #[test]
    fn relevance_search_min_score_filters_low_scores() {
        let mut env = Env::new();
        env.send1(json!({"type": "PUT", "requestId": "p1", "version": 1,
            "data": make_search_t("ms1", "weak match", "something marginally relevant")}));

        // With a very high minScore nothing should pass
        let r = env.send1(json!({
            "type": "RELEVANCE_SEARCH", "requestId": "rs1", "version": 1,
            "sessionId": "sess-ms", "query": "something", "minScore": 999.0
        }));
        assert_eq!(r["ok"], true);
        assert!(r["results"].as_array().unwrap().is_empty());
    }

    // ── SESSION_END ───────────────────────────────────────────────────────────

    #[test]
    fn session_end_clears_dedup_state() {
        let mut env = Env::new();
        env.send1(json!({"type": "PUT", "requestId": "p1", "version": 1,
            "data": make_search_t("se1", "session end test", "quuxfrobble")}));

        // First search — result is seen
        let r1 = env.send1(json!({
            "type": "RELEVANCE_SEARCH", "requestId": "rs1", "version": 1,
            "sessionId": "sess-end", "query": "quuxfrobble"
        }));
        assert!(!r1["results"].as_array().unwrap().is_empty());

        // Same session — should be deduped now
        let r2 = env.send1(json!({
            "type": "RELEVANCE_SEARCH", "requestId": "rs2", "version": 1,
            "sessionId": "sess-end", "query": "quuxfrobble"
        }));
        assert!(r2["results"].as_array().unwrap().is_empty());

        // End the session
        let end_r = env.send1(json!({
            "type": "SESSION_END", "requestId": "se1", "version": 1,
            "sessionId": "sess-end"
        }));
        assert_eq!(end_r["ok"], true);

        // After session end, the same result should be returned again
        let r3 = env.send1(json!({
            "type": "RELEVANCE_SEARCH", "requestId": "rs3", "version": 1,
            "sessionId": "sess-end", "query": "quuxfrobble"
        }));
        assert!(!r3["results"].as_array().unwrap().is_empty());
    }

    #[test]
    fn session_end_missing_session_id_returns_error() {
        let mut env = Env::new();
        let r = env.send1(json!({"type": "SESSION_END", "requestId": "se1", "version": 1}));
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("sessionId"));
    }

    #[test]
    fn session_end_nonexistent_session_is_noop() {
        let mut env = Env::new();
        let r = env.send1(json!({
            "type": "SESSION_END", "requestId": "se1", "version": 1,
            "sessionId": "never-existed"
        }));
        assert_eq!(r["ok"], true);
    }
}
