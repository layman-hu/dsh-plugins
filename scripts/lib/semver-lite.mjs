/**
 * Minimal SemVer helpers used by `./market-index-validator.mjs`.
 *
 * The upstream validator (vendored from `@deepseek-ai/dsh-plugin-market-index`,
 * MIT) imports the `semver` package for exactly two operations: validating an
 * `engines.dsh` range and sorting versions by precedence. Vendoring the whole
 * `semver` package would drag a runtime dependency into this repository for
 * those two calls, so this file implements just:
 *
 *   - `validRange(range)`  -> the normalized comparator range, or null
 *   - `rcompare(a, b)`     -> SemVer-precedence comparison, descending
 *
 * Supported range grammar: whitespace-separated comparators (`, ` is accepted
 * as a separator too) joined by `||`, with the `= < <= > >= ^ ~` operators and
 * the `*` / `x` wildcard. Hyphen ranges (`1.2.3 - 2.0.0`) are not supported;
 * none of the ranges this repository generates need them.
 *
 * This is not a general-purpose semver implementation. Extend it deliberately
 * if a plugin starts declaring a range it does not cover.
 */

const NUMERIC = '(?:0|[1-9]\\d*)'
const VERSION = new RegExp(
  `^v?(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
  'u'
)
const OPERATOR = /^(<=|>=|<|>|=|\^|~)?\s*(.+)$/u

/**
 * Parse one exact SemVer version.
 * @param {string} text - candidate version.
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[] } | null}
 *   parsed parts, or null when the text is not an exact version.
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = VERSION.exec(text.trim())
  if (match === null) return null
  const [, major, minor, patch, prerelease] = match
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.')
  }
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/u.test(left)
  const rightNumeric = /^\d+$/u.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Compare two exact versions by SemVer precedence (build metadata ignored).
 * @param {string} left - left version.
 * @param {string} right - right version.
 * @returns {number} negative, zero, or positive.
 */
export function compare(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1
    if (b.prerelease[index] === undefined) return 1
    const order = compareIdentifier(a.prerelease[index], b.prerelease[index])
    if (order !== 0) return order
  }
  return 0
}

/**
 * Descending precedence comparison (the upstream validator sorts with this).
 * @param {string} left - left version.
 * @param {string} right - right version.
 * @returns {number} negative, zero, or positive.
 */
export function rcompare(left, right) {
  return compare(right, left)
}

function normalizeComparator(token) {
  const match = OPERATOR.exec(token)
  if (match === null) return null
  const operator = match[1] ?? ''
  const version = match[2]
  if (version === '*' || version === 'x' || version === 'X') return operator === '' || operator === '=' ? '*' : null
  const parsed = parseVersion(version)
  if (parsed === null) return null
  const base = `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}`
  const suffix = parsed.prerelease.length === 0 ? '' : `-${parsed.prerelease.join('.')}`
  return `${operator}${base}${suffix}`
}

/**
 * Validate and normalize a SemVer range.
 * @param {string} range - candidate range.
 * @returns {string | null} normalized range, or null when invalid.
 */
export function validRange(range) {
  if (typeof range !== 'string') return null
  const text = range.trim()
  if (text === '') return null
  const sets = []
  for (const rawSet of text.split('||')) {
    const set = rawSet.trim().replaceAll(',', ' ')
    const tokens = set.split(/\s+/u).filter((token) => token.length > 0)
    if (tokens.length === 0) return null
    const normalized = []
    for (const token of tokens) {
      const comparator = normalizeComparator(token)
      if (comparator === null) return null
      normalized.push(comparator)
    }
    sets.push(normalized.join(' '))
  }
  return sets.length === 0 ? null : sets.join(' || ')
}

export default { validRange, rcompare, compare, parseVersion }
