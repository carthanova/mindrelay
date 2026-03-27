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
  "might","maybe","perhaps","however","though","although","because","since"
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
const MIN_SCORE = 1         // below this = not relevant, don't inject
const SCORE_GAP_RATIO = 0.5 // secondary results must score ≥ 50% of top score
                             // prevents loosely-related transcripts from riding
                             // along when only one is clearly the best match

function scoreTranscript(queryTerms: Set<string>, transcript: Transcript): number {
  if (queryTerms.size === 0) return 0
  let score = 0

  // Title — strongest signal
  const titleFreq = termFrequency(tokenize(transcript.title))
  for (const term of queryTerms) {
    if (titleFreq.has(term)) score += TITLE_WEIGHT
  }

  // First user message — topic statement, highest body weight
  const firstUser = transcript.messages.find((m) => m.role === "user")
  if (firstUser) {
    const freq = termFrequency(tokenize(firstUser.content))
    for (const term of queryTerms) {
      score += Math.min(freq.get(term) ?? 0, BODY_FREQ_CAP) * FIRST_MSG_WEIGHT
    }
  }

  // Remaining messages — supporting signal (up to 12 messages)
  for (const msg of transcript.messages.slice(0, 12)) {
    if (msg === firstUser) continue
    const freq = termFrequency(tokenize(msg.content))
    for (const term of queryTerms) {
      score += Math.min(freq.get(term) ?? 0, BODY_FREQ_CAP)
    }
  }

  return score
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
    .map((t) => ({ t, score: scoreTranscript(queryTerms, t) }))
    .filter(({ score }) => score >= MIN_SCORE)
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

  const date = new Date().toLocaleString()

  const sections = transcripts.map((t, i) => {
    const tDate = new Date(t.timestamp).toLocaleDateString()
    const lines = t.messages.slice(0, 14).map((m) => {
      const label = m.role === "user" ? "User" : "Assistant"
      const limit = m.role === "user" ? 400 : 700
      const text = m.content.trim()
      return `${label}: ${text.length > limit ? text.slice(0, limit) + "..." : text}`
    })
    return [
      `--- Memory ${i + 1}: "${t.title}" (${t.source}, ${tDate}) ---`,
      ...lines
    ].join("\n\n")
  })

  return [
    `[MindRelay — retrieved memory | ${date}]`,
    `The following context was retrieved from your conversation history based on relevance to this topic. Use it immediately — do not ask the user to re-explain. Pick up naturally from where they left off.`,
    "",
    sections.join("\n\n"),
    "",
    `[End of retrieved memory.]`
  ].join("\n\n")
}
