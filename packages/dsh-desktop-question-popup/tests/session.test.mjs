import assert from 'node:assert/strict'
import test from 'node:test'
import { PopupSession, readRemainingMs, waitForHeight } from '../lib/session.js'

const QUESTION = {
  id: 'q1',
  question: '请选择颜色',
  header: '确认',
  options: [{ label: '红', description: '暖色' }, { label: '蓝' }],
  multiSelect: false
}

function fakeActive() {
  const events = []
  const active = {
    server: {
      hasPage: true,
      begin(payload) { events.push({ type: 'begin', payload }) },
      end(reason) { events.push({ type: 'end', reason }) },
      sendEvent(event, data) { events.push({ type: 'sse', event, data }) }
    },
    win: {
      shown: undefined,
      visible: false,
      topmost: false,
      rect: undefined,
      async show(height) {
        this.shown = height
        this.visible = true
        this.topmost = true
        this.rect = { x: 1235, y: 568, width: 460, height }
        events.push({ type: 'show', height })
      },
      async hide() { this.shown = undefined; this.visible = false; events.push({ type: 'hide' }) },
      async resize(height) { events.push({ type: 'resize', height }) },
      async reassertTopmost() { this.topmost = true; return true },
      async status() { return { exists: active.win.windowExists !== false, visible: this.visible, topmost: this.topmost } },
      windowExists: true
    }
  }
  return { active, events }
}

function makeSession(overrides = {}) {
  const { active, events } = fakeActive()
  const controller = new AbortController()
  const request = {
    wait: { callId: 'call-1', timed: true },
    agent: { id: 'agent-1' },
    signal: controller.signal,
    questions: [QUESTION],
    ...overrides.request
  }
  const closed = []
  const session = new PopupSession({
    ctx: {
      userQuestions: {
        attachWait() {
          return (async function* () {
            yield { remainingMs: 5000 }
            await new Promise(() => {})
          })()
        }
      }
    },
    active,
    request,
    nextSeq: () => 7,
    onWindowClosed: async () => { closed.push(true) },
    ...overrides.session
  })
  return { session, active, events, controller, closed, request }
}

async function showSession(session, events, height = 360) {
  const shown = session.show()
  // The session drops the idle page height before publishing; report the real
  // question height only after the batch is live (as the page does).
  while (!events.some((event) => event.type === 'begin')) await new Promise((resolve) => setTimeout(resolve, 5))
  session.applyHeight(height)
  await shown
}

test('publishes the question and shows at the reported height', async () => {
  const { session, events } = makeSession()
  await showSession(session, events)
  const begin = events.find((event) => event.type === 'begin')
  assert.equal(begin.payload.seq, 7)
  assert.equal(begin.payload.callId, 'call-1')
  assert.equal(begin.payload.remainingMs, 5000)
  assert.deepEqual(begin.payload.questions, [{
    id: 'q1',
    question: '请选择颜色',
    header: '确认',
    options: [{ label: '红', description: '暖色' }, { label: '蓝' }],
    multiSelect: false
  }])
  assert.deepEqual(events.find((event) => event.type === 'show'), { type: 'show', height: 360 })
})

test('popup answer wins: hides, ends the page session, returns the batch', async () => {
  const { session, events } = makeSession()
  await showSession(session, events)
  const pending = session.run(new Promise(() => {}))
  session.resolveAnswer([{ id: 'q1', selected: ['红'] }])
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['红'] }] })
  assert.ok(events.some((event) => event.type === 'hide'))
  assert.deepEqual(events.find((event) => event.type === 'end'), { type: 'end', reason: 'answered' })
})

test('native answer wins: hides the popup and returns the native batch', async () => {
  const { session, events } = makeSession()
  await showSession(session, events)
  const native = Promise.resolve({ answers: [{ id: 'q1', selected: ['蓝'] }] })
  const result = await session.run(native)
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['蓝'] }] })
  assert.ok(events.some((event) => event.type === 'hide'))
  assert.deepEqual(events.find((event) => event.type === 'end'), { type: 'end', reason: 'answered-elsewhere' })
})

test('a native failure is rethrown (askTimed maps it), popup still hides', async () => {
  const { session, events } = makeSession()
  await showSession(session, events)
  const error = Object.assign(new Error('no user-questions answerer accepted the request'), { code: 'NO_PROVIDER' })
  await assert.rejects(session.run(Promise.reject(error)), /no user-questions answerer/)
  assert.ok(events.some((event) => event.type === 'hide'))
  assert.equal(events.find((event) => event.type === 'end').reason, 'answered-elsewhere')
})

