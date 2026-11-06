# Changelog

All notable changes to this repository are documented here. Per-package
versions follow SemVer and are listed in each package's `package.json`; this
file records the repository-level milestones that matter to users.

## 0.1.0 — 2026-11-07

First public snapshot of the monorepo (not yet published to npm).

### Added

- Monorepo skeleton: root workspace manifest, `pnpm-workspace.yaml`, MIT
  `LICENSE`, `NOTICE` (upstream attributions), this changelog, CI workflow.
- `packages/dsh-desktop-question-popup` 0.1.0 — Windows desktop popup that
  mirrors DSH `ask_user_question` in a bottom-right always-on-top Edge window;
  whichever side answers first ends the other. It installs a shadowed timed
  `ask_user_question` on each live agent so the DSH question card is removed
  when the popup answers.
- Format-1 plugin market index (`index.json`) plus `scripts/make-index.mjs`
  (generates it from `git HEAD` and the package manifests) and
  `scripts/validate-index.mjs` (validates it with the vendored upstream
  validator).
- `scripts/sentinel.mjs` — import sentinel that fails when a package host half
  imports a bare or `@deepseek-ai/*` specifier (which the harness would only
  discover as a silent load failure).
- `docs/DESIGN.md` — mechanism, upstream source references, and the runtime
  pitfalls this plugin had to work around.
