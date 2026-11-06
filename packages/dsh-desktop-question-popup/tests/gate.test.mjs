import assert from 'node:assert/strict'
import test from 'node:test'
import { PopupGate } from '../lib/gate.js'

test('second acquire fails while the slot is held', () => {
  const gate = new PopupGate()
  assert.equal(gate.isBusy, false)
  const release = gate.tryAcquire()
  assert.equal(typeof release, 'function')
  assert.equal(gate.isBusy, true)
  assert.equal(gate.tryAcquire(), undefined)
})

test('release frees the slot and is idempotent', () => {
  const gate = new PopupGate()
  const release = gate.tryAcquire()
  release()
  release()
  assert.equal(gate.isBusy, false)
  const again = gate.tryAcquire()
  assert.equal(typeof again, 'function')
  again()
})

test('serializes sequential questions one at a time', async () => {
  const gate = new PopupGate()
  const order = []
  const runQuestion = async (name) => {
    const release = gate.tryAcquire()
    if (release === undefined) {
      order.push(`${name}:busy`)
      return
    }
    order.push(`${name}:open`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    order.push(`${name}:close`)
    release()
  }
  await Promise.all([runQuestion('first'), runQuestion('second')])
  assert.deepEqual(order, ['first:open', 'second:busy', 'first:close'])
})
