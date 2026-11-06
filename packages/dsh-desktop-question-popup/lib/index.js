/**
 * Host half of dsh-desktop-question-popup.
 *
 * Two responsibilities, both deliberately dependency-free (this package has no
 * node_modules; a bare or @deepseek-ai import would silently fail to load):
 *
 * 1. Shadow a timed `ask_user_question` into every live agent's own tools layer.
 *    The shipped tool row lives inside an agent preset, which a profile patch
 *    cannot reach and which an already-mounted agent never rebuilds, so the
 *    plugin provides the timed contract itself (model surface copied verbatim
 *    from dsh-tool-ask-user). Scoped tools shadow the inherited preset row.
 *    A disabled plugin therefore falls back to the shipped legacy tool.
 *
 * 2. Race a desktop window against the native DSH question UI for every timed
 *    `user-questions/request`: whichever answers first wins, the other is torn
 *    down immediately. Any failure here falls back to `next()` (native only).
 *
 * @module dsh-desktop-question-popup
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Sibling modules are imported dynamically with the entry URL's `?rev=` query.
 * The Loader caches ESM modules by full URL, and a bump of the entry's `?rev=N`
 * only busts the cache for THIS file: a static `./session.js` import keeps
 * resolving to the module cached by the first generation. Versioning the sibling
 * specifiers with the same query makes one `?rev` bump reload the whole graph.
 */
const LOCAL_REV = new URL(import.meta.url).searchParams.get('rev') ?? '0'

function localImport(path) {
  return import(new URL(`${path}?rev=${encodeURIComponent(LOCAL_REV)}`, import.meta.url).href)
}

async function loadModules() {
  const [server, window, shadow, gate, session] = await Promise.all([
    localImport('./server.js'),
    localImport('./window.js'),
    localImport('./shadow-tool.js'),
    localImport('./gate.js'),
    localImport('./session.js')
  ])
  return {
    PopupServer: server.PopupServer,
    PopupWindow: window.PopupWindow,
    findEdgePath: window.findEdgePath,
    findShellPath: window.findShellPath,
    createTimedAskUserTool: shadow.createTimedAskUserTool,
    PopupGate: gate.PopupGate,
    PopupSession: session.PopupSession
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'desktop-question-popup'

/** Services this plugin needs to exist before its tools can run. */
export const inject = ['userQuestions']

const UI_PAGE = fileURLToPath(new URL('../ui/popup.html', import.meta.url))
const WIN_HELPER = fileURLToPath(new URL('./win-helper.ps1', import.meta.url))
const SCRATCH_DIR = join(tmpdir(), 'dsh-question-popup')
const DEFAULT_USER_DATA_DIR = join(SCRATCH_DIR, 'edge-profile')
const DEFAULT_LOG_FILE = join(SCRATCH_DIR, 'popup.log')
const DEFAULT_TIMEOUT_SECONDS = 120
const READY_BUDGET_MS = 15000
const ATTACH_BUDGET_MS = 12000

/**
 * Normalize the plugin config. Unknown or malformed fields fall back to defaults.
 * @param {unknown} config - raw Loader config.
 * @returns {Record<string, any>} normalized config.
 */
export function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const positive = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback)
  const nonNegative = (value, fallback) => (Number.isInteger(value) && value >= 0 ? value : fallback)
  return {
    enabled: raw.enabled !== false,
    shadowTimedTool: raw.shadowTimedTool !== false,
    timeout: positive(raw.timeout, DEFAULT_TIMEOUT_SECONDS),
    width: positive(raw.width, 460),
    minHeight: positive(raw.minHeight, 240),
    maxHeight: positive(raw.maxHeight, 620),
    margin: nonNegative(raw.margin, 12),
    edgePath: typeof raw.edgePath === 'string' && raw.edgePath.length > 0 ? raw.edgePath : undefined,
    shellPath: typeof raw.shellPath === 'string' && raw.shellPath.length > 0 ? raw.shellPath : undefined,
    userDataDir: typeof raw.userDataDir === 'string' && raw.userDataDir.length > 0 ? raw.userDataDir : DEFAULT_USER_DATA_DIR,
    logFile: typeof raw.logFile === 'string' && raw.logFile.length > 0 ? raw.logFile : DEFAULT_LOG_FILE,
    debugPort: positive(raw.debugPort, 0)
  }
}

