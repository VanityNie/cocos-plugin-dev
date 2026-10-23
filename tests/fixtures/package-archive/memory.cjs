'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { publishPackage } = require('../../../lib/package-archive.cjs');
const support = require('../../../templates/common/editor/plugin-support.cjs');

async function main() {
    const root = path.resolve(process.argv[2]);
    const source = path.join(root, 'payload.bin');
    const entries = new Map([['plugin/resources/payload.bin', { source, sha256: support.hashFile(source) }]]);
    const result = { directory: path.join(root, 'distribution'), zipPath: path.join(root, 'distribution.zip') };
    let peak = 0;
    let ticks = 0;
    const timer = setInterval(() => { ticks++; peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 5);
    try { await publishPackage({ entries, result }); }
    finally { clearInterval(timer); }
    process.stdout.write(JSON.stringify({ peak, ticks, sha256: support.hashFile(path.join(result.directory, 'plugin/resources/payload.bin')) }));
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
