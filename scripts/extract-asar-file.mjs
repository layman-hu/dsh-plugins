/**
 * Maintenance helper: extract one file from an Electron `app.asar` archive
 * without the `@electron/asar` package.
 *
 * Used to re-vendor MIT-licensed upstream sources this repository keeps a copy
 * of (currently `@deepseek-ai/dsh-plugin-market-index` -> scripts/lib/market-index-validator.mjs).
 * Not part of any runtime path.
 *
 * Usage:
 *   node scripts/extract-asar-file.mjs --asar <path/to/app.asar> \
 *     --path dsh/node_modules/<pkg>/lib/index.js --out <destination file>
 */
import { readFileSync, writeFileSync } from 'node:fs'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--asar') options.asar = argv[++index]
    else if (arg === '--path') options.path = argv[++index]
    else if (arg === '--out') options.out = argv[++index]
    else {
      console.error(`extract-asar-file: unknown argument ${JSON.stringify(arg)}`)
      process.exit(2)
    }
  }
  if (options.asar === undefined || options.path === undefined || options.out === undefined) {
    console.error('usage: node scripts/extract-asar-file.mjs --asar <app.asar> --path <inner/path> --out <file>')
    process.exit(2)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const archive = readFileSync(options.asar)
// asar pickle header: [4][header pickle size][header payload size][json length][json header]
const jsonLength = archive.readUInt32LE(12)
const header = JSON.parse(archive.subarray(16, 16 + jsonLength).toString('utf8'))
const dataStart = 16 + jsonLength

let directory = header
let node
const parts = options.path.split('/')
for (const [index, part] of parts.entries()) {
  node = directory?.files?.[part]
  if (node === undefined) {
    console.error(`extract-asar-file: ${part} not found in ${parts.slice(0, index).join('/') || '<root>'}`)
    process.exit(1)
  }
  if (index < parts.length - 1) directory = node
}
if (typeof node.offset !== 'string') {
  console.error(`extract-asar-file: ${options.path} is a directory, not a file`)
  process.exit(1)
}
const start = dataStart + Number(node.offset)
const content = archive.subarray(start, start + Number(node.size))
writeFileSync(options.out, content)
console.log(`extract-asar-file: wrote ${String(content.length)} bytes to ${options.out}`)