/**
 * Cordis plugin body.
 * @param {any} ctx - host context.
 * @param {unknown} [config] - Loader config (see README for fields).
 */
export async function apply(ctx, config) {
  const {
    PopupServer,
    PopupWindow,
    findEdgePath,
    findShellPath,
    createTimedAskUserTool,
    PopupGate,
    PopupSession
  } = await loadModules()
  const cfg = normalizeConfig(config)
  const gate = new PopupGate()
  const loggedOnce = new Set()

  const log = (line) => {
    try {
      mkdirSync(SCRATCH_DIR, { recursive: true })
      appendFileSync(cfg.logFile, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // Diagnostics must never break the question path.
    }
  }
  const logOnce = (key, line) => {
    if (loggedOnce.has(key)) return
    loggedOnce.add(key)
    log(line)
  }

  log(`plugin applied (enabled=${String(cfg.enabled)}, shadowTimedTool=${String(cfg.shadowTimedTool)}, timeout=${String(cfg.timeout)})`)

  let gui
  let guiPromise
  let guiFailure
  let seq = 0
  let session

  const teardownGui = async () => {
    const active = gui
    gui = undefined
    if (active === undefined) return
    try { await active.server.stop() } catch (error) { log(`server stop failed: ${String(error?.message ?? error)}`) }
    try { await active.win.dispose() } catch (error) { log(`window dispose failed: ${String(error?.message ?? error)}`) }
  }

  /** Lazy first-question startup. Resolves undefined when the desktop popup is unavailable. */
  const ensureGui = () => {
    if (gui !== undefined) return Promise.resolve(gui)
    if (guiFailure !== undefined) return Promise.resolve(undefined)
    if (guiPromise !== undefined) return guiPromise
    guiPromise = (async () => {
      try {
        if (process.platform !== 'win32') throw new Error(`unsupported platform ${process.platform}`)
        const edgePath = findEdgePath(cfg.edgePath)
        if (edgePath === undefined) throw new Error('Microsoft Edge was not found')
        const shellPath = findShellPath(cfg.shellPath)
        mkdirSync(SCRATCH_DIR, { recursive: true })
        mkdirSync(cfg.userDataDir, { recursive: true })
        log(`starting popup window (edge=${String(edgePath)}, shell=${shellPath}, profile=${cfg.userDataDir})`)
        const server = new PopupServer({
          pagePath: UI_PAGE,
          onAnswer: (answers) => session?.resolveAnswer(answers),
          onDismiss: () => session?.resolveDismiss(),
          onHeight: (height) => session?.applyHeight(height),
          logger: log
        })
        await server.start()
        const win = new PopupWindow({
          edgePath,
          shellPath,
          helperPath: WIN_HELPER,
          userDataDir: cfg.userDataDir,
          width: cfg.width,
          minHeight: cfg.minHeight,
          maxHeight: cfg.maxHeight,
          margin: cfg.margin,
          debugPort: cfg.debugPort > 0 ? cfg.debugPort : undefined,
          logger: log
        })
        await win.launch(server.pageUrl)
        const ready = await server.waitForReady(READY_BUDGET_MS)
        if (!ready) throw new Error('popup page did not become ready')
        await win.attach(ATTACH_BUDGET_MS)
        gui = { server, win }
        log('popup window is ready')
        return gui
      } catch (error) {
        guiFailure = String(error?.message ?? error)
        log(`desktop popup unavailable, native questions only: ${guiFailure}`)
        await teardownGui()
        return undefined
      } finally {
        guiPromise = undefined
      }
    })()
    return guiPromise
  }

  /**
   * Open a popup for one timed request, or return undefined to stay native.
   * @param {{ server: PopupServer, win: PopupWindow }} active - started GUI.
   * @param {any} request - user-questions request.
   * @returns {Promise<PopupSession | undefined>} the session, when a popup is possible.
   */
  async function openPopup(active, request) {
    if (!active.server.hasPage) {
      logOnce('no-page', 'popup page is not connected; using the native question dialog')
      return undefined
    }
    const opened = new PopupSession({
      ctx,
      active,
      request,
      nextSeq: () => ++seq,
      log,
      onWindowClosed: teardownGui
    })
    session = opened
    try {
      await opened.show()
    } catch (error) {
      logOnce('show-failed', `popup could not be shown: ${String(error?.message ?? error)}`)
      session = undefined
      await opened.close()
      return undefined
    }
    return opened
  }

  /**
   * Waterfall listener (outermost): race the desktop popup against the native UI.
   * @param {any} request - user-questions request.
   * @param {() => Promise<any>} next - the rest of the answerer chain.
   * @returns {Promise<any>} the winning answer batch.
   */
  async function onRequest(request, next) {
    const timed = request?.wait?.timed === true && request.wait.callId !== undefined
    if (!cfg.enabled || !timed || !Array.isArray(request.questions)) return next()
    const forwarded = Promise.resolve().then(() => next())
    // If the popup wins, the native chain may still settle later (the Client
    // releases its claim and the chain ends). Keep that rejection handled, and
    // log how it ended: NO_PROVIDER here is evidence the Client claim closed.
    const startedAt = Date.now()
    forwarded.then(
      (value) => log(`native chain settled after ${String(Date.now() - startedAt)}ms (popup race lost): ${JSON.stringify(value).slice(0, 120)}`),
      (error) => log(`native chain ended after ${String(Date.now() - startedAt)}ms: code=${String(error?.code ?? 'none')} message=${String(error?.message ?? error)}`)
    )
    const release = gate.tryAcquire()
    if (release === undefined) {
      logOnce('busy', 'another desktop popup is already open; using the native question dialog')
      return forwarded
    }
    let opened
    try {
      const active = await ensureGui()
      if (active === undefined) return forwarded
      // The cold-start (helper + Edge + page) can outlast a very short timeout; do
      // not flash a popup for a wait that already ended.
      if (request.signal?.aborted) return forwarded
      opened = await openPopup(active, request)
      if (opened === undefined) return forwarded
      return await opened.run(forwarded)
    } catch (error) {
      logOnce('race-error', `popup race failed, using the native answer: ${String(error?.message ?? error)}`)
      return forwarded
    } finally {
      if (session === opened) session = undefined
      try { await opened?.close() } catch { /* best effort */ }
      release()
    }
  }

  // ---------- shadow timed tool ------------------------------------------------

  const shadowDisposers = new Map()

  const installShadowTool = (agent) => {
    const id = String(agent?.id ?? '')
    if (id === '' || shadowDisposers.has(id)) return
    try {
      const disposer = agent.ctx.tools.register(createTimedAskUserTool({ ctx, timeout: cfg.timeout, log: (line) => log(`[${id}] ${line}`) }))
      shadowDisposers.set(id, typeof disposer === 'function' ? disposer : () => {})
      log(`shadow timed ask_user_question installed (agent=${id}, timeout=${String(cfg.timeout)})`)
    } catch (error) {
      shadowDisposers.set(id, () => {})
      logOnce(`shadow-${id}`, `shadow tool registration skipped for agent ${id}: ${String(error?.message ?? error)}`)
    }
  }

  const disposeShadowTools = () => {
    for (const disposer of shadowDisposers.values()) {
      try { disposer() } catch { /* already gone */ }
    }
    shadowDisposers.clear()
  }

  if (cfg.shadowTimedTool) {
    const sweep = () => {
      const agents = ctx.get('agents')
      if (agents === undefined) return
      let live = []
      try {
        live = agents.list()
      } catch (error) {
        logOnce('agents-list', `cannot enumerate live agents: ${String(error?.message ?? error)}`)
        return
      }
      for (const agent of live) installShadowTool(agent)
    }
    const sweepTimer = setTimeout(sweep, 300)
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
    const offCreated = ctx.on('agent/created', ({ agent }) => installShadowTool(agent), { global: true })
    ctx.effect(() => () => {
      clearTimeout(sweepTimer)
      try { offCreated?.() } catch { /* already gone */ }
      disposeShadowTools()
    }, 'desktop-question-popup: shadow timed tool')
  }

  // ---------- popup listener + teardown ---------------------------------------

  ctx.on('user-questions/request', onRequest, { prepend: true, global: true })

  ctx.effect(() => () => {
    session?.close().catch(() => {})
    session = undefined
    teardownGui().catch(() => {})
    log('plugin disposed')
  }, 'desktop-question-popup: window and server')
}
