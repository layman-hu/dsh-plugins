/**
 * Offline self-test for `scripts/make-index.mjs --check`.
 *
 * The defect this locks down: the check used to compare the index generated from
 * HEAD with the committed one, including each version's pinned `source.commit`.
 * Right after a release you commit `index.json`, HEAD moves to a new commit B while
 * the index keeps pinning release commit A — so such a check would report "stale"
 * forever. The new check ignores the pinned commit for equality, compares everything
 * else strictly, and instead verifies that each pinned commit really contains the
 * indexed package version.
 *
 * Each case builds a throwaway git repository under the OS temp directory, so this
 * runs offline on Windows and Linux.
 *
 * Run: node --test scripts/index-check.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAKE_INDEX = join(HERE, 'make-index.mjs')

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
  }).trim()
}

function commitAll(repo, message) {
  git(repo, ['add', '-A'])
  git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message])
  return git(repo, ['rev-parse', 'HEAD'])
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function packageManifest(version) {
  return {
    name: '@example/demo',
    version,
    description: 'fixture plugin',
    license: 'MIT',
    author: 'test',
    homepage: 'https://example.test/demo#readme',
    dsh: {
      manifestVersion: 1,
      bundle: { patch: ['./cordis.patch.yml'], platforms: ['win32'] },
      market: {
        category: 'desktop',
        labels: ['popup'],
        title: { en: 'Demo', zh: '演示' },
        description: { en: 'A fixture plugin.', zh: '测试插件。' }
      }
    },
    engines: { dsh: '>=0.2.2-rc.1 <0.3.0' }
  }
}

function makeFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-index-check-'))
  writeJson(join(repo, 'package.json'), {
    name: 'dsh-plugins',
    version: '0.1.0',
    private: true,
    type: 'module',
    dsh: {
      marketIndex: {
        title: { en: 'Fixture plugins', zh: '测试插件集' },
        categories: { desktop: { title: { en: 'Desktop', zh: '桌面' } } },
        labels: { popup: { title: { en: 'Popup', zh: '弹窗' } } }
      }
    }
  })
  const packageDir = join(repo, 'packages', 'demo')
  mkdirSync(packageDir, { recursive: true })
  writeJson(join(packageDir, 'package.json'), packageManifest('0.1.0'))
  writeFileSync(join(packageDir, 'cordis.patch.yml'), '- insert: []\n', 'utf8')
  writeFileSync(join(packageDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n', 'utf8')
  git(repo, ['init', '-q'])
  const releaseCommit = commitAll(repo, 'release 0.1.0')
  return { repo, packageDir, releaseCommit }
}

function runMakeIndex(repo, args = []) {
  const result = spawnSync(process.execPath, [MAKE_INDEX, '--repo-root', repo, ...args], {
    encoding: 'utf8'
  })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

function readIndex(repo) {
  return JSON.parse(readFileSync(join(repo, 'index.json'), 'utf8'))
}

function withFixture(callback) {
  const fixture = makeFixture()
  try {
    return callback(fixture)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
}

test('generation pins the release commit and is deterministic', () => {
  withFixture(({ repo, releaseCommit }) => {
    const first = runMakeIndex(repo)
    assert.equal(first.code, 0, first.stderr)
    const index = readIndex(repo)
    assert.equal(index.plugins[0].versions[0].source.commit, releaseCommit)
    const firstText = readFileSync(join(repo, 'index.json'), 'utf8')

    const second = runMakeIndex(repo)
    assert.equal(second.code, 0, second.stderr)
    assert.equal(readFileSync(join(repo, 'index.json'), 'utf8'), firstText, 'same commit must produce the same index')
  })
})

test('check passes after index.json is committed (HEAD moves past the pinned release commit)', () => {
  withFixture(({ repo, releaseCommit }) => {
    assert.equal(runMakeIndex(repo).code, 0)
    const indexCommit = commitAll(repo, 'chore: publish plugin market index')
    assert.notEqual(indexCommit, releaseCommit)
    assert.equal(readIndex(repo).plugins[0].versions[0].source.commit, releaseCommit)

    const check = runMakeIndex(repo, ['--check'])
    assert.equal(check.code, 0, check.stderr)
    assert.match(check.stdout, /index\.json is consistent \(1 plugin\(s\), 1 version\(s\)/)
  })
})

test('check fails on a shallow clone of the index commit until the history is fetched', () => {
  withFixture(({ repo }) => {
    assert.equal(runMakeIndex(repo).code, 0)
    commitAll(repo, 'chore: publish plugin market index')
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-index-shallow-'))
    const clone = join(sandbox, 'clone')
    try {
      // CI defaults to actions/checkout depth=1: the clone contains only the index
      // commit, not the release commit the index pins.
      const url = `file:///${repo.replaceAll('\\', '/')}`
      execFileSync('git', ['clone', '-q', '--depth', '1', url, clone], { stdio: ['ignore', 'pipe', 'pipe'] })
      const shallow = runMakeIndex(clone, ['--check'])
      assert.equal(shallow.code, 1)
      assert.match(shallow.stderr, /does not contain packages\/demo\/package\.json/)
      assert.match(shallow.stderr, /fetch --unshallow/)

      execFileSync('git', ['-C', clone, 'fetch', '-q', '--unshallow'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const full = runMakeIndex(clone, ['--check'])
      assert.equal(full.code, 0, full.stderr)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

test('check fails when a package version changes without regenerating the index', () => {
  withFixture(({ repo, packageDir }) => {
    assert.equal(runMakeIndex(repo).code, 0)
    commitAll(repo, 'chore: publish plugin market index')

    writeJson(join(packageDir, 'package.json'), packageManifest('0.2.0'))
    const check = runMakeIndex(repo, ['--check'])
    assert.equal(check.code, 1)
    assert.match(check.stderr, /STALE/)
    assert.match(check.stderr, /0\.2\.0/)
  })
})

test('check fails when a pinned commit does not exist', () => {
  withFixture(({ repo }) => {
    assert.equal(runMakeIndex(repo).code, 0)
    commitAll(repo, 'chore: publish plugin market index')

    const index = readIndex(repo)
    index.plugins[0].versions[0].source.commit = 'f'.repeat(40)
    writeJson(join(repo, 'index.json'), index)

    const check = runMakeIndex(repo, ['--check'])
    assert.equal(check.code, 1)
    assert.match(check.stderr, /STALE/)
    assert.match(check.stderr, /does not contain packages\/demo\/package\.json/)
  })
})

test('check fails when publishTimestamp violates the format rule', () => {
  withFixture(({ repo }) => {
    assert.equal(runMakeIndex(repo).code, 0)
    commitAll(repo, 'chore: publish plugin market index')

    const index = readIndex(repo)
    index.plugins[0].versions[0].publishTimestamp = 1e12
    writeJson(join(repo, 'index.json'), index)

    const check = runMakeIndex(repo, ['--check'])
    assert.equal(check.code, 1)
    assert.match(check.stderr, /publishTimestamp/)
  })
})

test('check reports a clear error when the checkout is not a git repository', () => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-index-check-nogit-'))
  try {
    writeJson(join(repo, 'package.json'), { name: 'x', version: '0.1.0', private: true })
    const check = runMakeIndex(repo, ['--check'])
    assert.equal(check.code, 1)
    assert.match(check.stderr, /cannot find .*index\.json/)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