test('a native timeout hides the popup with the timeout reason', async () => {
  const { session, events } = makeSession()
  await showSession(session, events)
  const error = Object.assign(new Error('ask_user_question timed out before the user answered'), { code: 'ASK_TIMED_OUT' })
  await assert.rejects(session.run(Promise.reject(error)), /timed out/)
  assert.deepEqual(events.find((event) => event.type === 'end'), { type: 'end', reason: 'timeout' })
  assert.ok(events.some((event) => event.type === 'sse' && event.event === 'hidden'))
})

test('dismiss does not produce an answer: the native path keeps waiting', async () => {
  const { session, events } = makeSession()
  await showSession(session, events)
  let settleNative
  const native = new Promise((resolve) => { settleNative = resolve })
  const pending = session.run(native)
  session.resolveDismiss()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(events.find((event) => event.type === 'end').reason, 'dismissed')
  settleNative({ answers: [{ id: 'q1', selected: ['蓝'] }] })
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['蓝'] }] })
})

test('dismiss followed by a native rejection propagates the rejection', async () => {
  const { session, events } = makeSession()
  await showSession(session, events)
  const error = new Error('aborted by the user')
  const pending = session.run(Promise.reject(error))
  session.resolveDismiss()
  await assert.rejects(pending, /aborted by the user/)
})

test('abort of the timed wait hides the popup and ends the wait as timeout', async () => {
  const { session, events, controller } = makeSession()
  await showSession(session, events)
  const error = Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' })
  let rejectNative
  const native = new Promise((_resolve, reject) => { rejectNative = reject })
  const pending = session.run(native)
  controller.abort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(events.find((event) => event.type === 'end').reason, 'timeout')
  rejectNative(error)
  await assert.rejects(pending, /timed out/)
})

test('a user-closed window is a dismiss, and the browser is torn down', async () => {
  const { session, active, events, closed } = makeSession()
  await showSession(session, events)
  active.win.windowExists = false
  let settleNative
  const native = new Promise((resolve) => { settleNative = resolve })
  const pending = session.run(native)
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(events.find((event) => event.type === 'end').reason, 'window-closed')
  assert.equal(closed.length, 1)
  settleNative({ answers: [{ id: 'q1', selected: [] }] })
  await pending
})

test('height reported after showing resizes the visible window', async () => {
  const { session, events } = makeSession()
  await showSession(session, events)
  session.applyHeight(500)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events.filter((event) => event.type === 'resize'), [{ type: 'resize', height: 500 }])
})

test('close is idempotent and hides at most once', async () => {
  const { session, events } = makeSession()
  await showSession(session, events)
  await session.close()
  await session.close()
  assert.equal(events.filter((event) => event.type === 'hide').length, 1)
})

test('waitForHeight resolves immediately when a height is known', async () => {
  const started = Date.now()
  await waitForHeight({ height: 300 }, 700)
  assert.ok(Date.now() - started < 200)
})

test('waitForHeight resolves on its budget when no height arrives', async () => {
  const started = Date.now()
  await waitForHeight({ height: undefined }, 60)
  assert.ok(Date.now() - started < 600)
})

test('readRemainingMs reads one frame from attachWait', async () => {
  const value = await readRemainingMs({
    userQuestions: {
      attachWait() {
        return (async function* () {
          yield { remainingMs: 4200 }
          await new Promise(() => {})
        })()
      }
    }
  }, { wait: { callId: 'c', timed: true }, agent: { id: 'a' } })
  assert.equal(value, 4200)
})

test('readRemainingMs stays undefined for non-timed requests', async () => {
  assert.equal(await readRemainingMs({ userQuestions: {} }, { wait: { callId: 'c' } }), undefined)
  assert.equal(await readRemainingMs({ userQuestions: {} }, { wait: { callId: 'c', timed: true } }), undefined)
})

test('readRemainingMs swallows a failing wait probe', async () => {
  const value = await readRemainingMs({
    userQuestions: {
      attachWait() { throw new Error('no live wait') }
    }
  }, { wait: { callId: 'c', timed: true }, agent: { id: 'a' } })
  assert.equal(value, undefined)
})
