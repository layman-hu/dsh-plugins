import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../lib/index.js'

test('empty config yields the documented defaults', () => {
  assert.deepEqual(normalizeConfig(undefined), {
    enabled: true,
    shadowTimedTool: true,
    timeout: 120,
    width: 460,
    minHeight: 240,
    maxHeight: 620,
    margin: 12,
    edgePath: undefined,
    shellPath: undefined,
    userDataDir: normalizeConfig(undefined).userDataDir,
    logFile: normalizeConfig(undefined).logFile,
    debugPort: 0
  })
  assert.match(normalizeConfig(undefined).userDataDir, /dsh-question-popup[\\/]edge-profile$/)
  assert.match(normalizeConfig(undefined).logFile, /dsh-question-popup[\\/]popup\.log$/)
})

test('valid overrides are kept and rounded values are rejected as malformed', () => {
  const config = normalizeConfig({
    enabled: false,
    shadowTimedTool: false,
    timeout: 30,
    width: 500,
    minHeight: 200,
    maxHeight: 700,
    margin: 20,
    edgePath: 'C:\\Edge\\msedge.exe',
    shellPath: 'pwsh.exe',
    userDataDir: 'C:\\tmp\\profile',
    logFile: 'C:\\tmp\\log.txt',
    debugPort: 9334
  })
  assert.equal(config.enabled, false)
  assert.equal(config.shadowTimedTool, false)
  assert.equal(config.timeout, 30)
  assert.equal(config.width, 500)
  assert.equal(config.margin, 20)
  assert.equal(config.debugPort, 9334)
  assert.equal(config.edgePath, 'C:\\Edge\\msedge.exe')
  assert.equal(config.userDataDir, 'C:\\tmp\\profile')
})

test('malformed values fall back instead of throwing', () => {
  const config = normalizeConfig({ timeout: 0, width: -1, margin: -3, debugPort: 1.5, edgePath: '', enabled: 0 })
  assert.equal(config.timeout, 120)
  assert.equal(config.width, 460)
  assert.equal(config.margin, 12)
  assert.equal(config.debugPort, 0)
  assert.equal(config.edgePath, undefined)
  assert.equal(config.enabled, true)
})

test('non-object config is treated as empty', () => {
  for (const value of [null, 'x', 42, []]) {
    const config = normalizeConfig(value)
    assert.equal(config.timeout, 120)
    assert.equal(config.width, 460)
  }
})
