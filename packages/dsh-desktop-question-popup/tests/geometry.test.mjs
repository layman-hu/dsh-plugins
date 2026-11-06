import assert from 'node:assert/strict'
import test from 'node:test'
import { clampHeight, computePopupRect } from '../lib/window.js'

const AREA = { x: 0, y: 0, width: 1707, height: 912 }

test('places the window in the bottom-right corner with a 12 DIP margin', () => {
  assert.deepEqual(computePopupRect(AREA, { width: 460, height: 400, margin: 12 }), {
    x: 1235,
    y: 500,
    width: 460,
    height: 400
  })
  const rect = computePopupRect(AREA, { width: 460, height: 400 })
  assert.equal(AREA.width - (rect.x + rect.width), 12)
  assert.equal(AREA.height - (rect.y + rect.height), 12)
})

test('keeps the right and bottom margins within the 24 DIP acceptance bound', () => {
  const rect = computePopupRect(AREA, { width: 460, height: 620, margin: 12 })
  assert.ok(AREA.width - (rect.x + rect.width) <= 24)
  assert.ok(AREA.height - (rect.y + rect.height) <= 24)
  assert.equal(rect.width, 460)
})

test('honours a non-zero work-area origin', () => {
  const rect = computePopupRect({ x: 100, y: 50, width: 1000, height: 800 }, { width: 460, height: 300, margin: 10 })
  assert.deepEqual(rect, { x: 630, y: 540, width: 460, height: 300 })
})

test('clamps height into [minHeight, maxHeight]', () => {
  assert.equal(clampHeight(10, 240, 620), 240)
  assert.equal(clampHeight(5000, 240, 620), 620)
  assert.equal(clampHeight(333.6, 240, 620), 334)
  assert.equal(clampHeight(Number.NaN, 240, 620), 240)
  assert.equal(clampHeight('420', 240, 620), 420)
  assert.equal(clampHeight(Infinity, 240, 620), 240)
  assert.equal(clampHeight(-0, 240, 620), 240)
})

test('clamps the requested size to the work area', () => {
  const rect = computePopupRect({ x: 0, y: 0, width: 500, height: 300 }, { width: 460, height: 620, margin: 12 })
  assert.equal(rect.width, 460)
  assert.equal(rect.height, 276)
  assert.equal(rect.x, 28)
  assert.equal(rect.y, 12)
})

test('falls back to a sane area for malformed work-area values', () => {
  for (const area of [undefined, null, {}, { width: 0, height: 0 }, { x: Number.NaN, y: 0, width: 100, height: 100 }]) {
    const rect = computePopupRect(area, { width: 460, height: 300, margin: 12 })
    assert.equal(rect.width, 460)
    assert.equal(rect.height, 300)
    assert.ok(rect.x >= 0 && rect.y >= 0)
  }
})

test('negative and non-integer margins fall back to the default', () => {
  const rect = computePopupRect(AREA, { width: 460, height: 300, margin: -5 })
  assert.equal(AREA.width - (rect.x + rect.width), 12)
})
