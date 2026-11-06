/**
 * Validate the repository root `index.json` with the vendored format-1 validator.
 *
 * Usage:
 *   node scripts/validate-index.mjs
 *   node scripts/validate-index.mjs --file index.json --url https://example.test/index.json
 *
 * The index URL matters: relative icon references resolve against it, and the
 * validator requires them to stay on https or the index origin. The default is
 * the canonical raw URL the plugin market reads.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MarketIndexError, marketInstallTarget, parseMarketIndex } from './lib/market-index-validator.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const DEFAULT_URL = 'https://raw.githubusercontent.com/layman-hu/dsh-plugins/main/index.json'

function parseArgs(argv) {
  const options = { file: resolve(REPO_ROOT, 'index.json'), url: DEFAULT_URL }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--file') options.file = resolve(process.cwd(), argv[++index])
    else if (arg === '--url') options.url = argv[++index]
    else {
      console.error(`validate-index: unknown argument ${JSON.stringify(arg)}`)
      process.exit(2)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
let document
try {
  document = JSON.parse(readFileSync(options.file, 'utf8'))
} catch (error) {
  console.error(`validate-index: cannot read ${options.file}: ${String(error?.message ?? error)}`)
  process.exit(1)
}

try {
  const index = parseMarketIndex(document, options.url)
  console.log(`validate-index: OK format=${String(index.format)} index=${JSON.stringify(index.title)}`)
  for (const plugin of index.plugins) {
    console.log(`  plugin ${plugin.name}`)
    for (const version of plugin.versions) {
      const target = marketInstallTarget(plugin.name, version)
      console.log(`    ${version.version} -> ${target.spec}${target.registry === undefined ? '' : ` (registry ${target.registry})`}`)
    }
    if (plugin.icon !== undefined) console.log(`    icon ${plugin.icon}`)
  }
  console.log(`validate-index: ${String(index.plugins.length)} plugin(s) valid against ${options.url}`)
} catch (error) {
  if (error instanceof MarketIndexError) {
    console.error(`validate-index: INVALID ${error.path}: ${error.reason}`)
    process.exit(1)
  }
  console.error(`validate-index: unexpected failure: ${String(error?.stack ?? error)}`)
  process.exit(1)
}
