# Claude Code via GitHub Copilot

<p align="center">
<img alt="pipeline" src="https://github.com/user-attachments/assets/bdc80db2-97b2-4515-ae13-ef220ba3b21c" width="full"/>
</p>

Use **Claude Code for free** by routing it through your existing GitHub Copilot subscription.

This project runs a lightweight local proxy that translates between Anthropic's Messages API (which Claude Code speaks) and OpenAI's Chat Completions API (which GitHub Copilot speaks). No Anthropic API key needed — just your Copilot subscription.

<p align="center">
  <img src="assets/claude-copilot.png" alt="Claude Code via GitHub Copilot" width="full" />
</p>

## Features

- **Full API Translation** — Anthropic Messages API ↔ OpenAI Chat Completions, including streaming
- **Web Search** — Emulates Anthropic's `web_search_20250305` tool using Exa/Parallel MCP (same as OpenCode), with DuckDuckGo fallback
- **Docker Support** — Run the proxy as an always-on container that survives reboots
- **Zero Dependencies** — Pure Node.js, no npm install needed

## Prerequisites

- GitHub account with an **active Copilot subscription** (Individual, Business, or Enterprise)
- [Node.js](https://nodejs.org/) 18+ (or [Docker](https://www.docker.com/))
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed (`npm install -g @anthropic-ai/claude-code`)

## Quick Start

### 1. Clone and authenticate
```bash
git clone https://github.com/samarth777/claude-code-copilot.git
cd claude-code-copilot
node scripts/auth.mjs
```

The auth script opens a GitHub device code flow in your browser. Your token is saved to `~/.claude-copilot-auth.json`.

### 2. Start Claude Code

**One-command launcher (recommended):**
```bash
./scripts/launch.sh
```

This auto-starts the proxy (via Docker if available, otherwise as a background process) and launches Claude Code.

**Or use Docker directly:**
```bash
docker compose up -d
ANTHROPIC_BASE_URL=http://localhost:18080 ANTHROPIC_API_KEY=copilot-proxy claude
```

The proxy runs with `restart: always` — it stays running across reboots.

### 3. Select your model

Inside Claude Code, use `/model` to switch between available models (Claude Opus, Sonnet, etc.).

## Web Search

The proxy emulates Anthropic's web search tool so Claude Code's WebSearch works automatically.

**Search providers (priority order):**

1. **Exa / Parallel MCP** — Free, no API key needed (default). Uses the same MCP-based search endpoints as [OpenCode](https://github.com/anomalyco/opencode). Traffic is split 50/50 between providers for reliability, with automatic cross-fallback.
2. **Brave Search API** — Best results quality. Set `BRAVE_API_KEY` env var (free $5/mo credit at [brave.com/search/api](https://brave.com/search/api/))
3. **Serper.dev** — Google SERP results as fallback. Set `SERPER_API_KEY` env var (2,500 free queries at [serper.dev](https://serper.dev/), no credit card required)
4. **DuckDuckGo Lite** — Scraping fallback (may hit CAPTCHAs under heavy use)
5. **DuckDuckGo Instant Answer** — Last resort (limited to knowledge-graph results)

**Rate-limit protection (for multi-agent workflows):**

- **Search cache** — 5-minute TTL; identical queries from parallel subagents return cached results instantly
- **Concurrency semaphore** — max 2 concurrent search requests; excess searches queue automatically, preventing DDG/API rate-limit storms

You can force a specific MCP provider with `WEBSEARCH_PROVIDER=exa` or `WEBSEARCH_PROVIDER=parallel`.

## How It Works

Claude Code sends requests in Anthropic format → proxy translates to OpenAI format → forwarded to GitHub Copilot → responses translated back. No data is stored or logged.

## Troubleshooting

**"401 Unauthorized" from Copilot**
```bash
rm ~/.claude-copilot-auth.json
node scripts/auth.mjs
```

**"EADDRINUSE: address already in use"**
```bash
lsof -ti:18080 | xargs kill -9
```

**Proxy running but Claude Code shows errors**

Make sure both environment variables are set:
```bash
ANTHROPIC_BASE_URL=http://localhost:18080 ANTHROPIC_API_KEY=copilot-proxy claude
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `COPILOT_PROXY_PORT` | `18080` | Port for the local proxy |
| `COPILOT_AUTH_FILE` | `~/.claude-copilot-auth.json` | Path to saved OAuth token |
| `SERPER_API_KEY` | *(none)* | Serper.dev API key — Google SERP fallback (free 2,500 queries at [serper.dev](https://serper.dev/)) |
| `BRAVE_API_KEY` | *(none)* | Brave Search API key (free $5/mo credit at [brave.com/search/api](https://brave.com/search/api/)) |
| `WEBSEARCH_PROVIDER` | *(auto)* | Force MCP provider: `exa` or `parallel` (default: 50/50 split) |
| `EXA_API_KEY` | *(none)* | Optional API key for Exa (works without one) |
| `PARALLEL_API_KEY` | *(none)* | Optional API key for Parallel (works without one) |
| `WEB_SEARCH_MAX_RESULTS` | `5` | Max search results per query |
| `WEB_SEARCH_MAX_USES_CAP` | `10` | Upper bound on a request's `max_uses`. Each search round is a billed completion, so this caps how far one request can fan out |

### Reliability

| Variable | Default | Description |
|---|---|---|
| `COPILOT_REQUEST_TIMEOUT_MS` | `120000` | Per-attempt timeout. Also applied as an idle timeout to response body reads, so a stalled upstream cannot hang the proxy |
| `COPILOT_MAX_RETRIES` | `3` | Retries for transient failures (429 / 5xx / network / timeout) with exponential backoff. Set `0` to disable |
| `COPILOT_MIN_REQUEST_INTERVAL_MS` | `0` | Minimum gap between requests. Opt in to pace parallel subagents and avoid rate limits |
| `COPILOT_FORWARD_REASONING` | `1` | Forward extended-thinking effort to Copilot as `reasoning_effort`. Set `0` to disable |

### Advanced

| Variable | Default | Description |
|---|---|---|
| `COPILOT_EDITOR_VERSION` | `vscode/1.99.0` | `Editor-Version` header sent to Copilot |
| `COPILOT_INTEGRATION_ID` | `vscode-chat` | `Copilot-Integration-Id` header sent to Copilot |

## Tests

No dependencies or network access needed for the first suite:

```bash
node scripts/test-streaming.mjs      # translation + streaming assertions
node scripts/test-crash-safety.mjs   # boots a proxy and attacks it over raw TCP
```

`test-streaming.mjs` covers parallel tool-call routing, image translation, the
web-search catch scope, and the search concurrency gate. `test-crash-safety.mjs`
verifies the proxy survives clients that disconnect mid-upload (it needs a saved
auth token to boot, but makes no upstream calls).


## Windows Usage

The launch.sh script is bash-only. On Windows, run the proxy and Claude Code manually:

### PowerShell

`powershell
# 1. Clone and authenticate
git clone https://github.com/samarth777/claude-code-copilot.git
cd claude-code-copilot
node scripts/auth.mjs

# 2. Start the proxy
node src/proxy.mjs

# 3. In a NEW terminal, set env vars and launch Claude Code
$env:ANTHROPIC_BASE_URL = "http://localhost:18080"
$env:ANTHROPIC_API_KEY = "copilot-proxy"
claude
`

### CMD

`cmd
set ANTHROPIC_BASE_URL=http://localhost:18080
set ANTHROPIC_API_KEY=copilot-proxy
claude
`

### Docker (Windows)

If you have Docker Desktop installed, docker compose up -d works the same way, then set the environment variables above and run claude.

## License

MIT
