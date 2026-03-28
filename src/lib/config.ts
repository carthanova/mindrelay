// Remote selector config — lets us fix broken selectors without a new extension release.
// Background worker fetches once per 24h and caches in chrome.storage.local.
// All functions fall back to DEFAULTS silently if remote is unavailable.

export interface ModelSelectors {
  /** CSS selectors for the text input, tried in order until one matches. */
  inputSelectors: string[]
  /** CSS selectors for the submit button (fallback injection trigger). */
  submitSelectors: string[]
}

interface RemoteConfig {
  version: number
  models: Record<string, ModelSelectors>
}

// ─── Defaults ────────────────────────────────────────────────────────────────
// Update this URL once the public MindRelay repo is set up.
// Until then, the extension always uses DEFAULTS below.
export const REMOTE_CONFIG_URL =
  "https://raw.githubusercontent.com/carthanova/mindrelay/main/config/selectors.json"

const DEFAULTS: RemoteConfig = {
  version: 1,
  models: {
    claude: {
      inputSelectors: [
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"][data-slate-editor="true"]',
        '[data-testid="chat-input"] div[contenteditable="true"]',
        'div[contenteditable="true"]'
      ],
      submitSelectors: [
        'button[aria-label="Send message"]',
        'button[data-testid="send-button"]',
        'button[type="submit"]'
      ]
    },
    chatgpt: {
      inputSelectors: [
        "#prompt-textarea",
        'div[contenteditable="true"]#prompt-textarea',
        'div[contenteditable="true"]'
      ],
      submitSelectors: [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="send"]'
      ]
    },
    gemini: {
      inputSelectors: [
        "rich-textarea .ql-editor",
        "div.ql-editor",
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"]'
      ],
      submitSelectors: [
        'button[aria-label*="Send"]',
        'button[aria-label*="send"]',
        'button.send-button',
        'button[data-testid*="send"]'
      ]
    },
    grok: {
      inputSelectors: [
        'div[contenteditable="true"]',
        "textarea"
      ],
      submitSelectors: [
        'button[aria-label*="Send"]',
        'button[aria-label*="send"]',
        'button[type="submit"]'
      ]
    }
  }
}

// ─── Storage key ─────────────────────────────────────────────────────────────

const CONFIG_STORAGE_KEY = "mindrelay_remote_config"

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getModelSelectors(model: string): Promise<ModelSelectors> {
  try {
    const stored = await chrome.storage.local.get(CONFIG_STORAGE_KEY)
    const remote = stored[CONFIG_STORAGE_KEY] as RemoteConfig | undefined
    if (remote?.models?.[model]) return remote.models[model]
  } catch {}
  return DEFAULTS.models[model] ?? {
    inputSelectors: ['div[contenteditable="true"]'],
    submitSelectors: []
  }
}

// ─── Fetch & cache (called from background) ───────────────────────────────────

export async function fetchAndCacheConfig(): Promise<void> {
  try {
    const res = await fetch(REMOTE_CONFIG_URL, { cache: "no-store" })
    if (!res.ok) return
    const data = await res.json() as RemoteConfig
    if (!data?.version || !data?.models) return
    await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: data })
  } catch {
    // Network unavailable or bad JSON — silently keep existing cache / defaults
  }
}
