// CDP driver for the desktop question popup.
//
// Connects to the popup Edge instance (--remote-debugging-port=9334), waits for a
// question to render, records DOM evidence, then either clicks an option and
// submits, or dismisses. Prints one JSON line with timestamps so the caller can
// compare them with the independent window watcher.
//
// Usage: node e2e-cdp.mjs --action answer --label 红色
//        node e2e-cdp.mjs --action dismiss
//        node e2e-cdp.mjs --action observe
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const action = arg('action', 'observe')
const label = arg('label', '')
const waitMs = Number(arg('wait', '90000'))
const port = Number(arg('port', '9334'))

async function pageTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) return []
    const list = await response.json()
    return list.filter((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
      .filter((target) => target.url.includes('/popup?token='))
  } catch {
    return []
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let id = 0
    socket.addEventListener('open', () => resolve({
      evaluate: (expression) => new Promise((resolveCall, rejectCall) => {
        id += 1
        const callId = id
        pending.set(callId, { resolveCall, rejectCall })
        socket.send(JSON.stringify({
          id: callId,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        }))
      }),
      close: () => socket.close()
    }))
    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      if (message.error) waiter.rejectCall(new Error(JSON.stringify(message.error)))
      else waiter.resolveCall(message.result?.result?.value)
    })
    socket.addEventListener('error', (error) => reject(new Error(`websocket error: ${String(error?.message ?? error)}`)))
    setTimeout(() => reject(new Error('websocket connect timed out')), 5000)
  })
}

async function main() {
  const startedAt = Date.now()
  let target
  while (Date.now() - startedAt < waitMs) {
    const targets = await pageTargets()
    if (targets.length > 0) { target = targets[0]; break }
    await sleep(250)
  }
  if (target === undefined) throw new Error('popup CDP target did not appear')
  console.error(`[e2e] target url=${target.url}`)
  const page = await connect(target.webSocketDebuggerUrl)

  // Wait for the question DOM (the window is hidden until content is ready).
  const domDeadline = Date.now() + waitMs
  let state
  while (Date.now() < domDeadline) {
    state = await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('.card'))
      return {
        title: document.title,
        questionCount: cards.length,
        questions: cards.map((card) => card.querySelector('.question')?.textContent ?? ''),
        headers: Array.from(document.querySelectorAll('.chip')).map((chip) => chip.textContent),
        options: Array.from(document.querySelectorAll('.option .label')).map((node) => node.textContent),
        timer: document.querySelector('#timer')?.hidden === false ? document.querySelector('#timer').textContent : null,
        submitDisabled: document.querySelector('#submit')?.disabled ?? null,
        readyState: document.readyState,
        visibility: document.visibilityState
      }
    })()`)
    if (state !== undefined && state.readyState === 'complete' && state.questionCount > 0) break
    await sleep(100)
  }
  const renderedAt = Date.now()
  // The host announces the native show over SSE (`shown` → body.dataset.window);
  // document.visibilityState is NOT usable: a non-activated Chromium app window
  // stays "hidden" even while it is on screen.
  const visibleDeadline = Date.now() + 20000
  let visibleAt
  let shownEvent
  while (Date.now() < visibleDeadline) {
    const status = await page.evaluate(`(() => ({
      window: document.body.dataset.window ?? null,
      state: document.querySelector('#timer')?.textContent ?? null
    }))()`)
    if (status !== undefined && status.window === 'shown') { visibleAt = Date.now(); shownEvent = status; break }
    await sleep(80)
  }
  const evidence = { action, label, targetUrl: target.url, renderedAt, renderedIso: new Date(renderedAt).toISOString(), visibleAt, visibleIso: visibleAt === undefined ? null : new Date(visibleAt).toISOString(), shownEvent, dom: state }
  if (state === undefined || state.questionCount === 0) {
    console.log(JSON.stringify({ ...evidence, error: 'question DOM never rendered' }))
    process.exit(2)
  }

  if (action === 'observe') {
    console.log(JSON.stringify(evidence))
    page.close()
    return
  }

  if (action === 'dismiss') {
    const clicked = await page.evaluate(`(() => { const button = document.querySelector('#close'); if (!button) return false; button.click(); return true })()`)
    const at = Date.now()
    console.log(JSON.stringify({ ...evidence, dismissClicked: clicked, actionAt: at, actionIso: new Date(at).toISOString() }))
    page.close()
    return
  }

  // action === 'answer'
  const clicked = await page.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.option'))
    const match = rows.find((row) => row.dataset.label === ${JSON.stringify(label)})
    if (!match) return { ok: false, labels: rows.map((row) => row.dataset.label) }
    match.click()
    return { ok: true, label: match.dataset.label }
  })()`)
  await sleep(120)
  const beforeSubmit = await page.evaluate(`(() => ({
    selected: Array.from(document.querySelectorAll('.option.selected')).map((row) => row.dataset.label),
    submitDisabled: document.querySelector('#submit')?.disabled ?? null
  }))()`)
  const submitClicked = await page.evaluate(`(() => { const button = document.querySelector('#submit'); if (!button || button.disabled) return false; button.click(); return true })()`)
  const actionAt = Date.now()
  console.log(JSON.stringify({
    ...evidence,
    clicked,
    beforeSubmit,
    submitClicked,
    actionAt,
    actionIso: new Date(actionAt).toISOString()
  }))
  page.close()
}

main().catch((error) => {
  console.log(JSON.stringify({ action, error: String(error?.message ?? error) }))
  process.exit(1)
})
