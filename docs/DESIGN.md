# Design — desktop question popup for DeepSeek Harness

How `packages/dsh-desktop-question-popup` works, why it is built this way, and
which DSH internals it depends on. References of the form
`@deepseek-ai/<pkg>/lib/index.js:<lines>` point inside the DSH installation
(`<dsh-install>/node_modules/...`), not into this repository.

## 1. Requirement

While DSH's `ask_user_question` is waiting, the same question must also appear in
a Windows bottom-right, always-on-top window. **Whichever side answers first ends
the other**: a popup answer returns to the model and removes the DSH card; a DSH
answer hides the popup. A popup close must not produce an answer.

## 2. Why the shipped tool cannot be used as-is

`ask_user_question` is not a host row. It is declared inside an **agent preset**
(`preset-ptc` / `preset-standard` / `preset-cordis`), i.e. under
`dsh.bundle.patch` files of `@deepseek-ai/dsh-web-app/presets/*.patch.yml`. Two
consequences were measured on DSH 0.2.2-rc.1:

1. A profile patch entry for `tool-ask-user` matches nothing: profile patches are
   applied to the **top-level** entry list only (`dsh-app-boot`'s
   `applyEntryPatches`), while preset rows are data mounted later by
   `dsh-agent-preset-registry`.
2. Overriding the whole preset row would only affect **newly mounted** agents:
   `AgentPresetRegistry.bind()` runs from `mount()` / `composeFrom()`, so an
   already-running session keeps its old generation. That would require a DSH
   restart and freeze a full preset copy in this repository.

The shipped tool is also **legacy blocking** by default (`Config.mode` defaults to
`"legacy"` in `@deepseek-ai/dsh-tool-ask-user/lib/index.js:211-214`). In legacy
mode the client card has no claim stream:

- `dsh-client-ui-user-questions/lib/client.js:2100-2156` (`answerQuestion`) creates
  the card, and only `request.wait?.timed === true` with a `callId` attaches the
  `attachWait` claim (`:2110-2118`);
- the card can leave the pending registry only through the waterfall result or
  through `claimEnded` (`:2133-2138`) plus the projection reconcile in
  `publishContinuedQuestions` (`:2161-2221`).

So a popup answer cannot close a legacy card. Timed mode is mandatory.

## 3. Chosen mechanism: shadowed timed tool (Path B)

The bundle is a host-plane plugin that, for every live agent, registers a timed
`ask_user_question` **into that agent's own tools layer**:

```js
agent.ctx.tools.register(createTimedAskUserTool({ ctx, timeout, log }))
```

`dsh-tools` resolves tools per scope by walking the layer chain and letting the
own layer win (`@deepseek-ai/dsh-tools/lib/index.js:2959-2985`), which is the
documented "scoped tools shadow globals" behavior; registration is per calling
context (`:2872-2886`). Registration happens for `ctx.agents.list()` and for every
`agent/created` event (`{ global: true }`), so it covers running and future agents
without a restart. Disposing the plugin removes the registration, and the shipped
legacy tool returns.

The registered definition reproduces DSH's timed tool surface verbatim —
description, `parameters` (including the `timeout` text and `-1` wording), output
`oneOf` schema, and the pending notice — so the model sees exactly the contract it
would see in DSH's own timed mode. The schema is written as **plain JSON Schema**
(`required: [...]` arrays); the authoring form used by `defineTool` (per-property
`required: true`) is not accepted by `assertSupportedJsonSchema` at registration
time.

Execution:

- `timeout >= 1` → `ctx.userQuestions.askTimed(request, exec.callId, timeout * 1000)`.
  The host creates a `TimedQuestionWait` (`dsh-user-questions/lib/index.js:296-380`)
  whose signal aborts at the deadline; the client claims it through `attachWait`
  (`:604-608`) and shows the card. On settle, `askTimed`'s `finally` closes the wait
  (`:654-658`), the claim stream ends, the client throws `claimEnded`, and the
  projection reconcile removes the card.
- `timeout === -1` → the shipped blocking path
  (`ask({ wait: { callId } })`), because without `wait.timed` there is no claim
  stream and a popup answer cannot remove the card.
- Pending mapping: `ASK_TIMED_OUT` from the wait is converted by `askTimed`
  (`:647-653`) into `{ pending: true, callId }`; the tool adds DSH's pending
  notice.

## 4. Request race

The plugin listens on the `user-questions/request` waterfall **prepended** so it is
the outermost listener (`@deepseek-ai/cordis/lib/index.js:317-325` dispatch order,
`:335-345` `prepend` with `unshift`), with `global: true` to bypass agent-scope
filtering. `dsh-user-questions` invokes that waterfall from `ask()`
(`@deepseek-ai/dsh-user-questions/lib/index.js:676-719`); `dsh-api-remotes`
forwards it to the web client via its own listener that does not call `next()`
until the client answers (`@deepseek-ai/dsh-api-remotes/lib/index.js:173-183`).

Listener logic:

