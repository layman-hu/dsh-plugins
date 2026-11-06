// Desktop popup window layer: Edge `--app` window + persistent PowerShell helper.
//
// The helper (lib/win-helper.ps1) owns the native Win32 calls: topmost placement
// (Chromium's --always-on-top does NOT set WS_EX_TOPMOST, measured), the
// bottom-right position, hiding, and window geometry reads. This module only
// orchestrates process lifetimes and speaks one-JSON-line-per-line to the helper.
//
// Only node: builtins are imported here (the host plugin runs from a directory
// with no node_modules; anything else would silently fail to load).

import { spawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Fixed window title; the helper finds the HWND by this prefix. */
export const POPUP_TITLE = 'DSH · 需要你的选择'

/** Window class of an Edge/Chromium app window (measured). */
const WINDOW_CLASS = 'Chrome_WidgetWin_1'

const DEFAULT_WIDTH = 460
const DEFAULT_MIN_HEIGHT = 240
const DEFAULT_MAX_HEIGHT = 620
const DEFAULT_MARGIN = 12
const INITIAL_SHOW_HEIGHT = 260

/**
 * Clamp a desired content height into the popup's allowed range.
 * @param {unknown} value - page-reported height in DIP.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} a finite integer height inside [min, max].
 */
export function clampHeight(value, min = DEFAULT_MIN_HEIGHT, max = DEFAULT_MAX_HEIGHT) {
  const low = Math.min(min, max)
  const high = Math.max(min, max)
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return low
  return Math.min(high, Math.max(low, Math.round(number)))
}

/**
 * Place a window of the given size in the bottom-right corner of a work area.
 * Pure function so the geometry is testable offline.
 * @param {{ x: number, y: number, width: number, height: number }} workArea - primary work area in DIP.
 * @param {{ width?: number, height?: number, margin?: number }} [options] - size and screen edge margin.
 * @returns {{ x: number, y: number, width: number, height: number }} the window rect in DIP.
 */
export function computePopupRect(workArea, options = {}) {
  const area = normalizeWorkArea(workArea)
  const width = positiveInteger(options.width, DEFAULT_WIDTH)
  const margin = nonNegativeInteger(options.margin, DEFAULT_MARGIN)
  const height = clampHeight(
    options.height,
    nonNegativeInteger(options.minHeight, DEFAULT_MIN_HEIGHT),
    nonNegativeInteger(options.maxHeight, DEFAULT_MAX_HEIGHT)
  )
  const maxWidth = Math.max(120, area.width - 2 * margin)
  const maxHeight = Math.max(80, area.height - 2 * margin)
  const finalWidth = Math.min(width, maxWidth)
  const finalHeight = Math.min(height, maxHeight)
  return {
    x: area.x + area.width - finalWidth - margin,
    y: area.y + area.height - finalHeight - margin,
    width: finalWidth,
    height: finalHeight
  }
}

function normalizeWorkArea(workArea) {
  const fallback = { x: 0, y: 0, width: 1280, height: 720 }
  if (workArea === null || typeof workArea !== 'object') return fallback
  const { x, y, width, height } = workArea
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return fallback
  if (width <= 0 || height <= 0) return fallback
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}

function nonNegativeInteger(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback
}

/**
 * Pick the Edge executable to drive. Returns undefined when none is installed.
 * @param {string} [configured] - explicit path from plugin config.
 * @returns {string | undefined} an existing executable path.
 */
export function findEdgePath(configured) {
  const candidates = [
    configured,
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Pick a PowerShell host for the helper: pwsh 7 when present, else Windows PowerShell.
 * @param {string} [configured] - explicit shell path from plugin config.
 * @returns {string} a shell executable name or path.
 */
export function findShellPath(configured) {
  if (typeof configured === 'string' && configured.length > 0) return configured
  const pwsh = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  if (existsSync(pwsh)) return pwsh
  return 'powershell.exe'
}

/**
 * Persistent helper client. One JSON request line in, one JSON response line out.
 */
export class HelperClient {
  /**
   * @param {{ shellPath: string, helperPath: string, logger?: (line: string) => void }} options - process identity.
   */
  constructor({ shellPath, helperPath, logger }) {
    this.shellPath = shellPath
    this.helperPath = helperPath
    this.logger = logger ?? (() => {})
    this.child = undefined
    this.buffer = ''
    this.pending = new Map()
    this.nextId = 1
    this.stopped = false
  }

  /**
   * Spawn the helper and confirm it answers.
   * @param {number} [timeoutMs] - readiness budget.
   * @returns {Promise<void>} resolves once `ping` answered.
   */
  async start(timeoutMs = 8000) {
    if (this.child !== undefined) return
    const child = spawn(this.shellPath, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', this.helperPath
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text.length > 0) this.logger(`helper stderr: ${text}`)
    })
    child.on('exit', (code) => {
      this.child = undefined
      this.stopped = true
      for (const { reject } of this.pending.values()) reject(new Error(`window helper exited (code ${String(code)})`))
      this.pending.clear()
    })
    child.on('error', (error) => this.logger(`helper spawn error: ${String(error?.message ?? error)}`))
    await this.call('ping', {}, timeoutMs)
  }

  #onStdout(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > 0) this.#onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  #onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.logger(`helper emitted non-JSON line: ${line.slice(0, 200)}`)
      return
    }
    const waiter = this.pending.get(message.id)
    if (waiter === undefined) return
    this.pending.delete(message.id)
    if (message.ok === true) waiter.resolve(message.result ?? {})
    else waiter.reject(new Error(String(message.error ?? 'window helper failed')))
  }

  /**
   * Send one op and await its result.
   * @param {string} op - helper operation name.
   * @param {Record<string, unknown>} [args] - op payload.
   * @param {number} [timeoutMs] - response budget.
   * @returns {Promise<any>} helper result.
   */
  call(op, args = {}, timeoutMs = 4000) {
    const child = this.child
    if (child === undefined || this.stopped) return Promise.reject(new Error('window helper is not running'))
    const id = this.nextId++
    const payload = JSON.stringify({ id, op, ...args })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`window helper timed out on ${op}`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      try {
        child.stdin.write(`${payload}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** Stop the helper process. Safe to call repeatedly. */
  dispose() {
    const child = this.child
    this.child = undefined
    this.stopped = true
    if (child === undefined) return
    try {
      child.stdin.write('{"id":0,"op":"quit"}\n')
    } catch {
      // The helper may already be gone.
    }
    const killTimer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
    }, 400)
    if (typeof killTimer.unref === 'function') killTimer.unref()
    try { child.stdin.end() } catch { /* already gone */ }
  }
}

/**
 * One Edge app window plus its helper. Created lazily on the first question.
 */
export class PopupWindow {
  /**
   * @param {object} options - window identity, sizing, and diagnostics.
   * @param {string} options.edgePath - msedge.exe path.
   * @param {string} options.shellPath - PowerShell host for the helper.
   * @param {string} options.helperPath - lib/win-helper.ps1 path.
   * @param {string} options.userDataDir - dedicated Edge profile directory.
   * @param {number} [options.width] - window width in DIP.
   * @param {number} [options.minHeight] - minimum content height.
   * @param {number} [options.maxHeight] - maximum content height.
   * @param {number} [options.margin] - right/bottom screen margin.
   * @param {number} [options.debugPort] - enables Chromium remote debugging when set.
   * @param {(line: string) => void} [options.logger] - one-line diagnostic sink.
   */
  constructor(options) {
    this.edgePath = options.edgePath
    this.userDataDir = options.userDataDir
    this.width = positiveInteger(options.width, DEFAULT_WIDTH)
    this.minHeight = nonNegativeInteger(options.minHeight, DEFAULT_MIN_HEIGHT)
    this.maxHeight = nonNegativeInteger(options.maxHeight, DEFAULT_MAX_HEIGHT)
    this.margin = nonNegativeInteger(options.margin, DEFAULT_MARGIN)
    this.debugPort = Number.isFinite(options.debugPort) && options.debugPort > 0 ? Math.round(options.debugPort) : undefined
    this.logger = options.logger ?? (() => {})
    this.helper = new HelperClient({ shellPath: options.shellPath, helperPath: options.helperPath, logger: this.logger })
    this.edge = undefined
    this.hwnd = 0
    this.workArea = undefined
    this.height = INITIAL_SHOW_HEIGHT
    this.visible = false
    this.topmost = false
    this.rect = undefined
  }

  /**
   * Start the helper and launch the Edge app window offscreen.
   * @param {string} url - popup page URL (already tokenized).
   * @returns {Promise<void>} resolves after the browser process spawned.
   */
  async launch(url) {
    await this.helper.start()
    const area = await this.helper.call('workarea')
    this.workArea = normalizeWorkArea(area)
    const initial = computePopupRect(this.workArea, {
      width: this.width,
      height: INITIAL_SHOW_HEIGHT,
      margin: this.margin,
      minHeight: this.minHeight,
      maxHeight: this.maxHeight
    })
    const args = [
      `--app=${url}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // NOTE: do NOT pass --disable-sync. Measured 2026-11-06: with --disable-sync
      // the Edge app window silently refuses external WS_EX_TOPMOST changes
      // (SetWindowPos returns true, the bit never sticks); without it topmost works.
      '--disable-features=msEdgeSidebarV2,msEdgeCollections,msEdgeIdentityFeature',
      '--disable-background-networking',
      `--window-size=${String(initial.width)},${String(initial.height)}`,
      // Start offscreen: the window is hidden as soon as its HWND exists, so the
      // user never sees an empty popup flash at the corner.
      '--window-position=-4000,-4000'
    ]
    if (this.debugPort !== undefined) args.push(`--remote-debugging-port=${String(this.debugPort)}`)
    // A crashed/cold previous generation can leave msedge processes carrying this
    // profile; a second launch would hand off to them and the fresh page never
    // loads. Clear only OUR profile's processes first.
    await killEdgeByProfile(this.userDataDir, this.logger)
    this.edge = spawn(this.edgePath, args, { stdio: 'ignore', windowsHide: false })
    this.edge.on('exit', (code) => {
      // Chromium's launcher process may exit after handing the browser off, so the
      // spawned PID is NOT proof of life. Window state comes from the helper.
      this.launcherExited = true
      this.logger(`edge launcher exited (code ${String(code)})`)
    })
    this.edge.on('error', (error) => this.logger(`edge spawn error: ${String(error?.message ?? error)}`))
  }

  /**
   * Locate the app window and hide it until the first question is ready.
   * Matching is by title prefix + Chromium window class only: the window may be
   * owned by an Edge process other than the launcher we spawned.
   * @param {number} [timeoutMs] - HWND discovery budget.
   * @returns {Promise<void>} resolves once the window is hidden.
   */
  async attach(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      let found
      try {
        found = await this.helper.call('find', { prefix: 'DSH' }, 2000)
      } catch (error) {
        // A failing probe is not fatal during startup; retry until the budget ends.
        this.logger(`helper find failed (retrying): ${String(error?.message ?? error)}`)
        await delay(200)
        continue
      }
      if (Number(found?.hwnd) > 0) {
        this.hwnd = Number(found.hwnd)
        await this.helper.call('hide', { hwnd: this.hwnd })
        this.visible = false
        const rect = found.rect ?? {}
        this.logger(`popup window attached (hwnd=${String(this.hwnd)}, title=${String(found.title)}, initial=${String(rect.x)},${String(rect.y)},${String(rect.width)}x${String(rect.height)})`)
        return
      }
      await delay(120)
    }
    throw new Error('popup window did not appear')
  }

  /**
   * Show the window bottom-right and topmost at the given content height.
   * Re-asserts the topmost bit because Chromium can revert it while it finishes
   * showing a window (measured: SetWindowPos succeeds but WS_EX_TOPMOST clears).
   * @param {number} height - desired content height in DIP.
   * @returns {Promise<void>} resolves after the helper placed the window.
   */
  async show(height) {
    if (this.hwnd === 0) throw new Error('popup window is not attached')
    this.height = clampHeight(height, this.minHeight, this.maxHeight)
    const rect = this.#rectFor(this.height)
    // Place + show WITHOUT the topmost bit, then assert topmost as a separate call
    // after the window has settled: measured, a topmost request bundled with the
    // show/move is silently reverted by Chromium/Edge.
    let status = await this.helper.call('show', { hwnd: this.hwnd, topmost: false, ...rect }, 6000)
    await delay(400)
    status = await this.helper.call('topmost', { hwnd: this.hwnd })
    for (let attempt = 0; attempt < 5 && status?.topmost !== true; attempt += 1) {
      await delay(250)
      status = await this.helper.call('topmost', { hwnd: this.hwnd })
    }
    this.visible = status?.visible === true
    this.topmost = status?.topmost === true
    this.rect = status?.rect ?? rect
    this.logger(`popup placed at ${String(rect.x)},${String(rect.y)} ${String(rect.width)}x${String(rect.height)} topmost=${String(this.topmost)}`)
  }

  /**
   * Re-assert the topmost bit while the popup is visible.
   * @returns {Promise<boolean>} whether the window reports topmost afterwards.
   */
  async reassertTopmost() {
    if (this.hwnd === 0) return false
    try {
      const status = await this.helper.call('topmost', { hwnd: this.hwnd }, 2000)
      this.topmost = status?.topmost === true
      return this.topmost
    } catch (error) {
      this.logger(`topmost re-assert failed: ${String(error?.message ?? error)}`)
      return false
    }
  }

  /**
   * Resize the window while keeping the bottom-right corner anchored.
   * @param {number} height - desired content height in DIP.
   * @returns {Promise<void>} resolves after the helper placed the window.
   */
  async resize(height) {
    if (this.hwnd === 0) return
    const next = clampHeight(height, this.minHeight, this.maxHeight)
    if (next === this.height) return
    this.height = next
    const rect = this.#rectFor(next)
    await this.helper.call('place', { hwnd: this.hwnd, topmost: true, ...rect })
  }

  /** Hide the window without stopping the browser process. */
  async hide() {
    this.visible = false
    if (this.hwnd === 0) return
    try {
      await this.helper.call('hide', { hwnd: this.hwnd })
    } catch (error) {
      this.logger(`hide failed: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Read current window state from the desktop.
   * @returns {Promise<{ exists: boolean, visible: boolean, topmost: boolean, rect?: object }>} live state.
   */
  async status() {
    if (this.hwnd === 0) return { exists: false, visible: false, topmost: false }
    const status = await this.helper.call('status', { hwnd: this.hwnd })
    if (!status?.exists) {
      this.hwnd = 0
      this.visible = false
    }
    return status ?? { exists: false, visible: false, topmost: false }
  }

  #rectFor(height) {
    const area = this.workArea ?? normalizeWorkArea(undefined)
    return computePopupRect(area, {
      width: this.width,
      height,
      margin: this.margin,
      minHeight: this.minHeight,
      maxHeight: this.maxHeight
    })
  }

  /**
   * Stop the helper and the Edge process tree, then sweep leftovers that carry
   * this window's dedicated user-data-dir (never the user's own browser).
   * @returns {Promise<void>} resolves once teardown was attempted.
   */
  async dispose() {
    try { await this.hide() } catch { /* teardown best effort */ }
    const pid = this.edge?.pid
    this.helper.dispose()
    if (typeof pid === 'number') await killTree(pid)
    this.hwnd = 0
    this.visible = false
    await killEdgeByProfile(this.userDataDir, this.logger)
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function killTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

/**
 * Kill only msedge processes whose command line carries our dedicated profile dir.
 * @param {string} userDataDir - our Edge profile directory.
 * @param {(line: string) => void} [logger] - one-line diagnostic sink.
 * @returns {Promise<void>} resolves after the sweep.
 */
export function killEdgeByProfile(userDataDir, logger = () => {}) {
  const needle = String(userDataDir).replaceAll("'", "''")
  const script = [
    `$needle = '${needle}'`,
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" -ErrorAction SilentlyContinue |",
    '  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } |',
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  ].join('\n')
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) logger(`edge sweep failed: ${String(error.message ?? error)}`)
      else if (String(stderr).trim().length > 0) logger(`edge sweep stderr: ${String(stderr).trim()}`)
      resolve()
    })
  })
}
