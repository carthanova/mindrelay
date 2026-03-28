mod protocol;

use std::io::{self, BufWriter};

use mindrelay_core::{Database, Transcript};
use serde_json::{json, Value};

fn handle_message(db: &Database, msg: &Value) -> Value {
    let msg_type = msg["type"].as_str().unwrap_or("");

    match msg_type {
        "PING" => json!({"ok": true, "pong": true}),

        "PUT" => {
            match serde_json::from_value::<Transcript>(msg["data"].clone()) {
                Ok(t) => match db.put(&t) {
                    Ok(_) => json!({"ok": true}),
                    Err(e) => json!({"ok": false, "error": e.to_string()}),
                },
                Err(e) => json!({"ok": false, "error": format!("invalid transcript: {}", e)}),
            }
        }

        "GET_ALL" => match db.get_all() {
            Ok(transcripts) => json!({"ok": true, "data": transcripts}),
            Err(e) => json!({"ok": false, "error": e.to_string()}),
        },

        "DELETE" => {
            let id = msg["id"].as_str().unwrap_or("");
            match db.delete(id) {
                Ok(_) => json!({"ok": true}),
                Err(e) => json!({"ok": false, "error": e.to_string()}),
            }
        }

        "DELETE_BY_SOURCE" => {
            let source = msg["source"].as_str().unwrap_or("");
            match db.delete_by_source(source) {
                Ok(_) => json!({"ok": true}),
                Err(e) => json!({"ok": false, "error": e.to_string()}),
            }
        }

        "CLEAR" => match db.clear() {
            Ok(_) => json!({"ok": true}),
            Err(e) => json!({"ok": false, "error": e.to_string()}),
        },

        "FIND_BY_URL" => {
            let url = msg["url"].as_str().unwrap_or("");
            match db.find_by_url(url) {
                Ok(t) => json!({"ok": true, "data": t}),
                Err(e) => json!({"ok": false, "error": e.to_string()}),
            }
        }

        _ => json!({"ok": false, "error": format!("unknown type: {}", msg_type)}),
    }
}

fn main() -> io::Result<()> {
    let db = match Database::open_default() {
        Ok(db) => db,
        Err(e) => {
            eprintln!("[mindrelay-host] failed to open database: {}", e);
            std::process::exit(1);
        }
    };

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdin = stdin.lock();
    let mut stdout = BufWriter::new(stdout.lock());

    loop {
        match protocol::read_message(&mut stdin)? {
            None => break, // Chrome closed the pipe — exit cleanly
            Some(msg) => {
                let response = handle_message(&db, &msg);
                protocol::write_message(&mut stdout, &response)?;
            }
        }
    }

    Ok(())
}