```
timed = request.wait?.timed === true && callId !== undefined
if (!timed) return next()                      // native behavior only
forwarded = next()                             // starts the DSH card path
popup     = open a window and wait for answer | dismiss | window closed
winner    = race(popup.answer, popup.dismiss, forwarded, request.signal.abort)
  popup answer   -> hide window, return { answers }        // card closes via timed wait
  native answer  -> hide window, return native value
  native failure -> hide window, rethrow (askTimed maps it)
  dismiss        -> hide window, keep awaiting forwarded   // no answer produced
  aborted        -> hide window, await forwarded (rejects; askTimed maps to pending)
```

Only one popup exists at a time: a second concurrent question is sent to the
native dialog instead of stacking windows.

## 5. Popup window and page

```
edge --app=http://127.0.0.1:<random-port>/popup?token=<random>
     --user-data-dir=%TEMP%\dsh-question-popup\edge-profile
     --no-first-run --no-default-browser-check
     --disable-features=msEdgeSidebarV2,msEdgeCollections,msEdgeIdentityFeature
     --disable-background-networking
     --window-size=<width>,<initial-height> --window-position=-4000,-4000
```

The window starts offscreen and is hidden as soon as its HWND exists; the first
show places it at the work-area bottom-right corner.

Page ↔ host protocol (`lib/server.js`):

| Route | Purpose |
|---|---|
| `GET /popup?token=` | page HTML with the token injected |
| `GET /events?token=` | SSE: `question`, `shown`, `hidden`, `dismiss`, `ping` |
| `POST /answer?token=` | validated answer batch |
| `POST /dismiss?token=` | user closed the popup (no answer) |
| `POST /ready?token=` | page rendered and SSE connected |
| `POST /height?token=` | content height for window sizing |
| `GET /popup.css`, `/popup.js`, `/icon.svg` | page assets (no token: relative URLs) |

Answer validation is a pure function: exactly one item per question, `selected`
must be a subset of that question's labels, at most one label when
`multiSelect !== true`, duplicates rejected, empty `selected` with no `custom` is a
legal explicit skip, custom answers are length-capped and trimmed.

Window control is a persistent PowerShell helper (`lib/win-helper.ps1`, one JSON
per line over stdin/stdout): `ping`, `workarea`, `find`, `show`, `topmost`, `hide`,
`place`, `status`, `list`, `quit`.

## 6. Runtime pitfalls this design had to absorb (measured)

1. **Static assets need their own routes.** The page requests `popup.css` /
   `popup.js` as relative URLs, which carry no token. Without those routes the
   page never loads its script and never posts `/ready`; the host then times out
   waiting and degrades to the native dialog.
2. **Topmost must be asserted after the window is shown, in a separate call.**
   Bundling `HWND_TOPMOST` with the move/show `SetWindowPos` returns success but
   the `WS_EX_TOPMOST` bit is silently reverted by Chromium. Sequence that works:
   move + `SWP_SHOWWINDOW` (no topmost) → wait ~400 ms → separate
   `SetWindowPos(HWND_TOPMOST, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)`.
3. **Edge's `--disable-sync` blocks external topmost changes** (reproduced 3/3 on
   Edge 156): with that switch, `SetWindowPos(HWND_TOPMOST)` returns true and the
   bit never sticks. The launch arguments therefore do not use it.
4. **Do not find the window by PID.** Edge's launcher process exits after handing
   the browser off; match `class == "Chrome_WidgetWin_1"` plus the title prefix
   instead.
5. **The idle page reports a height before the question.** That report must not be
   used to size the question window; the session drops it before publishing and
   waits for the post-render report.
6. **HMR of a `file://` plugin.** The Loader restarts an entry only when its
   `config`/`group` changes (`cordis-plugin-loader`'s `Entry.update` →
   `_patchContext`); bumping only the module URL's `?rev=` does not re-import.
   During development, change the entry `id` and the `?rev=` together, and import
   sibling modules through dynamic `import()` URLs carrying the same `?rev=` —
   ESM caches by full URL, so a static sibling import would keep the first
   generation's code.
7. **Degradation is a feature.** Any failure in the popup paths (non-Windows, no
   Edge, helper failure, page not ready, no connected page) is logged once and the
   request falls back to `next()`: the tool never blocks and never throws because
   of the popup.

## 7. Verification summary

Observed on Windows 11 with DSH 0.2.2-rc.1 and Edge 156 (measurements, not
assertions of a passing acceptance suite):

- window appears at the work-area bottom-right with a 12 DIP margin, width 460,
  `WS_EX_TOPMOST = true`;
- the popup DOM contains every question text, option label, and header;
- a popup answer returns the exact `{ id, selected }` batch and the window is
  hidden within milliseconds of submission;
- a close produces no answer and the request keeps waiting until its own timeout,
  which then returns `pending`;
- disposing the bundle leaves no popup `msedge` process, no helper process, and no
  listening loopback port;
- with the popup unavailable, the question is answered through the native DSH
  dialog as before.

Not observable without the DSH GUI: that the DSH card disappears after a popup
answer, and the reverse-direction timings; those are covered by the client claim
chain described in §3 rather than by an automated assertion.

## 8. Drift risk

The shadowed tool depends on `dsh-tools` scoped layers, `dsh-user-questions`
timed waits, and the client card lifecycle. `engines.dsh` pins the supported
range; a DSH release outside it may require updating the model-facing schema copy
and the agent registration strategy.
