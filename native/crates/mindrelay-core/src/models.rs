use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transcript {
    pub id: String,
    pub source: String,
    pub title: String,
    pub url: String,
    pub timestamp: i64,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub markdown: String,
}
