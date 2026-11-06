import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PopupServer } from '../lib/server.js'

const TOKEN = 'test-token-123'
const PAGE = '<!doctype html><meta name="dsh-token" content="__DSH_TOKEN__"><title>t</title>'

function makePage() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-popup-test-'))
  const pagePath = join(dir, 'popup.html')
  writeFileSync(pagePath, PAGE)
  return { dir, pagePath }
}

async function readUntil(reader, needle, timeoutMs = 3000) {
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  while (!text.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}; got ${text}`)
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

test('serves the tokenized page only with the right token', async () => {
  const { dir, pagePath } = makePage()
  const server = new PopupServer({ pagePath, token: TOKEN })
  try {
    await server.start()
    assert.ok(server.port > 0)
    assert.match(server.pageUrl, /^http:\/\/127\.0\.0\.1:\d+\/popup\?token=test-token-123$/)

    const forbidden = await fetch(`http://127.0.0.1:${server.port}/popup`)
    assert.equal(forbidden.status, 403)

    const ok = await fetch(server.pageUrl)
    assert.equal(ok.status, 200)
    const html = await ok.text()
    assert.ok(html.includes(TOKEN))
    assert.ok(!html.includes('__DSH_TOKEN__'))
  } finally {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('answers flow through the page session with validation', async () => {
  const { dir, pagePath } = makePage()
  const seen = { answered: [], dismissed: 0, heights: [] }
  const server = new PopupServer({
    pagePath,
    token: TOKEN,
    onAnswer: (answers) => seen.answered.push(answers),
    onDismiss: () => { seen.dismissed += 1 },
    onHeight: (height) => seen.heights.push(height)
  })
  try {
    await server.start()
    const base = server.baseUrl
    const url = (path) => `${base}${path}?token=${TOKEN}`

    // ready
    const ready = await fetch(url('/ready'), { method: 'POST', body: '{}' })
    assert.equal(ready.status, 200)
    assert.equal(await server.waitForReady(500), true)

    // SSE stream opens before the question is published
    const stream = await fetch(url('/events'))
    assert.equal(stream.status, 200)
    assert.match(stream.headers.get('content-type'), /text\/event-stream/)
    const reader = stream.body.getReader()
    await readUntil(reader, 'retry:')

    server.begin({
      seq: 1,
      callId: 'call-1',
      remainingMs: 118000,
      questions: [{ id: 'q1', question: '请选择颜色', options: [{ label: '红' }, { label: '蓝' }] }]
    })
    const questionFrame = await readUntil(reader, '"seq":1')
    assert.match(questionFrame, /event: question/)
    assert.match(questionFrame, /"callId":"call-1"/)

    // invalid answer is rejected and not submitted
    const invalid = await fetch(url('/answer'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [{ id: 'q1', selected: ['绿'] }] })
    })
    assert.equal(invalid.status, 400)
    assert.equal(seen.answered.length, 0)

    // valid answer is normalized and submitted once
    const accepted = await fetch(url('/answer'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [{ id: 'q1', selected: ['蓝'] }] })
    })
    assert.equal(accepted.status, 200)
    assert.deepEqual(seen.answered, [[{ id: 'q1', selected: ['蓝'] }]])

    // a second batch for the same question is refused
    const duplicate = await fetch(url('/answer'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [{ id: 'q1', selected: ['红'] }] })
    })
    assert.equal(duplicate.status, 409)
    assert.equal(seen.answered.length, 1)

    // question ended: page receives a dismiss frame
    server.end('answered')
    const dismissFrame = await readUntil(reader, 'event: dismiss')
    assert.match(dismissFrame, /"reason":"answered"/)

    // height reports are forwarded
    const height = await fetch(url('/height'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ height: 420 })
    })
    assert.equal(height.status, 200)
    assert.deepEqual(seen.heights, [420])

    // dismiss without an active question is a conflict
    const staleDismiss = await fetch(url('/dismiss'), { method: 'POST', body: '{}' })
    assert.equal(staleDismiss.status, 409)

    // and with an active question it notifies the host
    server.begin({ seq: 2, questions: [{ id: 'q2', question: '再问一次' }] })
    const dismissed = await fetch(url('/dismiss'), { method: 'POST', body: '{}' })
    assert.equal(dismissed.status, 200)
    assert.equal(seen.dismissed, 1)
    server.end('dismissed')
    reader.cancel().catch(() => {})
  } finally {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects requests with a wrong token on every route', async () => {
  const { dir, pagePath } = makePage()
  const server = new PopupServer({ pagePath, token: TOKEN })
  try {
    await server.start()
    for (const route of ['/events', '/ready', '/answer', '/dismiss', '/height']) {
      const response = await fetch(`http://127.0.0.1:${server.port}${route}?token=wrong`, { method: 'POST', body: '{}' })
      assert.equal(response.status, 403, route)
    }
  } finally {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stop closes the socket so the port no longer answers', async () => {
  const { dir, pagePath } = makePage()
  const server = new PopupServer({ pagePath, token: TOKEN })
  await server.start()
  const port = server.port
  await server.stop()
  await assert.rejects(fetch(`http://127.0.0.1:${port}/popup?token=${TOKEN}`))
  rmSync(dir, { recursive: true, force: true })
})
