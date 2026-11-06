import assert from 'node:assert/strict'
import test from 'node:test'
import { validateTimeout, normalizeQuestions, answerResult, createTimedAskUserTool, TIMED_TOOL_NAME } from '../lib/shadow-tool.js'

test('timeout validation matches the shipped tool', () => {
  assert.equal(validateTimeout(-1), -1)
  assert.equal(validateTimeout(1), 1)
  assert.equal(validateTimeout(2147483), 2147483)
  for (const bad of [0, -2, 1.5, 2147484, '120', null, undefined, Number.NaN]) {
    assert.throws(() => validateTimeout(bad), /timeout must be -1 or a positive integer up to 2147483 seconds/)
  }
})

test('the shadowed tool keeps the shipped name and description', () => {
  const tool = createTimedAskUserTool({ ctx: { userQuestions: {} }, timeout: 120 })
  assert.equal(tool.name, TIMED_TOOL_NAME)
  assert.equal(tool.name, 'ask_user_question')
  assert.match(tool.description, /^Ask brief, direct, self-contained questions about missing information/)
  assert.match(tool.description, /A pending result instead means no answer batch arrived before the timeout and the user can still answer\.$/)
})

test('the parameter schema declares questions and the timed timeout parameter', () => {
  const tool = createTimedAskUserTool({ ctx: { userQuestions: {} }, timeout: 90 })
  const parameters = tool.parameters
  assert.equal(parameters.type, 'object')
  assert.deepEqual(parameters.required, ['questions'])
  assert.ok(parameters.properties.questions)
  assert.equal(parameters.properties.questions.items.properties.multi_select.type, 'boolean')
  assert.equal(parameters.properties.questions.items.properties.options.items.properties.label.type, 'string')
  assert.equal(parameters.properties.timeout.type, 'integer')
  assert.match(parameters.properties.timeout.description, /\(default 90\)/)
  assert.match(parameters.properties.timeout.description, /Use -1 only when an answer is required before proceeding\./)
})

test('the output schema offers the pending and answers variants', () => {
  const tool = createTimedAskUserTool({ ctx: { userQuestions: {} } })
  const oneOf = tool.output.schema.oneOf
  assert.equal(oneOf.length, 2)
  assert.deepEqual(Object.keys(oneOf[0].properties), ['pending', 'callId', 'message'])
  assert.deepEqual(oneOf[0].required, ['pending', 'callId', 'message'])
  assert.deepEqual(Object.keys(oneOf[1].properties.answers.items.properties), ['id', 'selected', 'custom'])
  assert.deepEqual(oneOf[1].properties.answers.items.required, ['id', 'selected'])
  const rendered = tool.output.render({}, { answers: [] })
  assert.deepEqual(rendered, [{ type: 'text', text: '{"answers":[]}' }])
})

test('schemas are plain JSON Schema: required is an array, never a property annotation', () => {
  const tool = createTimedAskUserTool({ ctx: { userQuestions: {} } })
  const violations = []
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    if (Object.hasOwn(node, 'required') && !Array.isArray(node.required)) {
      violations.push(`${path}.required must be an array`)
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        for (const [name, child] of Object.entries(value)) walk(child, `${path}.properties.${name}`)
      } else if (key === 'items') walk(value, `${path}.items`)
      else if (key === 'oneOf') value.forEach((child, index) => walk(child, `${path}.oneOf[${index}]`))
    }
  }
  walk(tool.parameters, 'parameters')
  walk(tool.output.schema, 'schema')
  assert.deepEqual(violations, [])
})

test('questions are normalized into service vocabulary', () => {
  const questions = normalizeQuestions([{
    id: 'q1',
    question: '请选择颜色',
    header: '确认',
    multi_select: true,
    options: [{ label: '红', description: '暖色' }, { label: '蓝' }],
    ignored: 'x'
  }])
  assert.deepEqual(questions, [{
    id: 'q1',
    question: '请选择颜色',
    header: '确认',
    options: [{ label: '红', description: '暖色' }, { label: '蓝' }],
    multiSelect: true
  }])
})

