// Popup HTTP + SSE server (loopback only, token gated).
//
// The page loaded by the Edge app window talks to this server:
//   GET  /popup?token=   -> ui/popup.html with the token injected
//   GET  /events?token=  -> SSE: `question`, `dismiss`, `ping`
//   POST /answer?token=  -> { answers: [{ id, selected: [], custom? }] }
//   POST /dismiss?token= -> user closed the popup; no answer is produced
//   POST /ready?token=   -> page rendered and its SSE stream is open
//   POST /height?token=  -> { height } content height for window sizing
//
// validateAnswers is a pure function so the acceptance rules are testable offline.

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, extname, join } from 'node:path'

const MAX_BODY_BYTES = 64 * 1024
const MAX_CUSTOM_LENGTH = 4000
const SSE_PING_MS = 15000

/** Static assets the popup page needs, served beside popup.html. */
const STATIC_ROUTES = new Map([
  ['/popup.css', { file: 'popup.css', type: 'text/css; charset=utf-8' }],
  ['/popup.js', { file: 'popup.js', type: 'text/javascript; charset=utf-8' }],
  ['/icon.svg', { file: '../icon.svg', type: 'image/svg+xml' }]
])

/**
 * Validate a submitted answer batch against the questions being asked.
 *
 * Rules (AGENTS.md §6): exactly one item per question, `selected` must be a
 * subset of that question's option labels, at most one label when
 * `multiSelect` is not true, duplicates are rejected, and an empty `selected`
 * with no `custom` is a legal explicit skip.
 *
 * @param {ReadonlyArray<Record<string, any>>} questions - active questions.
 * @param {unknown} payload - parsed request body.
 * @returns {{ ok: true, answers: Array<{ id: string, selected: string[], custom?: string }> }
 *   | { ok: false, error: string }} normalized batch or a rejection reason.
 */
export function validateAnswers(questions, payload) {
  if (!Array.isArray(questions) || questions.length === 0) return { ok: false, error: 'no active question' }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const list = payload.answers
  if (!Array.isArray(list) || !Object.hasOwn(payload, 'answers')) {
    return { ok: false, error: 'answers must be an array' }
  }
  if (list.length !== questions.length) {
    return { ok: false, error: `expected ${String(questions.length)} answers, received ${String(list.length)}` }
  }
  const byId = new Map()
  for (const question of questions) byId.set(question.id, question)
  const seen = new Set()
  const answers = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: 'each answer must be a JSON object' }
    }
    const id = item.id
    if (typeof id !== 'string' || !byId.has(id)) {
      return { ok: false, error: `unknown question id ${JSON.stringify(id ?? null)}` }
    }
    if (seen.has(id)) return { ok: false, error: `duplicate answer for question ${JSON.stringify(id)}` }
    seen.add(id)
    const question = byId.get(id)
    if (!Array.isArray(item.selected)) {
      return { ok: false, error: `selected must be an array for question ${JSON.stringify(id)}` }
    }
    const allowed = new Set((question.options ?? []).map((option) => option.label))
    const unique = new Set()
    for (const label of item.selected) {
      if (typeof label !== 'string') return { ok: false, error: 'selected labels must be strings' }
      if (!allowed.has(label)) {
        return { ok: false, error: `selected label ${JSON.stringify(label)} is not an option of question ${JSON.stringify(id)}` }
      }
      if (unique.has(label)) {
        return { ok: false, error: `duplicate selected label ${JSON.stringify(label)} for question ${JSON.stringify(id)}` }
      }
      unique.add(label)
    }
    if (question.multiSelect !== true && unique.size > 1) {
      return { ok: false, error: `question ${JSON.stringify(id)} allows one selection` }
    }
    let custom
    if (item.custom !== undefined && item.custom !== null) {
      if (typeof item.custom !== 'string') {
        return { ok: false, error: `custom must be a string for question ${JSON.stringify(id)}` }
      }
      if (item.custom.length > MAX_CUSTOM_LENGTH) {
        return { ok: false, error: `custom answer for question ${JSON.stringify(id)} is too long` }
      }
      const trimmed = item.custom.trim()
      if (trimmed.length > 0) custom = trimmed
    }
    const answer = { id, selected: [...unique] }
    if (custom !== undefined) answer.custom = custom
    answers.push(answer)
  }
  if (answers.length !== questions.length) return { ok: false, error: 'missing answers' }
  return { ok: true, answers }
}

/**
 * Loopback HTTP server owned by one plugin instance.
 */
