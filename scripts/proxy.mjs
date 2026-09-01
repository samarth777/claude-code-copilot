#!/usr/bin/env node
/**
 * Claude Code ↔ GitHub Copilot Proxy
 *
 * Translates Anthropic Messages API requests into OpenAI Chat Completions
 * format and forwards them to GitHub Copilot. Responses are translated back.
 *
 * Web search: Exa/Parallel MCP (like OpenCode), with DuckDuckGo fallback.
 *
 * Usage:
 *   node scripts/proxy.mjs
 *   ANTHROPIC_BASE_URL=http://localhost:18080 ANTHROPIC_API_KEY=copilot-proxy claude
 */

import { createServer } from "node:http"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// ─── Constants ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.COPILOT_PROXY_PORT || "18080", 10)
const AUTH_FILE = process.env.COPILOT_AUTH_FILE || join(homedir(), ".claude-copilot-auth.json")
const COPILOT_API_BASE = "https://api.githubcopilot.com"
const USER_AGENT = "claude-code-copilot-provider/1.0.0"
const EDITOR_VERSION = process.env.COPILOT_EDITOR_VERSION || "vscode/1.99.0"
const COPILOT_INTEGRATION_ID = process.env.COPILOT_INTEGRATION_ID || "vscode-chat"
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || ""
const SERPER_API_KEY = process.env.SERPER_API_KEY || ""
const WEB_SEARCH_MAX_RESULTS = parseInt(process.env.WEB_SEARCH_MAX_RESULTS || "5", 10)
// Upper bound on the client-supplied web_search max_uses. Every search round is
// a billed Copilot completion, so this caps the blast radius of one request.
const WEB_SEARCH_MAX_USES_CAP = parseInt(process.env.WEB_SEARCH_MAX_USES_CAP || "10", 10)
const COPILOT_REQUEST_TIMEOUT_MS = parseInt(process.env.COPILOT_REQUEST_TIMEOUT_MS || "120000", 10)
// Retry transient Copilot failures (429 / 5xx / network / timeout) with
// exponential backoff. Set COPILOT_MAX_RETRIES=0 to disable.
const COPILOT_MAX_RETRIES = parseInt(process.env.COPILOT_MAX_RETRIES || "3", 10)
// Proactive self-throttle: minimum spacing between requests sent to Copilot.
// Default 0 (disabled) — opt in via COPILOT_MIN_REQUEST_INTERVAL_MS to pace
// heavy parallel-subagent workloads and avoid 429s before they happen.
const COPILOT_MIN_REQUEST_INTERVAL_MS = parseInt(process.env.COPILOT_MIN_REQUEST_INTERVAL_MS || "0", 10)
// Forward Claude Code's reasoning depth (adaptive-thinking effort or legacy
// thinking budget) as OpenAI reasoning_effort. Copilot's Claude models accept
// low/medium/high/xhigh/max; the observable effect is currently modest and
// Copilot does not return separate reasoning tokens. Set
// COPILOT_FORWARD_REASONING=0 to stop sending it.
const FORWARD_REASONING = process.env.COPILOT_FORWARD_REASONING !== "0"

// ─── Web Search: MCP Providers (Exa + Parallel) ────────────────────────────

const EXA_URL = "https://mcp.exa.ai/mcp"
const PARALLEL_URL = "https://search.parallel.ai/mcp"
const WEBSEARCH_PROVIDER = process.env.WEBSEARCH_PROVIDER || "" // "exa" | "parallel" | ""

function simpleChecksum(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

function selectProvider(query) {
  const override = WEBSEARCH_PROVIDER.toLowerCase()
  if (override === "exa") return "exa"
  if (override === "parallel") return "parallel"
  const hasExa = !!process.env.EXA_API_KEY
  const hasParallel = !!process.env.PARALLEL_API_KEY
  if (hasParallel && !hasExa) return "parallel"
  if (hasExa && !hasParallel) return "exa"
  return parseInt(simpleChecksum(query), 36) % 2 === 0 ? "exa" : "parallel"
}

function parseMcpResponse(body) {
  try {
    const json = JSON.parse(body)
    if (json.result && json.result.content) return json.result.content
    if (json.error) {
      console.warn(`⚠ MCP error: ${JSON.stringify(json.error)}`)
      return null
    }
    return null
  } catch { /* not JSON */ }

  const lines = body.split("\n")
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice(6).trim()
    if (!data || data === "[DONE]") continue
    try {
      const json = JSON.parse(data)
      if (json.result && json.result.content) return json.result.content
    } catch { continue }
  }
  return null
}

