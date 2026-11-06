# AGENTS.md — dsh-plugins monorepo

Conventions for this repository. Read before adding a package or touching
`index.json`. Paths below are relative to the repository root.

## 1. What this repository is

A monorepo of **DeepSeek Harness (DSH) plugin bundles** plus the **format-1
plugin market index** that lets users discover them from inside DSH.

- Packages live in `packages/<name>/`; one directory = one npm package.
- The market index is the root `index.json`; it is **generated**, never edited by hand.
- Nothing here is installed into a DSH profile by this repository itself: users
  install either through the market index or by pointing `plugin_manager` at a
  git/npm spec.

## 2. Layout

```
.                     repository metadata (LICENSE, NOTICE, CHANGELOG, CI, docs)
scripts/              index generation/validation, import sentinel, vendored helpers
scripts/lib/          vendored upstream code (MIT) — see NOTICE
docs/                 design notes

packages/<name>/      one publishable DSH bundle
  package.json        npm + dsh metadata (see §4)
  cordis.patch.yml    the bundle patch layer (host rows)
  lib/                host half; Node built-ins only
  ui/ locale/ icon.svg
  tests/*.test.mjs    offline tests (`node --test`)
  tools/              optional local verification scripts (not published)
```

Maintenance helpers in `scripts/` beyond the npm scripts above:
`extract-asar-file.mjs` (pull one file out of a DSH `app.asar`) and
`compare-validator.mjs` (prove the vendored validator is byte-identical to the
upstream file after reverting the local `semver` import).

## 3. Non-negotiable rules for a package

1. **The host half declares no runtime dependencies.** `lib/` may import only
   `node:*` built-ins and its own relative modules. A DSH `file://` plugin is
   loaded with the package directory as the module resolution root; a bare or
   `@deepseek-ai/*` import fails with `ERR_MODULE_NOT_FOUND` and the plugin
   silently does not load. `npm run sentinel` enforces this.
2. **Node-only tests, no network, no Windows GUI required.** `tests/` runs with
   plain `node --test` (Node 24 discovers `**/*.test.mjs`; do not pass a
   directory argument).
3. **`npm pack` is the contract.** The package `files` whitelist must be exactly
   what a user needs at runtime: `lib/`, `ui/`, `locale/`, `icon.svg`,
   `cordis.patch.yml`, `README.md`, `LICENSE`, `NOTICE` — a tarball therefore has
   18 entries including `package.json`. Tests, tools, docs, this file, and any
   local verification report are never published.
4. **README is bilingual and complete in both languages**: full English first,
   then `---`, then full Chinese. Not a summary in the second language.
5. **No machine-specific data.** No absolute paths, no user names, no session
   ids, no profile paths, no secrets. See §6.
6. **Versioning**: SemVer; `engines.dsh` must be a SemVer range and is mirrored
   into the index; `engines.node` is `^22.19.0 || >=24.0.0`.

## 4. Package manifest requirements

`package.json` must carry, besides npm fields (`name`, `version`, `license`,
`author`, `homepage`, `repository`):

```json
"dsh": {
  "manifestVersion": 1,
  "bundle": { "patch": ["./cordis.patch.yml"], "platforms": ["win32"] },
  "market": {
    "category": "desktop",
    "labels": ["popup", "questions", "windows"],
    "title": { "en": "...", "zh": "..." },
    "description": { "en": "...", "zh": "..." }
  }
}
```

`dsh.market.category` and every `dsh.market.labels` id must be declared under
`dsh.marketIndex` in the **root** `package.json`, otherwise `make-index.mjs`
fails instead of emitting an index the official validator would reject.

`dsh.bundle.patch` is what `plugin_manager install_bundle` mounts. Keep it
minimal and self-contained: rows the bundle owns, not edits to other bundles.

## 5. Index generation and pinning

- `index.json` is produced by `node scripts/make-index.mjs`. Never hand-edit it.
- Every version is pinned to a **40-hex commit** (git source) so an install is
  reproducible. The script reads `git rev-parse HEAD`; `--commit <sha>` exists
  only for offline builds before the first push.
- `node scripts/make-index.mjs --check` reports staleness (CI runs it once the
  repository is actually pushed and `index.json` is pinned to a real commit).
- After the first `git init` + commit: run `npm run index`, commit the result;
  from then on every commit that changes a package manifest needs a fresh
  `npm run index`.
- After an npm publish (optional path): run `node scripts/make-index.mjs --npm`
  so the index offers the registry source instead of git.
- Validate before committing: `npm run validate`. The validator is the vendored
  upstream format-1 reader; see `scripts/lib/market-index-validator.mjs`.

## 6. Sanitization checklist (run before every push)

```powershell
# 1. no absolute user/workspace paths, no session ids, no local scope names
#    (the regex is assembled from fragments so this rule itself does not
#    introduce the forbidden literals)
$forbidden = ('C:' + '\\Users') + '|' + ('D:' + '\\codes') + '|' + ('session' + '-[0-9a-f]{8}') + '|' + ('@local' + '/')
Get-ChildItem -Recurse -File | Select-String -Pattern $forbidden

# 2. no private verification reports or scratch directories
Get-ChildItem -Recurse -File | Where-Object { $_.Name -like 'VERIF*' }
Get-ChildItem -Recurse -Directory -Force | Where-Object { $_.Name -like '.*scratch*' }
```

The `.gitignore` intentionally lists a scratch directory pattern; that rule is
expected. Everything else under the repository must stay free of local paths.

## 7. Local commands

```powershell
npm run sentinel        # import sentinel for every package host half
npm test                # all package tests (node --test at the root)
npm run validate        # validate index.json with the vendored validator
npm run index           # regenerate index.json from git HEAD
npm run check           # sentinel + test + validate
```

## 8. Release flow

1. Bump the package `version` and add a `CHANGELOG.md` entry.
2. `npm run check`.
3. Commit; run `npm run index`; commit `index.json` (pinned to the new HEAD).
4. Push. Users can now add the raw index URL in DSH Discover/Settings, or
   install with the `git+https://…#<commit>&path:/packages/<name>` spec.
5. Optional npm path: `npm publish --access public` from the package directory,
   then `node scripts/make-index.mjs --npm` and commit the refreshed index.

Never commit credentials, tokens, or `.env` files. Never publish from this
repository without a version bump.
