/**
 * Generate the repository root `index.json` (plugin market index format 1).
 *
 * Sources of truth:
 *   - `<repo>/package.json`                 -> `dsh.marketIndex` (index title + declarations)
 *   - `<repo>/packages/<dir>/package.json`  -> `dsh.market` (per-plugin presentation) + versions
 *   - `git rev-parse HEAD`                  -> the commit every version is pinned to
 *
 * Usage:
 *   node scripts/make-index.mjs                 # regenerate index.json for the current HEAD
 *   node scripts/make-index.mjs --dry-run       # print, do not write
 *   node scripts/make-index.mjs --check         # exit 1 when index.json is stale
 *   node scripts/make-index.mjs --commit <sha>  # pin an explicit commit (offline / pre-push)
 *   node scripts/make-index.mjs --timestamp <s> # deterministic publishTimestamp
 *   node scripts/make-index.mjs --npm           # npm source entries (only after npm publish)
 *
 * The output is deterministic: plugins sorted by name, versions sorted by SemVer
 * precedence, two-space indent, one trailing newline.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from './lib/semver-lite.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u

function parseArgs(argv) {
  const options = {
    out: join(REPO_ROOT, 'index.json'),
    commit: undefined,
    timestamp: undefined,
    npm: false,
    dryRun: false,
    check: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') options.out = resolve(process.cwd(), argv[++index])
    else if (arg === '--commit') options.commit = argv[++index]
    else if (arg === '--timestamp') options.timestamp = Number(argv[++index])
    else if (arg === '--npm') options.npm = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--check') options.check = true
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
      process.exit(0)
    } else {
      console.error(`make-index: unknown argument ${JSON.stringify(arg)}`)
      process.exit(2)
    }
  }
  return options
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function headCommit() {
  try {
    const output = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return output
  } catch {
    return undefined
  }
}

function pluginDirectories() {
  const packagesDir = join(REPO_ROOT, 'packages')
  if (!existsSync(packagesDir)) return []
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function assertDeclared(id, declared, where) {
  if (!Object.hasOwn(declared, id)) {
    throw new Error(`${where} references undeclared id ${JSON.stringify(id)}; declare it in root package.json dsh.marketIndex`)
  }
}

function buildIndex(options) {
  const rootManifest = readJson(join(REPO_ROOT, 'package.json'))
  const indexMeta = rootManifest.dsh?.marketIndex
  if (indexMeta === undefined) throw new Error('root package.json is missing dsh.marketIndex')
  const categories = indexMeta.categories ?? {}
  const labels = indexMeta.labels ?? {}
  const sortKeys = indexMeta.sortKeys ?? {}

  const commit = options.commit ?? headCommit()
  if (commit === undefined) {
    throw new Error(
      'make-index: no git HEAD (this directory is not a git repository yet). ' +
      'Pass --commit <40-hex-sha> for an offline build, or run the script after the first `git init`/commit.'
    )
  }
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`make-index: commit must be a lowercase 40-hex SHA, received ${JSON.stringify(commit)}`)
  }
  const publishTimestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
  if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= 1e11) {
    throw new Error('make-index: --timestamp must be integer Unix seconds in [0, 10^11)')
  }

  const plugins = []
  for (const directory of pluginDirectories()) {
    const manifestPath = join(REPO_ROOT, 'packages', directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    const bundle = manifest.dsh?.bundle
    if (bundle === undefined || manifest.private === true) continue
    const market = manifest.dsh?.market
    if (market === undefined) {
      throw new Error(`packages/${directory}/package.json needs dsh.market (title/description/category) to appear in the index`)
    }
    assertDeclared(market.category, categories, `packages/${directory} dsh.market.category`)
    for (const label of market.labels ?? []) assertDeclared(label, labels, `packages/${directory} dsh.market.labels`)
    const version = manifest.version
    if (typeof version !== 'string' || semver.parseVersion(version) === null) {
      throw new Error(`packages/${directory}/package.json version must be an exact SemVer version`)
    }
    const dshRange = manifest.engines?.dsh
    if (dshRange !== undefined && semver.validRange(dshRange) === null) {
      throw new Error(`packages/${directory}/package.json engines.dsh must be a SemVer range`)
    }
    const repositoryUrl = 'https://github.com/layman-hu/dsh-plugins'
    const source = options.npm
      ? { type: 'npm' }
      : { type: 'git', url: repositoryUrl, commit, path: `packages/${directory}` }
    plugins.push({
      name: manifest.name,
      title: market.title,
      description: market.description,
      icon: `./packages/${directory}/icon.svg`,
      author: manifest.author,
      homepage: manifest.homepage,
      repository: { url: repositoryUrl, directory: `packages/${directory}` },
      metadata: {
        category: market.category,
        keywords: market.keywords ?? manifest.keywords ?? [],
        labels: market.labels ?? []
      },
      versions: [{
        version,
        publishTimestamp,
        source,
        ...dshRange === undefined ? {} : { engines: { dsh: dshRange } }
      }]
    })
  }
  plugins.sort((left, right) => left.name.localeCompare(right.name))
  for (const plugin of plugins) plugin.versions.sort((left, right) => semver.rcompare(left.version, right.version))

  const index = {
    format: 1,
    title: indexMeta.title,
    ...indexMeta.description === undefined ? {} : { description: indexMeta.description },
    metadata: {
      categories,
      labels,
      sortKeys
    },
    plugins
  }
  return index
}

const options = parseArgs(process.argv.slice(2))
let index
try {
  index = buildIndex(options)
} catch (error) {
  console.error(`make-index: ${String(error?.message ?? error)}`)
  process.exit(1)
}
const text = `${JSON.stringify(index, null, 2)}\n`

if (options.dryRun) {
  process.stdout.write(text)
  process.exit(0)
}
if (options.check) {
  const current = existsSync(options.out) ? readFileSync(options.out, 'utf8') : ''
  if (current !== text) {
    console.error('make-index: index.json is stale; run `node scripts/make-index.mjs` and commit the result')
    process.exit(1)
  }
  console.log('make-index: index.json is up to date')
  process.exit(0)
}
writeFileSync(options.out, text, 'utf8')
console.log(`make-index: wrote ${options.out} (${String(index.plugins.length)} plugin(s), commit ${String(options.commit ?? 'HEAD')})`)
