/**
 * Generate and check the repository root `index.json` (plugin market index format 1).
 *
 * Sources of truth:
 *   - `<repo>/package.json`                 -> `dsh.marketIndex` (index title + declarations)
 *   - `<repo>/packages/<dir>/package.json`  -> `dsh.market` (per-plugin presentation) + versions
 *   - `git rev-parse HEAD`                  -> the commit a generated version is pinned to
 *
 * Usage:
 *   node scripts/make-index.mjs                  # regenerate index.json for the current HEAD
 *   node scripts/make-index.mjs --dry-run        # print, do not write
 *   node scripts/make-index.mjs --check          # consistency + pinned-commit check (no write)
 *   node scripts/make-index.mjs --commit <sha>   # pin an explicit commit (offline / pre-push)
 *   node scripts/make-index.mjs --timestamp <s>  # deterministic publishTimestamp
 *   node scripts/make-index.mjs --npm            # npm source entries (only after npm publish)
 *   node scripts/make-index.mjs --repo-root <d>  # operate on another checkout (tests, CI fixtures)
 *
 * `--check` semantics: the committed index must match the current package manifests
 * (name/version/presentation/engines/source url+path/…), and each version's pinned
 * commit must really contain that package version. The pinned `source.commit` is
 * intentionally NOT compared against HEAD: committing `index.json` moves HEAD to a
 * new commit while the index keeps pinning the release commit, which is correct and
 * installable. `publishTimestamp` is publication metadata and is validated by rule
 * (integer Unix seconds in range), not by equality.
 *
 * The output is deterministic: plugins sorted by name, versions sorted by SemVer
 * precedence, two-space indent, one trailing newline. When `--timestamp` is omitted
 * a generated version uses its pinned commit's commit time, so the same commit always
 * produces the same index.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from './lib/semver-lite.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = resolve(HERE, '..')
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const MAX_PUBLISH_TIMESTAMP = 1e11
/** Source URL used for git entries; keep in sync with `repository.url` in package.json. */
const REPOSITORY_URL = 'https://github.com/layman-hu/dsh-plugins'

function parseArgs(argv) {
  const options = {
    repoRoot: DEFAULT_REPO_ROOT,
    out: undefined,
    commit: undefined,
    timestamp: undefined,
    npm: false,
    dryRun: false,
    check: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo-root') options.repoRoot = resolve(process.cwd(), argv[++index] ?? '')
    else if (arg === '--out') options.out = resolve(process.cwd(), argv[++index] ?? '')
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
  if (options.out === undefined) options.out = join(options.repoRoot, 'index.json')
  return options
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

function tryGit(repoRoot, args) {
  try {
    return { ok: true, output: git(repoRoot, args) }
  } catch (error) {
    return { ok: false, error }
  }
}

function headCommit(repoRoot) {
  const result = tryGit(repoRoot, ['rev-parse', 'HEAD'])
  return result.ok ? result.output : undefined
}

/** Committer time of a commit, as Unix seconds; undefined when unknown locally. */
function commitTimestamp(repoRoot, commit) {
  const result = tryGit(repoRoot, ['show', '-s', '--format=%ct', commit])
  if (!result.ok) return undefined
  const seconds = Number(result.output)
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined
}

function pluginDirectories(repoRoot) {
  const packagesDir = join(repoRoot, 'packages')
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

function assertTimestamp(value, where) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= MAX_PUBLISH_TIMESTAMP) {
    throw new Error(`${where} must be an integer number of Unix seconds in [0, 10^11)`)
  }
}

/**
 * Build the index a fresh generation would produce.
 * @param {{ repoRoot: string, commit?: string, timestamp?: number, npm: boolean }} options - generation inputs.
 * @returns {Record<string, any>} format-1 index document.
 */
function buildIndex(options) {
  const repoRoot = options.repoRoot
  const rootManifest = readJson(join(repoRoot, 'package.json'))
  const indexMeta = rootManifest.dsh?.marketIndex
  if (indexMeta === undefined) throw new Error('root package.json is missing dsh.marketIndex')
  const categories = indexMeta.categories ?? {}
  const labels = indexMeta.labels ?? {}
  const sortKeys = indexMeta.sortKeys ?? {}

  const commit = options.commit ?? headCommit(repoRoot)
  if (commit === undefined) {
    throw new Error(
      'make-index: no git HEAD (this directory is not a git repository yet). ' +
      'Pass --commit <40-hex-sha> for an offline build, or run the script after the first `git init`/commit.'
    )
  }
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`make-index: commit must be a lowercase 40-hex SHA, received ${JSON.stringify(commit)}`)
  }
  const defaultTimestamp = options.timestamp ?? commitTimestamp(repoRoot, commit) ?? Math.floor(Date.now() / 1000)
  assertTimestamp(defaultTimestamp, 'make-index: publish timestamp')

  const plugins = []
  for (const directory of pluginDirectories(repoRoot)) {
    const manifestPath = join(repoRoot, 'packages', directory, 'package.json')
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
    const source = options.npm
      ? { type: 'npm' }
      : { type: 'git', url: REPOSITORY_URL, commit, path: `packages/${directory}` }
    plugins.push({
      name: manifest.name,
      title: market.title,
      description: market.description,
      icon: `./packages/${directory}/icon.svg`,
      author: manifest.author,
      homepage: manifest.homepage,
      repository: { url: REPOSITORY_URL, directory: `packages/${directory}` },
      metadata: {
        category: market.category,
        keywords: market.keywords ?? manifest.keywords ?? [],
        labels: market.labels ?? []
      },
      versions: [{
        version,
        publishTimestamp: defaultTimestamp,
        source,
        ...dshRange === undefined ? {} : { engines: { dsh: dshRange } }
      }]
    })
  }
  plugins.sort((left, right) => left.name.localeCompare(right.name))
  for (const plugin of plugins) plugin.versions.sort((left, right) => semver.rcompare(left.version, right.version))

  return {
    format: 1,
    title: indexMeta.title,
    ...indexMeta.description === undefined ? {} : { description: indexMeta.description },
    metadata: { categories, labels, sortKeys },
    plugins
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  const sorted = {}
  for (const key of Object.keys(value).sort()) sorted[key] = canonical(value[key])
  return sorted
}

function sameJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

const PLUGIN_FIELDS = ['title', 'description', 'icon', 'author', 'homepage', 'repository', 'metadata']

/**
 * Compare a committed index against the freshly generated one.
 * The pinned `source.commit` is ignored per version; `publishTimestamp` is validated
 * by rule, not by equality; everything else must match exactly.
 * @param {any} existing - parsed committed index.
 * @param {any} expected - freshly generated index.
 * @returns {string[]} human-readable mismatches (empty means consistent).
 */
function compareIndexes(existing, expected) {
  const problems = []
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
    return ['index.json must be a JSON object']
  }
  for (const field of ['format', 'title', 'description', 'metadata']) {
    if (!sameJson(existing[field], expected[field])) problems.push(`root field ${JSON.stringify(field)} differs from the package manifests`)
  }
  const existingPlugins = new Map((Array.isArray(existing.plugins) ? existing.plugins : []).map((plugin) => [plugin?.name, plugin]))
  const expectedPlugins = new Map(expected.plugins.map((plugin) => [plugin.name, plugin]))
  for (const name of expectedPlugins.keys()) {
    if (!existingPlugins.has(name)) problems.push(`plugin ${JSON.stringify(name)} is missing from index.json`)
  }
  for (const name of existingPlugins.keys()) {
    if (!expectedPlugins.has(name)) problems.push(`plugin ${JSON.stringify(name)} is no longer in packages/ but is still in index.json`)
  }
  for (const [name, plugin] of expectedPlugins) {
    const theirs = existingPlugins.get(name)
    if (theirs === undefined) continue
    for (const field of PLUGIN_FIELDS) {
      if (!sameJson(theirs[field], plugin[field])) problems.push(`plugin ${JSON.stringify(name)} field ${field} differs`)
    }
    const theirVersions = new Map((Array.isArray(theirs.versions) ? theirs.versions : []).map((version) => [version?.version, version]))
    const ourVersions = new Map(plugin.versions.map((version) => [version.version, version]))
    for (const version of ourVersions.keys()) {
      if (!theirVersions.has(version)) problems.push(`plugin ${JSON.stringify(name)} version ${version} is missing from index.json`)
    }
    for (const version of theirVersions.keys()) {
      if (!ourVersions.has(version)) problems.push(`plugin ${JSON.stringify(name)} version ${version} is in index.json but not in package.json`)
    }
    for (const [version, theirsVersion] of theirVersions) {
      const ourVersion = ourVersions.get(version)
      if (ourVersion === undefined) continue
      const where = `plugin ${JSON.stringify(name)} version ${version}`
      if (theirsVersion?.source?.type !== ourVersion.source.type) problems.push(`${where}: source.type differs`)
      if (ourVersion.source.type === 'git') {
        if (theirsVersion?.source?.url !== ourVersion.source.url) problems.push(`${where}: source.url differs`)
        if (theirsVersion?.source?.path !== ourVersion.source.path) problems.push(`${where}: source.path differs`)
        if (typeof theirsVersion?.source?.commit !== 'string' || !COMMIT_PATTERN.test(theirsVersion.source.commit)) {
          problems.push(`${where}: source.commit must be a lowercase 40-hex SHA`)
        }
      } else if (JSON.stringify(canonical(theirsVersion?.source)) !== JSON.stringify(canonical(ourVersion.source))) {
        problems.push(`${where}: source differs`)
      }
      if (!sameJson(theirsVersion?.engines, ourVersion.engines)) problems.push(`${where}: engines differs`)
      try {
        assertTimestamp(theirsVersion?.publishTimestamp, `${where}: publishTimestamp`)
      } catch (error) {
        problems.push(String(error?.message ?? error))
      }
    }
  }
  return problems
}

