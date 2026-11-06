/**
 * Provenance check for the vendored format-1 validator: compare
 * `scripts/lib/market-index-validator.mjs` with an upstream copy extracted from
 * a DSH installation (see `scripts/extract-asar-file.mjs`), ignoring the local
 * NOTICE header and the `semver` import swap.
 *
 * Usage:
 *   node scripts/compare-validator.mjs --upstream <upstream/lib/index.js>
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const LOCAL = resolve(REPO_ROOT, 'scripts/lib/market-index-validator.mjs')

const argv = process.argv.slice(2)
const index = argv.indexOf('--upstream')
if (index < 0 || argv[index + 1] === undefined) {
  console.error('usage: node scripts/compare-validator.mjs --upstream <upstream/lib/index.js>')
  process.exit(2)
}
const upstream = readFileSync(argv[index + 1], 'utf8')
const ours = readFileSync(LOCAL, 'utf8')
const headerEnd = ours.indexOf('*/') + 2
const body = ours.slice(headerEnd).replace(/^\s+/, '')
const reverted = body.replace('import semver from "./semver-lite.mjs";', 'import semver from "semver";')
const identical = reverted.trimEnd() === upstream.trimEnd()
console.log(`compare-validator: upstream ${String(upstream.length)} bytes, local ${String(ours.length)} bytes`)
console.log(`compare-validator: body identical after reverting the semver import: ${String(identical)}`)
process.exit(identical ? 0 : 1)
