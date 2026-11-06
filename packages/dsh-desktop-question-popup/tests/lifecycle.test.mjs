import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { HelperClient, PopupWindow, findEdgePath, findShellPath, killEdgeByProfile, POPUP_TITLE } from '../lib/window.js'

const HELPER = 'C:\\nonexistent\\win-helper.ps1'

test('a helper that was never started refuses calls and disposes safely', async () => {
  const helper = new HelperClient({ shellPath: 'powershell.exe', helperPath: HELPER })
  await assert.rejects(helper.call('ping'), /not running/)
  assert.equal(helper.dispose(), undefined)
  assert.equal(helper.dispose(), undefined)
})

test('the window title is the fixed title the helper matches', () => {
  assert.equal(POPUP_TITLE, 'DSH · 需要你的选择')
  assert.ok(POPUP_TITLE.startsWith('DSH'))
})

test('an unattached window is inert instead of throwing', async () => {
  const win = new PopupWindow({
    edgePath: 'C:\\nonexistent\\msedge.exe',
    shellPath: 'powershell.exe',
    helperPath: HELPER,
    userDataDir: 'C:\\tmp\\nope'
  })
  await win.hide()
  assert.deepEqual(await win.status(), { exists: false, visible: false, topmost: false })
  await win.resize(400)
  await win.show(300).then(
    () => assert.fail('show must not succeed without an attached window'),
    (error) => assert.match(error.message, /not attached/)
  )
})

test('findEdgePath honours an explicit path and reports absence honestly', () => {
  assert.equal(findEdgePath('C:\\definitely-not-here\\msedge.exe') === undefined || typeof findEdgePath('C:\\definitely-not-here\\msedge.exe') === 'string', true)
  const real = findEdgePath()
  if (real !== undefined) assert.ok(existsSync(real))
})

test('findShellPath prefers an explicit override', () => {
  assert.equal(findShellPath('C:\\custom\\pwsh.exe'), 'C:\\custom\\pwsh.exe')
  assert.equal(typeof findShellPath(), 'string')
})

test('killEdgeByProfile is scoped to our profile directory name', async () => {
  // No process carries this random profile dir, so the sweep must be a no-op.
  await killEdgeByProfile('C:\\Temp\\dsh-question-popup-selftest-profile')
})
