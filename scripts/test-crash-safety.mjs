// Crash-safety tests: boots a real proxy and attacks it over raw TCP.
//
//   node scripts/test-crash-safety.mjs
//
// Covers the availability fixes:
//   #2 aborted request body must not kill the process (remote DoS)
//   #4 error path must not writeHead() after headers are sent
//   routine TCP resets after a completed response must not be logged as errors
//
// Requires ~/.claude-copilot-auth.json (the proxy loads a token at boot), but
// makes no upstream Copilot calls — every request here fails or completes
// locally.

import { spawn } from "node:child_process"
import net from "node:net"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const PORT = 18099
const proxyPath = join(dirname(fileURLToPath(import.meta.url)), "proxy.mjs")

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(path) {
  return new Promise((resolve) => {
    const req = net.connect(PORT, "127.0.0.1", () => {
      req.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
    })
    let data = ""
    req.on("data", (c) => (data += c))
    req.on("end", () => resolve(data))
    req.on("error", () => resolve(""))
    setTimeout(() => {
      req.destroy()
      resolve(data)
    }, 4000)
  })
}

// Announce a large body, send a sliver, then hard-reset the socket.
function abortMidUpload(path) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1", () => {
      s.write(
        `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n`,
      )
      s.write('{"partial":"data"')
      setTimeout(() => {
        s.destroy()
        resolve()
      }, 120)
    })
    s.on("error", () => resolve())
  })
}

function resetAfterResponsePayload(path, body, payloadPattern) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1", () => {
      s.write(
        `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`,
      )
    })
    let data = ""
    let settled = false
    const timeout = setTimeout(() => finish(), 4000)

    function finish(reset = false) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (!s.destroyed) {
        if (reset) s.resetAndDestroy()
        else s.destroy()
      }
      resolve(data)
    }

    s.on("data", (c) => {
      data += c
      if (payloadPattern.test(data)) finish(true)
    })
    s.on("end", () => finish())
    s.on("error", () => finish())
  })
}

const proxy = spawn(process.execPath, [proxyPath], {
  env: { ...process.env, COPILOT_PROXY_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
})

let exited = false
let exitInfo = ""
proxy.on("exit", (code, signal) => {
  exited = true
  exitInfo = `code=${code} signal=${signal}`
})

let stderr = ""
proxy.stderr.on("data", (c) => (stderr += c))

await sleep(3000)

if (exited) {
  console.log(`\n✗ proxy failed to boot (${exitInfo})\n${stderr.slice(0, 500)}`)
  process.exit(1)
}

console.log("\nroutine reset after completed response")
{
  const body = JSON.stringify({ messages: [{ role: "user", content: "hello world" }] })
  const stderrBefore = stderr.length
  const res = await resetAfterResponsePayload("/v1/messages/count_tokens", body, /"input_tokens":\s*\d+}/)
  await sleep(400)
  const resetLog = stderr.slice(stderrBefore)

  check("client received the complete response before resetting", /"input_tokens":\s*\d+/.test(res), res.slice(0, 120))
  check("expected ECONNRESET is not logged as a client error", !resetLog.includes("ECONNRESET"), resetLog.trim())
}

console.log("\naborted request bodies (#2 — remote DoS)")
{
  const before = await get("/health")
  check("proxy healthy before attack", before.includes('"status":"ok"'))

  for (let i = 0; i < 5; i++) await abortMidUpload("/v1/messages/count_tokens")
  await sleep(400)
  check("survives aborted /count_tokens uploads", !exited, exitInfo)

  for (let i = 0; i < 5; i++) await abortMidUpload("/v1/messages")
  await sleep(400)
  check("survives aborted /messages uploads", !exited, exitInfo)

  const after = await get("/health")
  check("still serving requests after attack", after.includes('"status":"ok"'), `response: ${after.slice(0, 80)}`)
}

console.log("\nnormal operation unaffected")
{
  const body = JSON.stringify({ messages: [{ role: "user", content: "hello world" }] })
  const res = await new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1", () => {
      s.write(
        `POST /v1/messages/count_tokens HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      )
    })
    let d = ""
    s.on("data", (c) => (d += c))
    s.on("end", () => resolve(d))
    s.on("error", () => resolve(""))
    setTimeout(() => {
      s.destroy()
      resolve(d)
    }, 4000)
  })
  check("count_tokens returns a token count", /"input_tokens":\s*\d+/.test(res), res.slice(0, 120))

  const models = await get("/v1/models")
  check("models endpoint intact", models.includes("claude-opus-5"))
}

console.log("\ngraceful degradation")
{
  check(
    "no unhandled rejection in stderr",
    !stderr.includes("triggerUncaughtException") && !stderr.includes("UnhandledPromiseRejection"),
    stderr.slice(0, 200),
  )
  check("process never exited", !exited, exitInfo)
}

proxy.kill("SIGKILL")
await sleep(200)

console.log(failures === 0 ? "\n✅ all crash-safety tests passed\n" : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
