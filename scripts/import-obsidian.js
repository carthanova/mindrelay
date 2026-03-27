#!/usr/bin/env node
/**
 * Converts Obsidian AI Memory conversation files into MemoryMesh import format.
 * Run: node scripts/import-obsidian.js
 * Output: memorymesh-import.json (load this via the popup Import button)
 */

const fs = require("fs")
const path = require("path")

const VAULT_PATH = "/Users/ccartagena79/Documents/Obsidian/AI Memory/Conversations"
const OUTPUT_PATH = path.join(__dirname, "../memorymesh-import.json")

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) return {}
  const dateMatch = match[1].match(/date:\s*(.+)/)
  const tagsMatch = match[1].match(/tags:\s*\[([^\]]+)\]/)
  return {
    date: dateMatch ? dateMatch[1].trim() : null,
    tags: tagsMatch ? tagsMatch[1].split(",").map((t) => t.trim()) : []
  }
}

function extractTitle(content, filename) {
  const h1Match = content.match(/^#\s+(.+)$/m)
  if (h1Match) return h1Match[1].trim()
  // Fall back to humanized filename
  return filename
    .replace(/^conversation_/, "")
    .replace(/_\d{4}-\d{2}-\d{2}\.md$/, "")
    .replace(/_/g, " ")
}

function stripFrontmatter(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n/, "").trim()
}

const files = fs.readdirSync(VAULT_PATH).filter((f) => f.endsWith(".md"))
const transcripts = []

for (const filename of files) {
  const filepath = path.join(VAULT_PATH, filename)
  const raw = fs.readFileSync(filepath, "utf-8")

  const { date, tags } = extractFrontmatter(raw)
  const title = extractTitle(raw, filename)
  const body = stripFrontmatter(raw)
  const timestamp = date ? new Date(date).getTime() : Date.now()

  transcripts.push({
    id: `obsidian_${filename.replace(".md", "")}`,
    source: "obsidian",
    title,
    messages: [{ role: "assistant", content: body }],
    markdown: raw,
    timestamp,
    url: filepath
  })

  console.log(`  ✓ ${title}`)
}

// Sort newest first
transcripts.sort((a, b) => b.timestamp - a.timestamp)

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(transcripts, null, 2))
console.log(`\nExported ${transcripts.length} conversations → memorymesh-import.json`)
console.log(`\nNext: open the MemoryMesh popup → Import → select memorymesh-import.json`)