async function callMcp(url, toolName, args, headers = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 25000)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.warn(`⚠ MCP ${toolName} HTTP error: ${res.status}`)
      return null
    }
    const body = await res.text()
    return parseMcpResponse(body)
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn(`⚠ MCP ${toolName} timed out (25s)`)
    } else {
      console.warn(`⚠ MCP ${toolName} error: ${err.message}`)
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function mcpContentToResults(content) {
  if (!content || !Array.isArray(content)) return null
  const results = []
  for (const item of content) {
    if (item.type !== "text" || !item.text) continue

    // Try JSON first
    try {
      const parsed = JSON.parse(item.text)
      // Handle Parallel format: { results: [{url, title, excerpts}] }
      const items = parsed.results && Array.isArray(parsed.results)
        ? parsed.results
        : Array.isArray(parsed) ? parsed : [parsed]
      for (const r of items) {
        if (!r.url) continue
        const snippet = r.content || r.text || r.snippet || r.description
          || (Array.isArray(r.excerpts) ? r.excerpts.join("\n") : "")
        results.push({
          type: "web_search_result",
          url: r.url,
          title: r.title || "",
          encrypted_content: Buffer.from(snippet).toString("base64"),
          page_age: r.publishedDate || r.publish_date || r.age || null,
        })
        if (results.length >= WEB_SEARCH_MAX_RESULTS) break
      }
    } catch {
      // Not JSON — parse Exa's plain text format:
      // Title: ...\nURL: ...\nPublished: ...\nHighlights:\n...\n---\n
      const blocks = item.text.split(/\n---\n/)
      for (const block of blocks) {
        const urlMatch = block.match(/URL:\s*(.+)/)
        const titleMatch = block.match(/Title:\s*(.+)/)
        const highlightsMatch = block.match(/Highlights:\n([\s\S]*)/)
        if (urlMatch) {
          results.push({
            type: "web_search_result",
            url: urlMatch[1].trim(),
            title: titleMatch ? titleMatch[1].trim() : "",
            encrypted_content: Buffer.from(
              highlightsMatch ? highlightsMatch[1].trim() : block.trim()
            ).toString("base64"),
            page_age: null,
          })
          if (results.length >= WEB_SEARCH_MAX_RESULTS) break
        }
      }
    }
    if (results.length >= WEB_SEARCH_MAX_RESULTS) break
  }
  return results.length > 0 ? results : null
}

async function exaSearch(query) {
  const apiKey = process.env.EXA_API_KEY || ""
  const url = apiKey ? `${EXA_URL}?exaApiKey=${encodeURIComponent(apiKey)}` : EXA_URL
  const content = await callMcp(url, "web_search_exa", {
    query,
    numResults: WEB_SEARCH_MAX_RESULTS,
    type: "auto",
    livecrawl: "auto",
  })
  const results = mcpContentToResults(content)
  if (results) console.log(`✓ Exa returned ${results.length} results`)
  return results
}

async function parallelSearch(query) {
  const apiKey = process.env.PARALLEL_API_KEY || ""
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  const content = await callMcp(PARALLEL_URL, "web_search", {
    objective: query,
    search_queries: [query],
  }, headers)
  const results = mcpContentToResults(content)
  if (results) console.log(`✓ Parallel returned ${results.length} results`)
  return results
}

async function mcpSearch(query) {
  const provider = selectProvider(query)
  if (provider === "exa") {
    const results = await exaSearch(query)
    if (results) return results
    console.warn("⚠ Exa failed, trying Parallel...")
    return await parallelSearch(query)
  } else {
    const results = await parallelSearch(query)
    if (results) return results
    console.warn("⚠ Parallel failed, trying Exa...")
    return await exaSearch(query)
  }
}

// ─── Web Search: Brave ──────────────────────────────────────────────────────

async function braveSearch(query) {
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${WEB_SEARCH_MAX_RESULTS}`,
      {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": BRAVE_API_KEY,
        },
      },
    )
    if (!res.ok) {
      console.warn(`⚠ Brave HTTP error: ${res.status}`)
      return null
    }
    const data = await res.json()
    const webResults = data.web?.results || []
    const results = webResults.slice(0, WEB_SEARCH_MAX_RESULTS).map((r) => ({
      type: "web_search_result",
      url: r.url,
      title: r.title || "",
      encrypted_content: Buffer.from(r.description || "").toString("base64"),
      page_age: r.age || null,
    }))
    if (results.length > 0) {
      console.log(`✓ Brave returned ${results.length} results`)
      return results
    }
    return null
  } catch (err) {
    console.warn(`⚠ Brave error: ${err.message}`)
    return null
  }
}

// ─── Web Search: Serper (Google SERP API) ───────────────────────────────────

async function serperSearch(query) {
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: WEB_SEARCH_MAX_RESULTS }),
    })
    if (!res.ok) {
      console.warn(`⚠ Serper HTTP error: ${res.status}`)
      return null
    }
    const data = await res.json()
    const organic = data.organic || []
    const results = organic.slice(0, WEB_SEARCH_MAX_RESULTS).map((r) => ({
      type: "web_search_result",
      url: r.link || "",
      title: r.title || "",
      encrypted_content: Buffer.from(r.snippet || "").toString("base64"),
      page_age: null,
    }))
    if (results.length > 0) {
      console.log(`✓ Serper returned ${results.length} results`)
      return results
    }
    return null
  } catch (err) {
    console.warn(`⚠ Serper error: ${err.message}`)
    return null
  }
}

// ─── Web Search: DuckDuckGo Fallback ────────────────────────────────────────

async function duckDuckGoLiteSearch(query) {
  try {
    const res = await fetch("https://lite.duckduckgo.com/lite/", {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: `q=${encodeURIComponent(query)}&kl=us-en`,
      redirect: "follow",
    })
    if (!res.ok) {
      console.warn(`⚠ DDG Lite HTTP error: ${res.status}`)
      return null
    }
    const html = await res.text()
    if (html.includes("captcha") || html.includes("anomaly") || html.includes("challenge")) {
      console.warn("⚠ DDG Lite returned CAPTCHA")
      return null
    }
    const linkRegex = /<a rel="nofollow" href="([^"]+)" class='result-link'>/g
    const snippetRegex = /<td class='result-snippet'>([\s\S]*?)<\/td>/g
    const links = []
    const snippets = []
    let match
    while ((match = linkRegex.exec(html)) !== null) links.push(match[1])
    while ((match = snippetRegex.exec(html)) !== null) snippets.push(match[1])
    const decode = (s) =>
      s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#92;/g, "\\")
        .replace(/<\/?b>/g, "")
    const results = links.slice(0, WEB_SEARCH_MAX_RESULTS).map((url, i) => ({
      type: "web_search_result",
      url: decode(url),
      title: "",
      encrypted_content: Buffer.from(decode(snippets[i] || "")).toString("base64"),
      page_age: null,
    }))
    if (results.length > 0) {
      console.log(`✓ DDG Lite returned ${results.length} results`)
      return results
    }
    return null
  } catch (err) {
    console.warn(`⚠ DDG Lite error: ${err.message}`)
    return null
  }
}

async function duckDuckGoInstantAnswer(query) {
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": USER_AGENT } },
    )
    if (!res.ok) return null
    const data = await res.json()
    const results = []
    if (data.AbstractURL && data.AbstractText) {
      results.push({
        type: "web_search_result",
        url: data.AbstractURL,
        title: data.Heading || "",
        encrypted_content: Buffer.from(data.AbstractText).toString("base64"),
        page_age: null,
      })
    }
    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics) {
        if (results.length >= WEB_SEARCH_MAX_RESULTS) break
        if (!topic.FirstURL || !topic.Text) continue
        results.push({
          type: "web_search_result",
          url: topic.FirstURL,
          title: (topic.Text || "").slice(0, 100),
          encrypted_content: Buffer.from(topic.Text || "").toString("base64"),
          page_age: null,
        })
      }
    }
    if (results.length > 0) {
      console.log(`✓ DDG Instant returned ${results.length} results`)
      return results
    }
    return null
  } catch (err) {
    console.warn(`⚠ DDG Instant error: ${err.message}`)
    return null
  }
}

// ─── Web Search: Main Orchestrator ──────────────────────────────────────────

// Search result cache (deduplicates identical queries across parallel agents)
const searchCache = new Map()
const SEARCH_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const SEARCH_CACHE_MAX_ENTRIES = 500 // bound memory over the proxy's lifetime

// Concurrency semaphore (prevents DDG/API rate-limit storms from parallel agents)
const MAX_CONCURRENT_SEARCHES = 2
let activeSearchCount = 0
const searchWaitQueue = []

async function executeWebSearch(query) {
  console.log(`🔍 Web search: "${query}"`)

  // 1. Exa/Parallel MCP (primary — free, no quota)
  const mcpResults = await mcpSearch(query)
  if (mcpResults && mcpResults.length > 0) return mcpResults

  // 2. Brave (if configured)
  if (BRAVE_API_KEY) {
    console.warn("⚠ MCP providers failed, trying Brave...")
    const results = await braveSearch(query)
    if (results && results.length > 0) return results
  }

  // 3. Serper (if configured — paid fallback, saves free credits)
  if (SERPER_API_KEY) {
    console.warn("⚠ Trying Serper (Google SERP)...")
    const results = await serperSearch(query)
    if (results && results.length > 0) return results
  }

  // 4. DuckDuckGo Lite (free fallback)
  console.warn("⚠ Trying DuckDuckGo Lite...")
  const ddgLiteResults = await duckDuckGoLiteSearch(query)
  if (ddgLiteResults && ddgLiteResults.length > 0) return ddgLiteResults

  // 5. DuckDuckGo Instant Answer (last resort)
  console.warn("⚠ DDG Lite failed, trying Instant Answer API...")
  const instantResults = await duckDuckGoInstantAnswer(query)
  if (instantResults && instantResults.length > 0) return instantResults

  console.warn("⚠ All search providers failed")
  return []
}

// Throttled wrapper: cache + concurrency gate
async function executeWebSearchThrottled(query) {
  // Check cache first
  const cached = searchCache.get(query)
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
    console.log(`📋 Search cache hit: "${query.slice(0, 50)}..."`)
    return cached.results
  }

  // Concurrency gate — wait if too many searches are in flight.
  // `while`, not `if`: being woken only means a slot was released, not that it
  // is still free. Between the release and this task resuming, a fresh caller
  // can take the slot (it sees the decremented count and never queues), so a
  // woken waiter must re-check or the limit is exceeded.
  while (activeSearchCount >= MAX_CONCURRENT_SEARCHES) {
    console.log(`⏳ Search queued (${activeSearchCount}/${MAX_CONCURRENT_SEARCHES} active): "${query.slice(0, 50)}..."`)
    await new Promise((resolve) => searchWaitQueue.push(resolve))
  }
  activeSearchCount++
  try {
    const results = await executeWebSearch(query)
    // Only cache non-empty results — caching [] would suppress a query for the
    // full TTL after a transient all-providers-fail, blinding parallel agents.
    if (results && results.length > 0) {
      // Evict expired entries, then bound total size (oldest-first) before insert.
      const now = Date.now()
      for (const [k, v] of searchCache) {
        if (now - v.ts >= SEARCH_CACHE_TTL) searchCache.delete(k)
      }
      while (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
        searchCache.delete(searchCache.keys().next().value)
      }
      searchCache.set(query, { results, ts: now })
    }
    return results
  } finally {
    activeSearchCount--
    if (searchWaitQueue.length > 0) {
      searchWaitQueue.shift()()
    }
  }
}

// ─── Web Search Loop ────────────────────────────────────────────────────────

// Transient statuses worth retrying (rate limit + gateway/server errors).
// 400/401/403/404 are deliberately excluded — they will not self-heal.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

// Self-throttle state: serialize the min-interval check so concurrent callers
// (parallel subagents) queue behind one another instead of all firing at once.
let throttleChainTail = Promise.resolve()
let lastRequestSentAt = 0

// Block until at least COPILOT_MIN_REQUEST_INTERVAL_MS has elapsed since the
// previous request was released. No-op when the interval is 0 (default).
function throttleGate() {
  if (COPILOT_MIN_REQUEST_INTERVAL_MS <= 0) return Promise.resolve()
  const wait = throttleChainTail.then(async () => {
    const now = Date.now()
    const elapsed = now - lastRequestSentAt
    const delay = COPILOT_MIN_REQUEST_INTERVAL_MS - elapsed
    if (delay > 0) await sleep(delay)
    lastRequestSentAt = Date.now()
  })
  // Advance the chain even if this link rejects, so the queue never wedges.
  throttleChainTail = wait.catch(() => {})
  return wait
}

// Wrap a body-phase read so a stalled upstream cannot hang the proxy forever.
// The per-attempt timeout in fetchCopilotWithRetry is cleared once response
// headers arrive, which leaves the body read — res.json() or the SSE reader
// loop — completely unguarded. This is an *idle* timeout: it is armed per read,
// so a long but actively-streaming response is never cut off, while an upstream
// that goes silent mid-body fails fast instead of holding the client open.
function withIdleTimeout(promise, ms, label) {
  if (!(ms > 0)) return promise
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Copilot ${label} stalled after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

// POST to Copilot's chat/completions with per-attempt timeout and exponential
// backoff on transient failures. Returns the fetch Response (body untouched, so
// streaming callers can read it). Throws a tagged Error only after retries are
// exhausted or on a non-retryable network error.
async function fetchCopilotWithRetry(headers, bodyStr) {
  let lastErr
  for (let attempt = 0; attempt <= COPILOT_MAX_RETRIES; attempt++) {
    await throttleGate()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), COPILOT_REQUEST_TIMEOUT_MS)
    let res
    try {
      res = await fetch(`${COPILOT_API_BASE}/chat/completions`, {
        method: "POST",
        headers,
        body: bodyStr,
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      lastErr = new Error(err.name === "AbortError"
        ? `Copilot request timed out after ${COPILOT_REQUEST_TIMEOUT_MS}ms`
        : `Copilot request failed: ${err.message}`)
      if (attempt < COPILOT_MAX_RETRIES) {
        await sleep(backoffDelayMs(attempt, null))
        console.warn(`⚠ Copilot fetch error, retry ${attempt + 1}/${COPILOT_MAX_RETRIES}: ${err.message}`)
        continue
      }
      throw lastErr
    }
    clearTimeout(timeout)

    if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt === COPILOT_MAX_RETRIES) {
      return res
    }
    // Retryable status: drain body, honor Retry-After on 429, back off.
    const retryAfter = res.status === 429 ? parseRetryAfterMs(res.headers.get("retry-after")) : null
    res.body?.cancel?.().catch(() => {})
    console.warn(`⚠ Copilot ${res.status}, retry ${attempt + 1}/${COPILOT_MAX_RETRIES} in ${Math.round(backoffDelayMs(attempt, retryAfter))}ms`)
    await sleep(backoffDelayMs(attempt, retryAfter))
  }
  throw lastErr || new Error("Copilot request failed after retries")
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Exponential backoff with full jitter, capped at 8s. A Retry-After hint (ms)
// takes precedence when the server provides one. Randomized per call so
// concurrent requests hit by the same rate limit decorrelate instead of
// retrying in lockstep.
function backoffDelayMs(attempt, retryAfterMs) {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 30000)
  const base = Math.min(1000 * 2 ** attempt, 8000)
  return Math.floor(base * (0.5 + Math.random() * 0.5))
}

// Parse an HTTP Retry-After header (seconds or HTTP-date) into milliseconds.
function parseRetryAfterMs(value) {
  if (!value) return null
  const secs = Number(value)
  if (!Number.isNaN(secs)) return secs * 1000
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

async function collectCopilotResponse(openaiReq, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "Editor-Version": EDITOR_VERSION,
    "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
    "Openai-Intent": "conversation-edits",
  }
  const bodyStr = JSON.stringify({ ...openaiReq, stream: false })
  if (bodyStr.includes("image_url")) {
    headers["Copilot-Vision-Request"] = "true"
  }
  const res = await fetchCopilotWithRetry(headers, bodyStr)
  if (!res.ok) {
    const text = await withIdleTimeout(res.text(), COPILOT_REQUEST_TIMEOUT_MS, "error body read")
    throw new Error(`Copilot ${res.status}: ${text}`)
  }
  return withIdleTimeout(res.json(), COPILOT_REQUEST_TIMEOUT_MS, "body read")
}

async function handleWebSearchLoop(openaiReq, token, maxSearches) {
  const contentBlocks = []
  let searchCount = 0
  let currentReq = { ...openaiReq }
  let lastResponse = null

  // maxSearches comes straight from the client's web_search tool max_uses.
  // Each iteration is a billed Copilot completion, so an unclamped value lets a
  // single request fan out into hundreds of them. Clamp to a sane server limit.
  const requested = Number.isFinite(maxSearches) && maxSearches > 0 ? Math.floor(maxSearches) : 5
  const effectiveMax = Math.min(requested, WEB_SEARCH_MAX_USES_CAP)
  if (requested > effectiveMax) {
    console.warn(`⚠ web_search max_uses ${requested} exceeds cap, clamping to ${effectiveMax}`)
  }

  for (let iteration = 0; iteration < effectiveMax + 1; iteration++) {
    lastResponse = await collectCopilotResponse(currentReq, token)
    const choice = lastResponse.choices?.[0]

    const webSearchCall = choice?.message?.tool_calls?.find(
      (tc) => tc.function?.name === "web_search",
    )

    if (!webSearchCall || searchCount >= (maxSearches || 5)) {
      // No web search requested — append final content
      if (choice?.message?.content) {
        contentBlocks.push({ type: "text", text: choice.message.content })
      }
      // Append any non-web-search tool calls
      if (choice?.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          if (tc.function?.name === "web_search") continue
          let input = {}
          try { input = JSON.parse(tc.function.arguments || "{}") } catch {}
          contentBlocks.push({
            type: "tool_use",
            id: tc.id || `toolu_${Date.now()}`,
            name: tc.function.name,
            input,
          })
        }
      }
      break
    }

    // Execute web search
    searchCount++
    let searchQuery = ""
    try {
      const args = JSON.parse(webSearchCall.function.arguments || "{}")
      searchQuery = args.query || args.q || ""
    } catch {
      searchQuery = ""
    }

    if (!searchQuery) {
      contentBlocks.push({ type: "text", text: choice.message?.content || "" })
      break
    }

    const searchResults = await executeWebSearchThrottled(searchQuery)

    // Add search tool use block
    contentBlocks.push({
      type: "server_tool_use",
      id: `srvtoolu_search_${searchCount}`,
      name: "web_search",
      input: { query: searchQuery },
    })

    // Add search results block
    contentBlocks.push({
      type: "web_search_tool_result",
      tool_use_id: `srvtoolu_search_${searchCount}`,
      content: searchResults,
    })

    // Build follow-up messages with search results
    const searchResultsText = searchResults
      .map((r) => `[${r.title || r.url}](${r.url})\n${Buffer.from(r.encrypted_content, "base64").toString("utf8")}`)
      .join("\n\n")

    const followUpMessages = [
      ...currentReq.messages,
      {
        role: "assistant",
        content: choice.message?.content || null,
        tool_calls: [webSearchCall],
      },
      {
        role: "tool",
        tool_call_id: webSearchCall.id,
        content: `Search results for "${searchQuery}":\n\n${searchResultsText}`,
      },
    ]

    currentReq = { ...currentReq, messages: followUpMessages }
  }

  return { contentBlocks, lastResponse, searchCount }
}

// ─── Model Mapping ──────────────────────────────────────────────────────────

// Derive an OpenAI `reasoning_effort` from an Anthropic Messages request.
// Modern Claude Code uses adaptive thinking and sends the depth in
// `output_config.effort` (e.g. low/medium/high/max); older versions used
// manual extended thinking (`thinking.type:"enabled"` + `budget_tokens`).
// Copilot's Claude models accept low/medium/high/xhigh/max but reject
// none/minimal, so those are clamped up to "low". Returns null when no
// reasoning signal is present.
function reasoningEffortFromRequest(anthropicReq) {
  // Preferred: adaptive-thinking effort (current Claude Code)
  const effort = anthropicReq.output_config?.effort
  if (typeof effort === "string" && effort) {
    if (effort === "none" || effort === "minimal") return "low"
    return effort // low | medium | high | xhigh | max — passed through
  }
  // Fallback: deprecated manual extended thinking with a token budget
  const thinking = anthropicReq.thinking
  if (thinking && thinking.type === "enabled") {
    const budget = Number(thinking.budget_tokens) || 0
    if (budget <= 0) return null
    if (budget <= 4096) return "low"
    if (budget <= 16384) return "medium"
    return "high"
  }
  return null
}

// Whether a resolved Copilot model accepts the OpenAI reasoning_effort param.
// Verified live against the Copilot API: opus and sonnet Claude models accept
// low/medium/high/xhigh/max; Haiku rejects it with a 400. Unknown models are
// treated as unsupported so a new model never 400s on an effort we guessed wrong.
function modelSupportsReasoningEffort(copilotModel) {
  const m = (copilotModel || "").toLowerCase()
  if (m.includes("haiku")) return false
  return m.includes("opus") || m.includes("sonnet")
}

const MODEL_MAP = {
  // Opus — Copilot supports 4.6, 4.7, 4.8, 5
  "claude-opus-5": "claude-opus-5",
  "claude-opus-5-latest": "claude-opus-5",
  "claude-opus-4-8": "claude-opus-4.8",
  "claude-opus-4-8-20260610": "claude-opus-4.8",
  "claude-opus-4-8-latest": "claude-opus-4.8",
  "claude-opus-4-7": "claude-opus-4.7",
  "claude-opus-4-7-latest": "claude-opus-4.7",
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4-6-20260214": "claude-opus-4.6",
  "claude-opus-4-6-latest": "claude-opus-4.6",
  // Older Opus → nearest supported (4.6)
  "claude-opus-4-5": "claude-opus-4.6",
  "claude-opus-4-5-20251101": "claude-opus-4.6",
  "claude-opus-4-5-latest": "claude-opus-4.6",
  "claude-opus-4-1": "claude-opus-4.6",
  "claude-opus-4-1-latest": "claude-opus-4.6",
  "claude-opus-4-20250918": "claude-opus-4.6",
  "claude-3-opus-20240229": "claude-opus-4.6",
  "claude-3-5-opus-latest": "claude-opus-4.6",
  // Sonnet — Copilot supports 4.6 and 5
  "claude-sonnet-5": "claude-sonnet-5",
  "claude-sonnet-5-latest": "claude-sonnet-5",
  "claude-sonnet-4-6": "claude-sonnet-4.6",
  "claude-sonnet-4-6-latest": "claude-sonnet-4.6",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4.6",
  "claude-sonnet-4-5": "claude-sonnet-4.6",
  "claude-sonnet-4-5-latest": "claude-sonnet-4.6",
  "claude-sonnet-4-20250514": "claude-sonnet-4.6",
  "claude-sonnet-4": "claude-sonnet-4.6",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4.6",
  "claude-3-5-sonnet-latest": "claude-sonnet-4.6",
  // Haiku — Copilot supports 4.5
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-haiku-4-5-20251001": "claude-haiku-4.5",
  "claude-haiku-4-5-latest": "claude-haiku-4.5",
  "claude-haiku-4-20250414": "claude-haiku-4.5",
  "claude-3-5-haiku-20241022": "claude-haiku-4.5",
  "claude-3-haiku-20240307": "claude-haiku-4.5",
}

function mapModel(model) {
  if (MODEL_MAP[model]) return MODEL_MAP[model]
  const m = model.toLowerCase()
  // Sonnet — newest supported is 5, then 4.6.
  // Match the major version right after the "sonnet" token so "sonnet-5" maps to 5,
  // but "sonnet-4-5" / "3-5-sonnet" / dated 4.5 builds map to 4.6 (not silently upgraded).
  if (m.includes("sonnet")) {
    const major = m.match(/sonnet[-_ ]?(\d+)/)
    return major && major[1] === "5" ? "claude-sonnet-5" : "claude-sonnet-4.6"
  }
  // Opus — Copilot supports 4.6, 4.7, 4.8, 5. Match the major version right
  // after the "opus" token so "opus-5" maps to 5, but "opus-4-5"/"opus-4.5"
  // maps by its 4.x tier (not silently upgraded to 5).
  if (m.includes("opus")) {
    const major = m.match(/opus[-_ ]?(\d+)/)
    if (major && major[1] === "5") return "claude-opus-5"
    if (m.includes("4.8") || m.includes("4-8")) return "claude-opus-4.8"
    if (m.includes("4.7") || m.includes("4-7")) return "claude-opus-4.7"
    return "claude-opus-4.6"
  }
  // Haiku
  if (m.includes("haiku")) return "claude-haiku-4.5"
  return model
}

// ─── Auth ───────────────────────────────────────────────────────────────────

function loadAuth() {
  if (!existsSync(AUTH_FILE)) {
    console.error(`❌ Auth file not found: ${AUTH_FILE}`)
    console.error("   Run: node scripts/auth.mjs")
    process.exit(1)
  }
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf8"))
    if (!data.access_token) {
      console.error("❌ No access_token in auth file")
      process.exit(1)
    }
    return data.access_token
  } catch (err) {
    console.error(`❌ Failed to parse auth file: ${err.message}`)
    process.exit(1)
  }
}

// ─── Message Translation (Anthropic → OpenAI) ───────────────────────────────

// Estimate input tokens from an Anthropic Messages request body.
// Extracts the actual natural-language text (system + message content + tool
// schemas) and applies ~4 chars/token, rather than counting raw JSON bytes.
// Claude Code calls /count_tokens to decide when to auto-compact, so this
// should track real usage reasonably closely.
function estimateTokens(body) {
  let text = ""
  try {
    const req = JSON.parse(body)
    const walk = (v) => {
      if (v == null) return
      if (typeof v === "string") { text += v + " "; return }
      if (Array.isArray(v)) { v.forEach(walk); return }
      if (typeof v === "object") {
        // Only descend into fields that carry natural-language or schema text
        if (typeof v.text === "string") text += v.text + " "
        if (typeof v.content !== "undefined") walk(v.content)
        if (typeof v.input !== "undefined") text += JSON.stringify(v.input) + " "
      }
    }
    if (req.system) walk(req.system)
    if (req.messages) walk(req.messages)
    if (req.tools) text += JSON.stringify(req.tools) + " "
  } catch {
    // Fall back to raw length if body isn't parseable JSON
    text = body
  }
  return Math.max(1, Math.ceil(text.length / 4))
}

// Convert an Anthropic image block's `source` into a URL usable in an OpenAI
// image_url part. Anthropic supports both base64 and url sources; assuming
// base64 produced "data:undefined;base64,undefined" for url-sourced images.
// Returns null for a shape we cannot represent, so callers can drop the block
// rather than send a corrupt one.
function imageSourceToUrl(source) {
  if (!source) return null
  if (source.type === "url") return source.url || null
  if (source.type === "base64" || source.data) {
    if (!source.data || !source.media_type) return null
    return `data:${source.media_type};base64,${source.data}`
  }
  return null
}

function translateContentPart(part) {
  if (typeof part === "string") return { type: "text", text: part }
  if (part.type === "text") return { type: "text", text: part.text }
  if (part.type === "image") {
    const url = imageSourceToUrl(part.source)
    return url ? { type: "image_url", image_url: { url } } : null
  }
  if (part.type === "tool_use" || part.type === "tool_result") return null
  // Extended-thinking blocks are Anthropic-internal reasoning that Copilot's
  // OpenAI-format API cannot consume; drop them rather than injecting raw JSON.
  if (part.type === "thinking" || part.type === "redacted_thinking") return null
  return { type: "text", text: JSON.stringify(part) }
}

function translateMessages(anthropicMessages, system) {
  const messages = []

  // System prompt
  if (system) {
    const systemText = Array.isArray(system)
      ? system.map((s) => (typeof s === "string" ? s : s.text || "")).join("\n\n")
      : system
    if (systemText) messages.push({ role: "system", content: systemText })
  }

  for (const msg of anthropicMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content })
      } else if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter((p) => p.type === "tool_result")
        const otherParts = msg.content.filter((p) => p.type !== "tool_result")

        // Images returned by a tool cannot ride along in the tool message:
        // Chat Completions only accepts image_url parts on `user` messages
        // ("Image URLs are only allowed for messages with role 'user'"). They
        // used to be JSON.stringify'd into the text, dumping raw base64 into
        // the prompt. Instead, leave a placeholder in the tool result and
        // re-attach the images in a follow-up user message.
        const deferredImages = []

        for (const tr of toolResults) {
          let content
          if (typeof tr.content === "string") {
            content = tr.content
          } else if (Array.isArray(tr.content)) {
            content = tr.content
              .map((c) => {
                if (typeof c === "string") return c
                if (c.type === "text") return c.text
                if (c.type === "image") {
                  const url = imageSourceToUrl(c.source)
                  if (!url) return "[unsupported image omitted]"
                  deferredImages.push({ type: "image_url", image_url: { url } })
                  return "[image returned by tool — attached below]"
                }
                return c.text || JSON.stringify(c)
              })
              .join("\n")
          } else {
            content = JSON.stringify(tr.content || "")
          }
          messages.push({ role: "tool", tool_call_id: tr.tool_use_id, content })
        }

        if (otherParts.length > 0 || deferredImages.length > 0) {
          const translated = otherParts.map(translateContentPart).filter(Boolean)
          const combined = [...translated, ...deferredImages]
          if (combined.length > 0) {
            messages.push({ role: "user", content: combined })
          }
        }
      }
    } else if (msg.role === "assistant") {
      const assistantMsg = { role: "assistant" }
      const textParts = []
      const toolCalls = []

      const content = typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : Array.isArray(msg.content) ? msg.content : []

      for (const block of content) {
        if (block.type === "text") {
          textParts.push(block.text)
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          })
        } else if (block.type === "server_tool_use") {
          // Skip — handled internally
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          // Skip — Anthropic-internal reasoning, not consumable by Copilot
        } else if (block.type === "web_search_tool_result") {
          // Inline search results as context
          if (Array.isArray(block.content)) {
            const ctx = block.content
              .map((r) => `[${r.title || r.url}](${r.url}): ${Buffer.from(r.encrypted_content || "", "base64").toString("utf8")}`)
              .join("\n")
            textParts.push(`[Search Results]\n${ctx}`)
          }
        }
      }

      if (textParts.length > 0) assistantMsg.content = textParts.join("\n")
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
      if (assistantMsg.content || assistantMsg.tool_calls) messages.push(assistantMsg)
    }
  }

  return messages
}

// ─── Tool Translation ───────────────────────────────────────────────────────

function translateTools(anthropicTools) {
  if (!anthropicTools || anthropicTools.length === 0) return undefined
  const tools = anthropicTools
    .filter((t) => t.type !== "web_search_20250305")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }))
  return tools.length > 0 ? tools : undefined
}

function extractWebSearchConfig(anthropicTools) {
  if (!anthropicTools) return { hasWebSearch: false }
  const wsTool = anthropicTools.find((t) => t.type === "web_search_20250305")
  if (!wsTool) return { hasWebSearch: false }
  return {
    hasWebSearch: true,
    maxUses: wsTool.max_uses || 5,
    allowedDomains: wsTool.allowed_domains || null,
    blockedDomains: wsTool.blocked_domains || null,
    userLocation: wsTool.user_location || null,
  }
}

// ─── Response Translation (OpenAI → Anthropic) ──────────────────────────────

// Build an Anthropic-shaped usage object from Copilot's OpenAI usage.
// Copilot's prompt_tokens INCLUDES cached tokens; Anthropic's input_tokens
// EXCLUDES them (cache is a separate bucket). Split them so the total is
// preserved and cache reads are surfaced honestly (0 today; correct if Copilot
// ever enables prompt caching).
function buildAnthropicUsage(openaiUsage) {
  const prompt = openaiUsage?.prompt_tokens || 0
  const cachedRead = openaiUsage?.prompt_tokens_details?.cached_tokens || 0
  return {
    input_tokens: Math.max(0, prompt - cachedRead),
    output_tokens: openaiUsage?.completion_tokens || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cachedRead,
  }
}

function translateResponseToAnthropic(openaiResponse, model) {
  const choice = openaiResponse.choices?.[0]
  const content = []

  if (choice?.message?.content) {
    content.push({ type: "text", text: choice.message.content })
  }

  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {}
      try { input = JSON.parse(tc.function.arguments || "{}") } catch {}
      content.push({
        type: "tool_use",
        id: tc.id || `toolu_${Date.now()}`,
        name: tc.function.name,
        input,
      })
    }
  }

  const finishReason = choice?.finish_reason
  let stopReason = "end_turn"
  if (finishReason === "tool_calls") stopReason = "tool_use"
  else if (finishReason === "length") stopReason = "max_tokens"

  return {
    id: openaiResponse.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: buildAnthropicUsage(openaiResponse.usage),
  }
}

// ─── Streaming Translation ──────────────────────────────────────────────────

function createStreamTranslator(model, res) {
  let messageId = `msg_${Date.now()}`
  let inputTokens = 0
  let outputTokens = 0
  let cachedReadTokens = 0
  let sentStart = false
  let sentStop = false
  const toolCallBuffers = {}
  // Maps the provider's tool_call index (tc.index) to the Anthropic content
  // block index we assigned it. Argument fragments arrive with only tc.index,
  // so this is the only way to route them back to the right block when several
  // tool calls stream concurrently.
  const toolIndexToBlock = {}
  let contentBlockIndex = 0
  let _inTextBlock = false

  function sendSSE(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  function sendStartIfNeeded() {
    if (sentStart) return
    sentStart = true
    sendSSE("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: Math.max(0, inputTokens - cachedReadTokens), output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: cachedReadTokens },
      },
    })
  }

  function closeTextBlock() {
    if (!_inTextBlock) return
    _inTextBlock = false
    sendSSE("content_block_stop", { type: "content_block_stop", index: contentBlockIndex })
    contentBlockIndex++
  }

  function closeToolBlocks() {
    for (const idx of Object.keys(toolCallBuffers)) {
      sendSSE("content_block_stop", { type: "content_block_stop", index: parseInt(idx) })
    }
  }

  return {
    processChunk(chunk) {
      if (!chunk || chunk === "[DONE]") {
        if (sentStop) return true
        sentStop = true
        sendStartIfNeeded()
        closeTextBlock()
        closeToolBlocks()
        sendSSE("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: Math.max(0, inputTokens - cachedReadTokens), output_tokens: outputTokens, cache_read_input_tokens: cachedReadTokens },
        })
        sendSSE("message_stop", { type: "message_stop" })
        return true
      }

      let data
      try { data = typeof chunk === "string" ? JSON.parse(chunk) : chunk } catch { return false }

      if (data.id) messageId = data.id
      if (data.usage) {
        inputTokens = data.usage.prompt_tokens ?? inputTokens
        outputTokens = data.usage.completion_tokens ?? outputTokens
        cachedReadTokens = data.usage.prompt_tokens_details?.cached_tokens ?? cachedReadTokens
      }

      sendStartIfNeeded()

      const delta = data.choices?.[0]?.delta
      const finishReason = data.choices?.[0]?.finish_reason

      if (delta?.content) {
        if (!_inTextBlock) {
          _inTextBlock = true
          sendSSE("content_block_start", {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "text", text: "" },
          })
        }
        sendSSE("content_block_delta", {
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        })
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? Object.keys(toolCallBuffers).length
          if (tc.id) {
            closeTextBlock()
            const blockIdx = contentBlockIndex
            toolIndexToBlock[idx] = blockIdx
            toolCallBuffers[blockIdx] = { id: tc.id, name: tc.function?.name || "", arguments: tc.function?.arguments || "" }
            sendSSE("content_block_start", {
              type: "content_block_start",
              index: blockIdx,
              content_block: { type: "tool_use", id: tc.id, name: tc.function?.name || "", input: {} },
            })
            contentBlockIndex++
            // A first delta may carry both the id and a leading argument
            // fragment; emit it now or those bytes are lost.
            if (tc.function?.arguments) {
              sendSSE("content_block_delta", {
                type: "content_block_delta",
                index: blockIdx,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              })
            }
          } else if (tc.function?.arguments) {
            // Route by the provider's tool index, not insertion order — with
            // parallel tool calls the newest buffer is often the wrong one.
            const bufIdx = toolIndexToBlock[idx]
            if (bufIdx !== undefined) {
              toolCallBuffers[bufIdx].arguments += tc.function.arguments
              sendSSE("content_block_delta", {
                type: "content_block_delta",
                index: bufIdx,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              })
            }
          }
        }
      }

      if (finishReason) {
        if (sentStop) return true
        sentStop = true
        closeTextBlock()
        closeToolBlocks()
        let stopReason = "end_turn"
        if (finishReason === "tool_calls") stopReason = "tool_use"
        else if (finishReason === "length") stopReason = "max_tokens"
        sendSSE("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { input_tokens: Math.max(0, inputTokens - cachedReadTokens), output_tokens: outputTokens, cache_read_input_tokens: cachedReadTokens },
        })
        sendSSE("message_stop", { type: "message_stop" })
        return true
      }

      return false
    },
  }
}

// ─── Request Handler ────────────────────────────────────────────────────────

// Read a request body to completion. Rejects (rather than throwing
// asynchronously into nothing) if the client disconnects mid-upload, so every
// caller must be inside a try/catch. A client that resets the socket partway
// through is routine — not a reason to take the process down.
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString()))
    req.on("error", reject)
    req.on("aborted", () => reject(new Error("client aborted request")))
  })
}

async function handleRequest(req, res, token) {
  const url = req.url || "/"
  console.log(`[${new Date().toISOString()}] ${req.method} ${url}`)

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "*")
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

  // Health check
  if (url === "/health" || url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "ok", provider: "github-copilot" }))
    return
  }

  // Token counting
  if (url.includes("/count_tokens") || url.includes("/token")) {
    try {
      const body = await readRequestBody(req)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ input_tokens: estimateTokens(body) }))
    } catch (err) {
      // Client hung up mid-upload; nothing to reply to.
      console.warn(`⚠ count_tokens body read failed: ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: err.message } }))
      } else {
        res.end()
      }
    }
    return
  }

  // Models
  if (url.includes("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      data: [
        { id: "claude-opus-5", object: "model" },
        { id: "claude-opus-4-8", object: "model" },
        { id: "claude-opus-4-7", object: "model" },
        { id: "claude-opus-4-6", object: "model" },
        { id: "claude-sonnet-5", object: "model" },
        { id: "claude-sonnet-4-6", object: "model" },
        { id: "claude-haiku-4-5", object: "model" },
      ],
    }))
    return
  }

  // Messages endpoint
  if (!url.includes("/messages")) {
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Not found" }))
    return
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Method not allowed" }))
    return
  }

  try {
    // Parse request body
    const body = await readRequestBody(req)
    let anthropicReq
    try {
      anthropicReq = JSON.parse(body)
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON" } }))
      return
    }

    const isStream = anthropicReq.stream === true
    const copilotModel = mapModel(anthropicReq.model || "claude-sonnet-4")
    const wsConfig = extractWebSearchConfig(anthropicReq.tools)

    console.log(`  → model: ${anthropicReq.model} → ${copilotModel} | stream: ${isStream} | max_tokens: ${anthropicReq.max_tokens || 4096}${wsConfig.hasWebSearch ? " | web_search: enabled" : ""}`)

    // Build OpenAI request
    const openaiReq = {
      model: copilotModel,
      messages: translateMessages(anthropicReq.messages || [], anthropicReq.system),
      max_tokens: anthropicReq.max_tokens || 4096,
      stream: isStream,
    }
    // Ask Copilot to include token usage in the final streaming chunk so the
    // proxy can report accurate input_tokens (otherwise usage is often omitted).
    if (isStream) openaiReq.stream_options = { include_usage: true }
    if (anthropicReq.temperature != null) openaiReq.temperature = anthropicReq.temperature
    if (anthropicReq.top_p != null) openaiReq.top_p = anthropicReq.top_p
    if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences

    // Map Anthropic reasoning depth (adaptive effort or legacy thinking budget)
    // -> OpenAI reasoning_effort so the model tracks Claude Code's effort setting.
    // Only sent to models that accept it — Haiku rejects reasoning_effort (400).
    const reasoningEffort = reasoningEffortFromRequest(anthropicReq)
    if (FORWARD_REASONING && reasoningEffort && modelSupportsReasoningEffort(copilotModel)) {
      openaiReq.reasoning_effort = reasoningEffort
    }

    const tools = translateTools(anthropicReq.tools)
    if (tools) openaiReq.tools = tools

    // Add web_search tool for Copilot if Anthropic request uses it
    if (wsConfig.hasWebSearch) {
      if (!openaiReq.tools) openaiReq.tools = []
      openaiReq.tools.push({
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web for up-to-date facts, news, or information. Use when you need current data.",
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "Search query" } },
            required: ["query"],
          },
        },
      })
    }

    const hasImages = JSON.stringify(openaiReq.messages).includes("image_url")

    // ── Web Search Path ──
    if (wsConfig.hasWebSearch) {
      // Only the search loop is recoverable. Once emission starts below, a
      // failure must NOT fall through to the normal path: that would bill a
      // second Copilot completion and call writeHead() on an already-streaming
      // socket. Emission errors propagate to the outer catch instead, which
      // closes cleanly when headers are already sent.
      let searchResult = null
      try {
        searchResult = await handleWebSearchLoop(openaiReq, token, wsConfig.maxUses)
      } catch (err) {
        console.warn(`⚠ Web search loop error: ${err.message}, falling back to normal path`)
        // Remove web_search tool and fall through to the normal path.
        openaiReq.tools = (openaiReq.tools || []).filter((t) => t.function?.name !== "web_search")
        if (openaiReq.tools.length === 0) delete openaiReq.tools
      }

      if (searchResult) {
        const { contentBlocks, lastResponse, searchCount } = searchResult

        if (isStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          })

          const msgId = `msg_${Date.now()}`
          const usage = lastResponse?.usage || {}

          // message_start
          res.write(`event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: msgId, type: "message", role: "assistant", model: anthropicReq.model,
              content: [], stop_reason: null, stop_sequence: null,
              usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
          })}\n\n`)

          // Emit content blocks
          let blockIdx = 0
          for (const block of contentBlocks) {
            if (block.type === "text") {
              res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: blockIdx, content_block: { type: "text", text: "" } })}\n\n`)
              // Send text in chunks
              const text = block.text || ""
              for (let i = 0; i < text.length; i += 50) {
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: blockIdx, delta: { type: "text_delta", text: text.slice(i, i + 50) } })}\n\n`)
              }
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIdx })}\n\n`)
            } else if (block.type === "server_tool_use") {
              res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: blockIdx, content_block: { type: "server_tool_use", id: block.id, name: block.name, input: {} } })}\n\n`)
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })}\n\n`)
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIdx })}\n\n`)
            } else if (block.type === "web_search_tool_result") {
              res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: blockIdx, content_block: block })}\n\n`)
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIdx })}\n\n`)
            } else if (block.type === "tool_use") {
              res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: blockIdx, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } })}\n\n`)
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })}\n\n`)
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIdx })}\n\n`)
            }
            blockIdx++
          }

          // Determine stop reason
          const hasToolUse = contentBlocks.some((b) => b.type === "tool_use")
          const stopReason = hasToolUse ? "tool_use" : "end_turn"

          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 } })}\n\n`)
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`)
          res.end()
          console.log(`  ← stream ${stopReason} | in: ${usage.prompt_tokens || 0} out: ${usage.completion_tokens || 0} | blocks: ${contentBlocks.length} | searches: ${searchCount}`)
        } else {
          // Non-streaming web search response
          const hasToolUse = contentBlocks.some((b) => b.type === "tool_use")
          const usage = lastResponse?.usage || {}
          const response = {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            model: anthropicReq.model,
            content: contentBlocks,
            stop_reason: hasToolUse ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: buildAnthropicUsage(usage),
          }
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify(response))
          console.log(`  ← ${response.stop_reason} | in: ${response.usage.input_tokens} out: ${response.usage.output_tokens} | blocks: ${contentBlocks.length} | searches: ${searchCount}`)
        }
        return
      }
    }

    // ── Normal (non-web-search) Path ──
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "Editor-Version": EDITOR_VERSION,
      "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
      "Openai-Intent": "conversation-edits",
    }
    if (hasImages) headers["Copilot-Vision-Request"] = "true"

    let copilotRes
    try {
      copilotRes = await fetchCopilotWithRetry(headers, JSON.stringify(openaiReq))
    } catch (err) {
      console.error(`❌ ${err.message}`)
      res.writeHead(504, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }))
      return
    }

    if (!copilotRes.ok) {
      const errText = await withIdleTimeout(copilotRes.text(), COPILOT_REQUEST_TIMEOUT_MS, "error body read")
      let errType = "api_error"
      if (copilotRes.status === 401) errType = "authentication_error"
      else if (copilotRes.status === 429) errType = "rate_limit_error"
      else if (copilotRes.status === 403) errType = "permission_error"

      res.writeHead(copilotRes.status, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ type: "error", error: { type: errType, message: errText } }))
      return
    }

    if (isStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })

      const translator = createStreamTranslator(anthropicReq.model, res)
      const reader = copilotRes.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      try {
        while (true) {
          const { done, value } = await withIdleTimeout(reader.read(), COPILOT_REQUEST_TIMEOUT_MS, "stream read")
          if (done) {
            translator.processChunk(null)
            break
          }

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith("data: ")) continue
            const data = trimmed.slice(6)
            if (data === "[DONE]") {
              translator.processChunk("[DONE]")
              break
            }
            try {
              const parsed = JSON.parse(data)
              const isDone = translator.processChunk(parsed)
              if (isDone) break
            } catch { continue }
          }
        }
      } catch (err) {
        // Stream broke after headers were already sent — emit a proper
        // terminator so Claude Code sees a clean end instead of a truncated stream.
        console.error(`❌ Stream error: ${err.message}`)
        translator.processChunk(null)
      }

      res.end()
      console.log(`  ← stream complete`)
    } else {
      const data = await withIdleTimeout(copilotRes.json(), COPILOT_REQUEST_TIMEOUT_MS, "body read")
      const response = translateResponseToAnthropic(data, anthropicReq.model)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(response))
      console.log(`  ← ${response.stop_reason} | in: ${response.usage.input_tokens} out: ${response.usage.output_tokens}`)
    }
  } catch (err) {
    console.error(`❌ Error: ${err.message}`)
    // Headers are already on the wire for a streaming response, so writeHead
    // would throw ERR_HTTP_HEADERS_SENT on top of the original error and
    // corrupt the connection. Close cleanly instead.
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }))
  }
}

// ─── Server Setup ───────────────────────────────────────────────────────────

// Exported for tests (scripts/test-streaming.mjs). The server below only boots
// when this file is executed directly, so importing it has no side effects.
export { createStreamTranslator, translateMessages, translateContentPart, mapModel }

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) startServer()

function startServer() {
  const token = loadAuth()
  const server = createServer((req, res) => {
    // handleRequest is async: without a .catch() any rejection it does not
    // handle internally becomes an unhandled rejection, which terminates the
    // process under Node's default --unhandled-rejections=throw. This is the
    // last line of defence — one aborted request must never kill the proxy.
    handleRequest(req, res, token).catch((err) => {
      console.error(`❌ Unhandled request error: ${err.message}`)
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal proxy error" } }))
        } else {
          res.end()
        }
      } catch {
        // Socket already gone; nothing further to do.
      }
    })
  })

  // Expected disconnects need no HTTP response. Keep malformed-request errors
  // visible and return the parser's conventional 400 response.
  server.on("clientError", (err, socket) => {
    if (err.code === "ECONNRESET" || !socket.writable) {
      socket.destroy()
      return
    }
    console.warn(`⚠ Client error: ${err.message}`)
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
  })

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`❌ Port ${PORT} is already in use`)
      console.error(`   Try: lsof -i :${PORT}  or  COPILOT_PROXY_PORT=18081 node scripts/proxy.mjs`)
      process.exit(1)
    }
    throw err
  })

  server.listen(PORT, () => {
    console.log("┌─────────────────────────────────────────────┐")
    console.log("│  Claude Code ↔ GitHub Copilot Proxy         │")
    console.log("├─────────────────────────────────────────────┤")
    console.log(`│  Port: ${PORT}                              │`)
    console.log(`│  Search: Exa/Parallel MCP + DDG fallback    │`)
    if (BRAVE_API_KEY) {
      console.log("│  Brave: ✓ (primary)                         │")
    }
    if (WEBSEARCH_PROVIDER) {
      console.log(`│  Provider override: ${WEBSEARCH_PROVIDER.padEnd(23)}│`)
    }
    console.log("├─────────────────────────────────────────────┤")
    console.log(`│  ANTHROPIC_BASE_URL=http://localhost:${PORT}  │`)
    console.log("│  ANTHROPIC_API_KEY=copilot-proxy             │")
    console.log("└─────────────────────────────────────────────┘")
    console.log(
      FORWARD_REASONING
        ? "  ℹ Reasoning effort forwarded to Copilot as reasoning_effort (low/medium/high/xhigh/max)."
        : "  ℹ Reasoning-effort forwarding disabled (COPILOT_FORWARD_REASONING=0)."
    )
  })

  process.on("SIGINT", () => {
    console.log("\nShutting down proxy server...")
    server.close()
    process.exit(0)
  })

  process.on("SIGTERM", () => {
    server.close()
    process.exit(0)
  })
}