export class PopupServer {
  /**
   * @param {object} options - page source and callbacks.
   * @param {string} options.pagePath - ui/popup.html path.
   * @param {string} [options.token] - access token; generated when omitted.
   * @param {(answers: Array<Record<string, any>>) => void} [options.onAnswer] - valid batch submitted.
   * @param {() => void} [options.onDismiss] - user closed the popup.
   * @param {(height: number) => void} [options.onHeight] - page reported content height.
   * @param {() => void} [options.onReady] - page finished rendering.
   * @param {(line: string) => void} [options.logger] - one-line diagnostic sink.
   */
  constructor({ pagePath, token, onAnswer, onDismiss, onHeight, onReady, logger }) {
    this.pagePath = pagePath
    this.assetDir = dirname(pagePath)
    this.token = token ?? randomBytes(16).toString('hex')
    this.onAnswer = onAnswer ?? (() => {})
    this.onDismiss = onDismiss ?? (() => {})
    this.onHeight = onHeight ?? (() => {})
    this.onReady = onReady ?? (() => {})
    this.logger = logger ?? (() => {})
    this.server = undefined
    this.page = undefined
    this.clients = new Set()
    this.current = undefined
    this.ready = false
    this.readyWaiters = []
  }

  /** @returns {string} the token the page must present. */
  get accessToken() {
    return this.token
  }

  /** @returns {number} the bound loopback port (0 before start). */
  get port() {
    return this.server?.address()?.port ?? 0
  }

  /** @returns {string} base URL of the popup page (empty before start). */
  get baseUrl() {
    const port = this.port
    return port === 0 ? '' : `http://127.0.0.1:${String(port)}`
  }

  /** @returns {string} tokenized popup page URL. */
  get pageUrl() {
    return `${this.baseUrl}/popup?token=${this.token}`
  }

  /** @returns {boolean} whether a page is currently holding the SSE stream. */
  get hasPage() {
    return this.clients.size > 0
  }

