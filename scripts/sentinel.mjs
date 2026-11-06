/**
 * Import sentinel for every publishable package in this monorepo.
 *
 * A DSH `file://` plugin is loaded with the package directory as the module
 * resolution root, and the packages here deliberately declare no dependencies.
 * A bare specifier or an `@deepseek-ai/*` import therefore fails with
 * ERR_MODULE_NOT_FOUND **silently** inside the harness. This script fails loudly:
 *
 *   1. every static import in `lib/*.js` must be `node:*` or relative;
 *   2. `lib/index.js` must import as a file URL;
 *   3. the module must export `apply` (and, by convention, `name`).
 *
 * Usage: node scripts/sentinel.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
const STATIC_IMPORT = /^\s*(?:import|export)\s[^'"]*from\s+['"]([^'"]+)['"]/gmu

function packageDirectories() {
  if (!existsSync(PACKAGES_DIR)) return []
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function checkImports(packageDir, failures) {
  const libDir = join(packageDir, 'lib')
  if (!existsSync(libDir)) return
  for (const name of readdirSync(libDir)) {
    if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue
    const source = readFileSync(join(libDir, name), 'utf8')
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const specifier = match[1]
      if (specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')) continue
      failures.push(`${join('packages', packageDir, 'lib', name)}: non-relative import ${JSON.stringify(specifier)}`)
    }
  }
}

const failures = []
const checked = []
for (const directory of packageDirectories()) {
  const packageDir = join(PACKAGES_DIR, directory)
  const entry = join(packageDir, 'lib', 'index.js')
  if (!existsSync(entry)) continue
  checkImports(packageDir, failures)
  const module = await import(pathToFileURL(entry).href)
  if (typeof module.apply !== 'function') failures.push(`packages/${directory}/lib/index.js does not export apply()`)
  checked.push({ directory, exports: Object.keys(module).sort() })
}

if (checked.length === 0) failures.push('no package with lib/index.js found under packages/')
for (const { directory, exports } of checked) {
  console.log(`sentinel: OK packages/${directory}/lib/index.js (exports ${exports.join(', ')})`)
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`sentinel: FAIL ${failure}`)
  process.exit(1)
}
console.log('sentinel: all packages import cleanly')