test('malformed questions are rejected', () => {
  for (const bad of [undefined, [], 'q1', [null], [{}], [{ id: '', question: 'x' }], [{ id: 'a' }], [{ id: 'a', question: 'x' }, { id: 'a', question: 'y' }]]) {
    assert.throws(() => normalizeQuestions(bad), /invalid arguments|must be unique/)
  }
})

test('answerResult copies selected arrays and keeps custom', () => {
  const result = answerResult({ answers: [{ id: 'q1', selected: ['A'], custom: 'x' }, { id: 'q2', selected: [] }] })
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['A'], custom: 'x' }, { id: 'q2', selected: [] }] })
  assert.notEqual(result.answers[0].selected, undefined)
})

function fakeHost() {
  const calls = { askTimed: [], ask: [] }
  return {
    calls,
    ctx: {
      userQuestions: {
        async askTimed(request, callId, timeoutMs) {
          calls.askTimed.push({ request, callId, timeoutMs })
          return { answers: [{ id: 'q1', selected: ['红'] }] }
        },
        async ask(request) {
          calls.ask.push(request)
          return { answers: [{ id: 'q1', selected: ['蓝'] }] }
        }
      }
    }
  }
}

test('timeout >= 1 uses askTimed with the call id and millisecond budget (popup participates)', async () => {
  const host = fakeHost()
  const tool = createTimedAskUserTool({ ctx: host.ctx, timeout: 120 })
  const result = await tool.execute({ questions: [{ id: 'q1', question: '颜色', options: [{ label: '红' }] }], timeout: 5 }, {
    callId: 'call-1',
    agent: { id: 'agent-1' }
  })
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['红'] }] })
  assert.equal(host.calls.askTimed.length, 1)
  assert.equal(host.calls.askTimed[0].callId, 'call-1')
  assert.equal(host.calls.askTimed[0].timeoutMs, 5000)
  assert.equal(host.calls.ask.length, 0)
})

test('the default timeout comes from config', async () => {
  const host = fakeHost()
  const tool = createTimedAskUserTool({ ctx: host.ctx, timeout: 42 })
  await tool.execute({ questions: [{ id: 'q1', question: '颜色' }] }, { callId: 'c', agent: { id: 'a' } })
  assert.equal(host.calls.askTimed[0].timeoutMs, 42000)
})

test('a pending result carries the shipped pending notice', async () => {
  const host = fakeHost()
  host.ctx.userQuestions.askTimed = async () => ({ pending: true, callId: 'call-1' })
  const tool = createTimedAskUserTool({ ctx: host.ctx })
  const result = await tool.execute({ questions: [{ id: 'q1', question: '颜色' }] }, { callId: 'call-1', agent: { id: 'a' } })
  assert.equal(result.pending, true)
  assert.equal(result.callId, 'call-1')
  assert.match(result.message, /No answer batch arrived before the timeout/)
})

test('timeout -1 uses the blocking ask() path without popup participation', async () => {
  const host = fakeHost()
  const tool = createTimedAskUserTool({ ctx: host.ctx })
  const result = await tool.execute({ questions: [{ id: 'q1', question: '颜色' }], timeout: -1 }, { callId: 'call-2', agent: { id: 'a' } })
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['蓝'] }] })
  assert.equal(host.calls.askTimed.length, 0)
  assert.equal(host.calls.ask.length, 1)
  assert.deepEqual(host.calls.ask[0].wait, { callId: 'call-2' })
  assert.equal(host.calls.ask[0].agent.id, 'a')
})

test('timed questions without a live agent fail like the shipped tool', async () => {
  const host = fakeHost()
  const tool = createTimedAskUserTool({ ctx: host.ctx })
  await assert.rejects(tool.execute({ questions: [{ id: 'q1', question: 'x' }] }, { callId: 'c' }), /timed questions require a live agent/)
})

test('invalid arguments reject before reaching the service', async () => {
  const host = fakeHost()
  const tool = createTimedAskUserTool({ ctx: host.ctx })
  await assert.rejects(tool.execute({ questions: [] }, { callId: 'c', agent: { id: 'a' } }), /invalid arguments/)
  await assert.rejects(tool.execute({ questions: [{ id: 'q1', question: 'x' }], timeout: 0 }, { callId: 'c', agent: { id: 'a' } }), /timeout must be -1/)
  assert.equal(host.calls.askTimed.length, 0)
})
