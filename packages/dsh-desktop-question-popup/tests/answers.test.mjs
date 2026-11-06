import assert from 'node:assert/strict'
import test from 'node:test'
import { validateAnswers } from '../lib/server.js'

const SINGLE = [{ id: 'q1', question: '请选择颜色', options: [{ label: '红色' }, { label: '蓝色' }] }]
const MULTI = [{ id: 'q1', question: '请选择颜色', multiSelect: true, options: [{ label: '红' }, { label: '绿' }, { label: '蓝' }] }]
const TWO = [
  { id: 'q1', question: '一', options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'q2', question: '二' }
]

function rejected(questions, payload) {
  const verdict = validateAnswers(questions, payload)
  assert.equal(verdict.ok, false, `expected rejection, got ${JSON.stringify(verdict)}`)
  assert.equal(typeof verdict.error, 'string')
  return verdict.error
}

test('accepts one option for a single-select question', () => {
  assert.deepEqual(validateAnswers(SINGLE, { answers: [{ id: 'q1', selected: ['红色'] }] }), {
    ok: true,
    answers: [{ id: 'q1', selected: ['红色'] }]
  })
})

test('accepts multiple options for a multi-select question', () => {
  assert.deepEqual(validateAnswers(MULTI, { answers: [{ id: 'q1', selected: ['红', '蓝'] }] }), {
    ok: true,
    answers: [{ id: 'q1', selected: ['红', '蓝'] }]
  })
})

test('accepts a custom answer', () => {
  assert.deepEqual(validateAnswers(SINGLE, { answers: [{ id: 'q1', selected: [], custom: '  紫色  ' }] }), {
    ok: true,
    answers: [{ id: 'q1', selected: [], custom: '紫色' }]
  })
})

test('empty selected with no custom is a legal explicit skip', () => {
  assert.deepEqual(validateAnswers(SINGLE, { answers: [{ id: 'q1', selected: [] }] }), {
    ok: true,
    answers: [{ id: 'q1', selected: [] }]
  })
})

test('blank custom counts as skipped, not as a custom answer', () => {
  assert.deepEqual(validateAnswers(SINGLE, { answers: [{ id: 'q1', selected: [], custom: '   ' }] }), {
    ok: true,
    answers: [{ id: 'q1', selected: [] }]
  })
})

test('accepts a batch covering every question exactly once', () => {
  const verdict = validateAnswers(TWO, {
    answers: [
      { id: 'q1', selected: ['B'] },
      { id: 'q2', selected: [], custom: '直接说' }
    ]
  })
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.answers, [
    { id: 'q1', selected: ['B'] },
    { id: 'q2', selected: [], custom: '直接说' }
  ])
})

test('rejects empty answer list', () => {
  rejected(SINGLE, { answers: [] })
})

test('rejects a missing question answer', () => {
  rejected(TWO, { answers: [{ id: 'q1', selected: ['A'] }] })
})

test('rejects duplicate answers for one question', () => {
  rejected(SINGLE, { answers: [{ id: 'q1', selected: [] }, { id: 'q1', selected: [] }] })
})

test('rejects an unknown question id', () => {
  rejected(SINGLE, { answers: [{ id: 'zzz', selected: [] }] })
})

test('rejects a label that is not one of the options', () => {
  rejected(SINGLE, { answers: [{ id: 'q1', selected: ['绿色'] }] })
})

test('rejects two selections on a single-select question', () => {
  rejected(SINGLE, { answers: [{ id: 'q1', selected: ['红色', '蓝色'] }] })
})

test('rejects a duplicated label', () => {
  rejected(MULTI, { answers: [{ id: 'q1', selected: ['红', '红'] }] })
})

test('rejects selected when it is not an array', () => {
  rejected(SINGLE, { answers: [{ id: 'q1', selected: '红色' }] })
})

test('rejects non-string labels', () => {
  rejected(SINGLE, { answers: [{ id: 'q1', selected: [42] }] })
})

test('rejects non-object items', () => {
  rejected(SINGLE, { answers: [null] })
  rejected(SINGLE, { answers: ['q1'] })
})

test('rejects a non-object body', () => {
  rejected(SINGLE, null)
  rejected(SINGLE, [])
  rejected(SINGLE, 'answers')
})

test('rejects a body without an answers array', () => {
  rejected(SINGLE, {})
  rejected(SINGLE, { answers: {} })
})

test('rejects a non-string custom answer', () => {
  rejected(SINGLE, { answers: [{ id: 'q1', selected: [], custom: 42 }] })
})

test('rejects an oversized custom answer', () => {
  rejected(SINGLE, { answers: [{ id: 'q1', selected: [], custom: 'x'.repeat(4001) }] })
})

test('rejects a body with no active questions', () => {
  rejected([], { answers: [] })
  rejected(undefined, { answers: [] })
})

test('ignores inherited answer keys (prototype pollution attempt)', () => {
  const payload = Object.create({ answers: [{ id: 'q1', selected: [] }] })
  rejected(SINGLE, payload)
})
