// Pure string utilities — no chrome.* calls, safe to import in main world scripts
import type { Transcript } from "./storage"

// ─── Tokenization ─────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  // articles, prepositions, conjunctions
  "the","a","an","is","it","in","on","at","to","for","of","and","or","but",
  // pronouns
  "i","my","me","you","your","we","us","our","he","she","his","her","they","them","their",
  // question / filler words
  "what","how","can","why","who","which","where","when","please","want","need",
  // modal / auxiliary verbs
  "would","could","should","have","will","been","been","has","had","was","were",
  "are","be","do","did","does","get","got","let","put","set","use","used",
  // common verbs (low signal)
  "make","made","take","took","come","came","know","think","look","give","find",
  "tell","ask","seem","feel","try","leave","call","help","show","back","keep",
  "going","getting","making","giving","finding","showing","helping","looking","trying",
  // common adjectives / adverbs (low signal)
  "also","just","like","than","then","still","even","much","very","now","here",
  "there","new","well","good","best","better","after","into","over","both","each",
  "more","most","other","some","such","only","same","while","being","about",
  // demonstratives
  "this","that","these","those",
  // other noise
  "all","any","few","really","actually","basically","literally","probably",
  "might","maybe","perhaps","however","though","although","because","since",
  // semantically ambiguous — mean different things in tech vs personal contexts
  "live","life","world","people","place","time","work","thing","things","way",
  // query instruction words — describe HOW the user is asking, not WHAT about
  // these appear in nearly every query and match unrelated transcripts
  "learn","learning","learned","interested","interest","interesting",
  "understand","understanding","explain","explanation","describe","description",
  "discuss","discussing","information","info","details","overview","summary",
  "tell","provide","share","know","knowing","curious","question","answer",
  "little","bit","more","less","brief","quick","deep","dive","intro","introduction"
])

// Short words that are meaningful in tech/AI contexts — never filtered
const KEEP_SHORT = new Set([
  "ai","ml","api","sql","css","js","ts","ui","ux","db","io","vm","os",
  "ci","cd","aws","gpt","llm","seo","crm","orm","ide","git","npm","pip",
  "dev","mvp","sdk","vue","jsx","tsx","dom","url","cli","ssh","jwt","env",
  "src","lib","app","bot","key","tag","log","run","fix","bug","pr","qa"
])

export function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => {
      if (w.length < 2) return false
      if (KEEP_SHORT.has(w)) return true
      if (w.length <= 3) return false
      return !STOP_WORDS.has(w)
    })
}

function termFrequency(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>()
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  return freq
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

const TITLE_WEIGHT = 5      // title match — strongest topic signal
const FIRST_MSG_WEIGHT = 3  // first user message — sets the topic
const BODY_FREQ_CAP = 4     // max freq contribution per term in body text
const MIN_SCORE = 5         // below this = not relevant, don't inject (raised from 2)
const MIN_TERM_OVERLAP = 2  // at least 2 distinct query terms must match
const SCORE_GAP_RATIO = 0.65 // secondary results must score ≥ 65% of top score (raised from 0.5)

function scoreTranscript(
  queryTerms: Set<string>,
  transcript: Transcript
): { score: number; termOverlap: number } {
  if (queryTerms.size === 0) return { score: 0, termOverlap: 0 }
  let score = 0
  const matchedTerms = new Set<string>()

  // Title — strongest signal
  const titleFreq = termFrequency(tokenize(transcript.title))
  for (const term of queryTerms) {
    if (titleFreq.has(term)) { score += TITLE_WEIGHT; matchedTerms.add(term) }
  }

  // First user message — topic statement, highest body weight
  const firstUser = transcript.messages.find((m) => m.role === "user")
  if (firstUser) {
    const freq = termFrequency(tokenize(firstUser.content))
    for (const term of queryTerms) {
      const hits = freq.get(term) ?? 0
      if (hits > 0) { score += Math.min(hits, BODY_FREQ_CAP) * FIRST_MSG_WEIGHT; matchedTerms.add(term) }
    }
  }

  // Remaining messages — supporting signal (up to 12 messages)
  for (const msg of transcript.messages.slice(0, 12)) {
    if (msg === firstUser) continue
    const freq = termFrequency(tokenize(msg.content))
    for (const term of queryTerms) {
      const hits = freq.get(term) ?? 0
      if (hits > 0) { score += Math.min(hits, BODY_FREQ_CAP); matchedTerms.add(term) }
    }
  }

  return { score, termOverlap: matchedTerms.size }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Rank transcripts by relevance to a query.
 * Returns top N that meet the minimum score threshold.
 * Returns [] if nothing is relevant — never falls back to recent.
 * Recency breaks ties when scores are equal.
 */
export function rankTranscripts(
  query: string,
  transcripts: Transcript[],
  topN = 3
): Transcript[] {
  if (transcripts.length === 0) return []

  const queryTerms = new Set(tokenize(query))
  if (queryTerms.size === 0) return []

  const scored = transcripts
    .map((t) => ({ t, ...scoreTranscript(queryTerms, t) }))
    .filter(({ score, termOverlap }) => score >= MIN_SCORE && termOverlap >= MIN_TERM_OVERLAP)
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : b.t.timestamp - a.t.timestamp // recency tiebreaker
    )
    .slice(0, topN)

  if (scored.length === 0) return []

  const topScore = scored[0].score
  return scored
    .filter(({ score }) => score >= topScore * SCORE_GAP_RATIO)
    .map(({ t }) => t)
}

/**
 * Build a single context block from multiple ranked transcripts.
 */
export function buildCombinedContext(transcripts: Transcript[]): string {
  if (transcripts.length === 0) return ""

  const sections = transcripts.map((t) => {
    const tDate = new Date(t.timestamp).toLocaleDateString()
    const lines = t.messages.slice(0, 14).map((m) => {
      const label = m.role === "user" ? "User" : "Assistant"
      const limit = m.role === "user" ? 400 : 700
      const text = m.content.trim()
      return `${label}: ${text.length > limit ? text.slice(0, limit) + "..." : text}`
    })
    return [`[MindRelay: "${t.title}" — ${t.source}, ${tDate}]`, ...lines].join("\n\n")
  })

  return [...sections, "[End of retrieved memory.]"].join("\n\n")
}