  /**
   * Load the page and bind the loopback port.
   * @returns {Promise<{ port: number, baseUrl: string }>} bound address.
   */
  async start() {
    if (this.server !== undefined) return { port: this.port, baseUrl: this.baseUrl }
    this.page = await readFile(this.pagePath, 'utf8')
    const server = http.createServer((request, response) => {
      this.#handle(request, response).catch((error) => {
        this.logger(`http handler error: ${String(error?.message ?? error)}`)
        try { this.#json(response, 500, { ok: false, error: 'internal error' }) } catch { /* response already sent */ }
      })
    })
    server.on('clientError', (error, socket) => {
      this.logger(`http client error: ${String(error?.message ?? error)}`)
      try { socket.destroy() } catch { /* already closed */ }
    })
    this.server = server
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const ping = setInterval(() => this.sendEvent('ping', { time: Date.now() }), SSE_PING_MS)
    if (typeof ping.unref === 'function') ping.unref()
    this.pingTimer = ping
    return { port: this.port, baseUrl: this.baseUrl }
  }

  /**
   * Resolve once the page reports `/ready` (or the budget expires).
   * @param {number} [timeoutMs] - readiness budget.
   * @returns {Promise<boolean>} whether the page became ready.
   */
  async waitForReady(timeoutMs = 12000) {
    if (this.ready) return true
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((waiter) => waiter !== done)
        resolve(false)
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      const done = (value) => {
        clearTimeout(timer)
        resolve(value)
      }
      this.readyWaiters.push(done)
    })
  }

  /**
   * Publish one question batch to the page and remember it for validation.
   * @param {{ seq: number, callId?: string, remainingMs?: number, questions: Array<Record<string, any>> }} payload - batch.
   */
  begin(payload) {
    this.current = {
      seq: payload.seq,
      callId: payload.callId,
      remainingMs: payload.remainingMs,
      questions: payload.questions,
      answered: false
    }
    this.sendEvent('question', {
      seq: payload.seq,
      callId: payload.callId,
      remainingMs: payload.remainingMs,
      questions: payload.questions
    })
  }

  /**
   * Close the current batch and tell the page why.
   * @param {string} [reason] - `answered-elsewhere` | `timeout` | `cancelled` | `dismissed`.
   */
  end(reason = 'cancelled') {
    this.current = undefined
    this.sendEvent('dismiss', { reason })
  }

  /**
   * Notify the page that the window was closed by the user.
   * @returns {boolean} whether a batch was pending (already ended by this call).
   */
  notifyClosed() {
    if (this.current === undefined) return false
    this.current = undefined
    return true
  }

  /**
   * Send one SSE event to every connected page.
   * @param {string} event - event name.
   * @param {unknown} data - JSON payload.
   */
  sendEvent(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of this.clients) {
      try { client.write(frame) } catch { this.clients.delete(client) }
    }
  }

  /** Stop the server and drop every stream. */
  async stop() {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer)
    this.pingTimer = undefined
    for (const client of this.clients) {
      try { client.end() } catch { /* already closed */ }
    }
    this.clients.clear()
    const server = this.server
    this.server = undefined
    this.current = undefined
    if (server === undefined) return
    await new Promise((resolve) => server.close(() => resolve()))
  }

  async #handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && STATIC_ROUTES.has(url.pathname)) return this.#static(url.pathname, response)
    if (url.searchParams.get('token') !== this.token) {
      this.#json(response, 403, { ok: false, error: 'forbidden' })
      return
    }
    const route = `${request.method ?? 'GET'} ${url.pathname}`
    if (route === 'GET /popup') {
      const html = this.page.replaceAll('__DSH_TOKEN__', this.token)
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
        'X-Content-Type-Options': 'nosniff'
      })
      response.end(html)
      return
    }
    if (route === 'GET /events') {
      this.#openStream(request, response)
      return
    }
    if (request.method === 'POST') {
      const body = await readBody(request)
      if (route === 'POST /answer') return this.#answer(response, body)
      if (route === 'POST /dismiss') return this.#dismiss(response)
      if (route === 'POST /ready') return this.#ready(response)
      if (route === 'POST /height') return this.#height(response, body)
    }
    this.#json(response, 404, { ok: false, error: 'not found' })
  }

  /**
   * Serve the page's own CSS/JS. These are requested by the page without the token
   * query (relative URLs), so they are allowed above the token gate; they contain
   * no question data and the socket is loopback-only.
   * @param {string} pathname - request path.
   * @param {import('node:http').ServerResponse} response - response sink.
   */
  async #static(pathname, response) {
    const asset = STATIC_ROUTES.get(pathname)
    if (asset === undefined) {
      this.#json(response, 404, { ok: false, error: 'not found' })
      return
    }
    try {
      const body = await readFile(join(this.assetDir, asset.file))
      if (response.headersSent) return
      response.writeHead(200, {
        'Content-Type': asset.type,
        'Cache-Control': 'no-store',
        'Content-Length': body.length
      })
      response.end(body)
    } catch (error) {
      this.logger(`static asset ${extname(asset.file)} failed: ${String(error?.message ?? error)}`)
      this.#json(response, 404, { ok: false, error: 'not found' })
    }
  }

  #answer(response, rawBody) {
    const current = this.current
    if (current === undefined) {
      this.#json(response, 409, { ok: false, error: 'no active question' })
      return
    }
    if (current.answered) {
      this.#json(response, 409, { ok: false, error: 'question already answered' })
      return
    }
    let payload
    try {
      payload = JSON.parse(rawBody.length === 0 ? '{}' : rawBody)
    } catch {
      this.#json(response, 400, { ok: false, error: 'body is not valid JSON' })
      return
    }
    const verdict = validateAnswers(current.questions, payload)
    if (!verdict.ok) {
      this.logger(`rejected answer: ${verdict.error}`)
      this.#json(response, 400, { ok: false, error: verdict.error })
      return
    }
    current.answered = true
    this.#json(response, 200, { ok: true })
    try { this.onAnswer(verdict.answers) } catch (error) {
      this.logger(`answer callback failed: ${String(error?.message ?? error)}`)
    }
  }

  #dismiss(response) {
    if (this.current === undefined) {
      this.#json(response, 409, { ok: false, error: 'no active question' })
      return
    }
    this.#json(response, 200, { ok: true })
    try { this.onDismiss() } catch (error) {
      this.logger(`dismiss callback failed: ${String(error?.message ?? error)}`)
    }
  }

  #ready(response) {
    this.#json(response, 200, { ok: true })
    this.ready = true
    const waiters = this.readyWaiters
    this.readyWaiters = []
    for (const waiter of waiters) waiter(true)
    try { this.onReady() } catch (error) {
      this.logger(`ready callback failed: ${String(error?.message ?? error)}`)
    }
  }

  #height(response, rawBody) {
    let height = Number.NaN
    try {
      const parsed = JSON.parse(rawBody.length === 0 ? '{}' : rawBody)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) height = Number(parsed.height)
    } catch {
      this.#json(response, 400, { ok: false, error: 'body is not valid JSON' })
      return
    }
    this.#json(response, 200, { ok: true })
    if (Number.isFinite(height)) {
      try { this.onHeight(height) } catch (error) {
        this.logger(`height callback failed: ${String(error?.message ?? error)}`)
      }
    }
  }

  #openStream(request, response) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    response.write('retry: 1000\n\n')
    this.clients.add(response)
    const drop = () => this.clients.delete(response)
    request.on('close', drop)
    request.on('error', drop)
    response.on('error', drop)
    if (this.current !== undefined) {
      const { seq, callId, remainingMs, questions } = this.current
      response.write(`event: question\ndata: ${JSON.stringify({ seq, callId, remainingMs, questions })}\n\n`)
    }
  }

  #json(response, status, payload) {
    if (response.headersSent) return
    const body = JSON.stringify(payload)
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body)
    })
    response.end(body)
  }
}

function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}
