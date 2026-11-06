// One popup lifetime: publish the question to the page, show the window, race it
// against the native DSH answer, then tear the window down. Extracted from
// lib/index.js so the race and its cleanup are testable offline with fakes.

const HEIGHT_WAIT_MS = 700
const WATCH_MS = 500

/**
 * Race a desktop popup lifetime against the native answer path.
 *
 * Outcomes: popup answer wins, the user dismisses the popup (the native path keeps
 * waiting), the native answer wins, the native path fails, or the timed wait
 * aborts. Every outcome hides the window and ends the page session first.
 */
export class PopupSession {
  /**
   * @param {object} options - popup lifetime inputs.
   * @param {any} options.ctx - host context (for the remaining-time probe).
   * @param {{ server: any, win: any }} options.active - started GUI handles.
   * @param {any} options.request - timed `user-questions/request`.
   * @param {() => number} options.nextSeq - monotonic question sequence.
   * @param {(line: string) => void} [options.log] - one-line diagnostics.
   * @param {() => Promise<void>} [options.onWindowClosed] - the user closed the Edge window.
   */
  constructor({ ctx, active, request, nextSeq, log, onWindowClosed }) {
    this.ctx = ctx
    this.active = active
    this.request = request
    this.nextSeq = nextSeq
    this.log = log ?? (() => {})
    this.onWindowClosed = onWindowClosed ?? (async () => {})
    this.height = undefined
    this.shown = false
    this.cleaned = false
    this.windowGone = false
    this.answered = false
    this.settled = false
    this.topmostRetries = 0
    this.answer = new Promise((resolve) => { this.resolveAnswerRaw = resolve })
    this.dismissed = new Promise((resolve) => { this.resolveDismissRaw = resolve })
    const signal = request?.signal
    this.aborted = new Promise((resolve) => {
      if (signal === undefined) return
      if (signal.aborted) { resolve(); return }
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  /**
   * Accept a validated answer batch from the page.
   * @param {Array<Record<string, any>>} answers - normalized answers.
   */
  resolveAnswer(answers) {
    if (this.answered) return
    this.answered = true
    this.resolveAnswerRaw(answers)
  }

  /** The user closed the popup; the native path keeps waiting. */
  resolveDismiss() {
    this.settled = true
    this.resolveDismissRaw()
  }

  /**
   * The page reported its content height.
   * @param {unknown} height - DIP height from the page.
   */
  applyHeight(height) {
    const value = Number(height)
    if (!Number.isFinite(value)) return
    this.height = value
    if (this.shown) {
      this.active.win.resize(value).catch((error) => this.log(`resize failed: ${String(error?.message ?? error)}`))
    }
  }

  /** Publish the question and show the window. */
  async show() {
    const active = this.active
    const request = this.request
    const remaining = await readRemainingMs(this.ctx, request, this.log)
    // Drop the idle page's height report: only the report the page sends AFTER it
    // renders this question may size the window.
    this.height = undefined
    active.server.begin({
      seq: this.nextSeq(),
      callId: request.wait?.callId,
      remainingMs: remaining,
      questions: request.questions.map((question) => ({
        id: question.id,
        question: question.question,
        ...question.header !== undefined ? { header: question.header } : {},
        ...question.detail !== undefined ? { detail: question.detail } : {},
        ...question.options !== undefined ? { options: question.options.map((option) => ({ ...option })) } : {},
        ...question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}
      }))
    })
    await waitForHeight(this, HEIGHT_WAIT_MS)
    // An answer can only come from the page, but keep the window down if the batch
    // was already settled (or the timed wait expired) while it was being placed.
    if (this.answered || this.settled || request.signal?.aborted) return
    await active.win.show(this.height ?? 320)
    active.server.sendEvent('shown', {
      visible: active.win.visible === true,
      topmost: active.win.topmost === true,
      rect: active.win.rect ?? null
    })
    this.shown = true
    this.watch = setInterval(() => {
      active.win.status().then((status) => {
        if (status?.exists === false) {
          this.windowGone = true
          this.resolveDismiss()
          return
        }
        // Chromium may drop WS_EX_TOPMOST while it settles a freshly shown window;
        // keep the popup above the user's windows for its whole short life.
        if (status?.visible === true && status?.topmost !== true && this.topmostRetries < 25) {
          this.topmostRetries += 1
          active.win.reassertTopmost().catch(() => {})
        }
      }).catch(() => {})
    }, WATCH_MS)
    if (typeof this.watch.unref === 'function') this.watch.unref()
    this.log(`popup shown (questions=${String(request.questions.length)}, height=${String(this.height ?? 320)})`)
  }

  /**
   * Race the popup against the native answer and return the winning answer.
   * @param {Promise<any>} forwarded - the native answer path (`next()`).
   * @returns {Promise<any>} the batch the question settles with.
   */
  async run(forwarded) {
    const outcome = await Promise.race([
      this.answer.then((answers) => ({ kind: 'answer', answers })),
      this.dismissed.then(() => ({ kind: 'dismiss' })),
      forwarded.then((value) => ({ kind: 'native', value }), (error) => ({ kind: 'native-error', error })),
      this.aborted.then(() => ({ kind: 'aborted' }))
    ])
    const outcomeReason = outcome.kind === 'answer'
      ? 'answered'
      : outcome.kind === 'dismiss'
        ? this.windowGone ? 'window-closed' : 'dismissed'
        : outcome.kind === 'aborted' ? 'timeout' : this.#nativeReason(outcome.error)
    await this.teardown(outcomeReason)
    if (outcome.kind === 'answer') return { answers: outcome.answers }
    if (outcome.kind === 'native') return outcome.value
    if (outcome.kind === 'native-error') throw outcome.error
    // dismiss / aborted: the popup stopped participating; the native path owns
    // the settlement (its rejection carries the askTimed mapping reason).
    return await forwarded
  }

  /**
   * Diagnostic reason for a popup hidden because the native path settled first.
   * @param {any} error - rejection reason from the native answerer chain.
   * @returns {string} `timeout` for the timed wait expiry, else `answered-elsewhere`.
   */
  #nativeReason(error) {
    const code = error?.code
    if (code === 'ASK_TIMED_OUT') return 'timeout'
    if (code === 'ASK_ABORTED') return 'cancelled'
    return 'answered-elsewhere'
  }

  /**
   * Hide the window and end the page session.
   * @param {string} reason - diagnostic reason for the SSE dismiss frame.
   */
  async teardown(reason) {
    if (this.watch !== undefined) clearInterval(this.watch)
    this.watch = undefined
    try { await this.active.win.hide() } catch (error) { this.log(`hide failed: ${String(error?.message ?? error)}`) }
    this.active.server.sendEvent('hidden', { reason, visible: false })
    this.active.server.end(reason)
    this.shown = false
    if (this.windowGone) {
      this.log('popup window was closed by the user; the browser will be relaunched')
      await this.onWindowClosed()
    }
    this.log(`popup hidden (reason=${reason})`)
  }

  /** Idempotent cleanup used from the caller's `finally`. */
  async close() {
    if (this.cleaned) return
    this.cleaned = true
    if (this.watch !== undefined) clearInterval(this.watch)
    this.watch = undefined
    if (this.shown) {
      try { await this.active.win.hide() } catch { /* best effort */ }
      this.shown = false
    }
  }
}

/**
 * Best-effort remaining time for the popup countdown. The wait is claimed for one
 * frame and released immediately, so the Host timer keeps running normally.
 * @param {any} ctx - host context.
 * @param {any} request - timed user-questions request.
 * @param {(line: string) => void} [log] - one-line diagnostic sink.
 * @returns {Promise<number | undefined>} remaining milliseconds, when observable.
 */
export async function readRemainingMs(ctx, request, log = () => {}) {
  const callId = request?.wait?.callId
  if (request?.wait?.timed !== true || callId === undefined || request?.agent === undefined) return undefined
  let controller
  try {
    controller = new AbortController()
    const wait = ctx.userQuestions.attachWait(request.agent, callId, controller.signal)
    const iterator = wait[Symbol.asyncIterator]()
    const first = await withTimeout(iterator.next(), 200)
    controller.abort()
    if (first === undefined || first?.done === true) {
      log('countdown probe: no attachWait frame (host wait already ended)')
      return undefined
    }
    const remaining = Number(first.value?.remainingMs)
    if (Number.isFinite(remaining) && remaining > 0) {
      log(`countdown probe: attachWait frame remainingMs=${String(Math.round(remaining))} (claim released)`)
      return remaining
    }
    return undefined
  } catch (error) {
    try { controller?.abort() } catch { /* ignore */ }
    log(`countdown probe failed: ${String(error?.message ?? error)}`)
    return undefined
  }
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
  ])
}

/**
 * Wait (briefly) for the page to report its content height so the first show is
 * already correctly sized; a late report still resizes the visible window.
 * @param {PopupSession} session - popup being opened.
 * @param {number} timeoutMs - budget.
 * @returns {Promise<void>} resolves when a height arrived or the budget expired.
 */
export function waitForHeight(session, timeoutMs) {
  if (session.height !== undefined) return Promise.resolve()
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const poll = setInterval(() => {
      if (session.height !== undefined || Date.now() >= deadline) {
        clearInterval(poll)
        resolve()
      }
    }, 25)
    if (typeof poll.unref === 'function') poll.unref()
  })
}