/**
 * Verify that every git-pinned version exists in this repository and that the
 * package.json at that commit really declares the indexed version.
 * @param {string} repoRoot - checkout to query.
 * @param {any} index - parsed index document.
 * @returns {string[]} problems (empty means every pinned commit is installable).
 */
function verifyPinnedCommits(repoRoot, index) {
  const problems = []
  const plugins = Array.isArray(index?.plugins) ? index.plugins : []
  for (const plugin of plugins) {
    const versions = Array.isArray(plugin?.versions) ? plugin.versions : []
    for (const version of versions) {
      if (version?.source?.type !== 'git') continue
      const commit = version.source.commit
      const directory = version.source.path ?? plugin.repository?.directory
      const where = `plugin ${JSON.stringify(plugin.name)} version ${String(version.version)}`
      if (directory === undefined) {
        problems.push(`${where}: git source has no path and the plugin declares no repository.directory`)
        continue
      }
      const manifestPath = `${directory}/package.json`
      const exists = tryGit(repoRoot, ['cat-file', '-e', `${String(commit)}:${manifestPath}`])
      if (!exists.ok) {
        problems.push(
          `${where}: pinned commit ${String(commit)} does not contain ${manifestPath} in this repository ` +
          '(run `node scripts/make-index.mjs` on the commit that really contains the release; ' +
          'if this is a shallow checkout — e.g. CI with the default actions/checkout depth=1 — ' +
          'fetch the full history: `git fetch --unshallow` / actions/checkout `fetch-depth: 0`)'
        )
        continue
      }
      let pinnedManifest
      try {
        pinnedManifest = JSON.parse(git(repoRoot, ['show', `${String(commit)}:${manifestPath}`]))
      } catch (error) {
        problems.push(`${where}: cannot read ${manifestPath} at ${String(commit)}: ${String(error?.message ?? error)}`)
        continue
      }
      if (pinnedManifest.name !== plugin.name) {
        problems.push(`${where}: pinned ${manifestPath} declares package name ${JSON.stringify(pinnedManifest.name)}`)
      }
      if (pinnedManifest.version !== version.version) {
        problems.push(`${where}: pinned ${manifestPath} declares version ${JSON.stringify(pinnedManifest.version)}`)
      }
    }
  }
  return problems
}

const options = parseArgs(process.argv.slice(2))

if (options.check) {
  const problems = []
  if (!existsSync(options.out)) {
    console.error(`make-index: --check cannot find ${options.out}; run \`node scripts/make-index.mjs\` first`)
    process.exit(1)
  }
  let existing
  try {
    existing = readJson(options.out)
  } catch (error) {
    console.error(`make-index: --check cannot parse ${options.out}: ${String(error?.message ?? error)}`)
    process.exit(1)
  }
  let expected
  try {
    expected = buildIndex(options)
  } catch (error) {
    console.error(`make-index: ${String(error?.message ?? error)}`)
    process.exit(1)
  }
  problems.push(...compareIndexes(existing, expected))
  problems.push(...verifyPinnedCommits(options.repoRoot, existing))
  if (problems.length > 0) {
    for (const problem of problems) console.error(`make-index: STALE ${problem}`)
    console.error('make-index: index.json is stale or its pinned commits are not installable; run `node scripts/make-index.mjs` and commit the result')
    process.exit(1)
  }
  const versions = existing.plugins.reduce((total, plugin) => total + plugin.versions.length, 0)
  console.log(`make-index: index.json is consistent (${String(existing.plugins.length)} plugin(s), ${String(versions)} version(s); every pinned commit contains its package version)`)
  process.exit(0)
}

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
writeFileSync(options.out, text, 'utf8')
console.log(`make-index: wrote ${options.out} (${String(index.plugins.length)} plugin(s), commit ${String(options.commit ?? 'HEAD')})`)
