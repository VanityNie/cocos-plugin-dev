'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const support = require('../templates/common/editor/plugin-support.cjs');
const { publishPackage } = require('../lib/package-archive.cjs');

function fixture(t) {
    const local = path.resolve(__dirname, '../.local');
    fs.mkdirSync(local, { recursive: true });
    const root = fs.mkdtempSync(path.join(local, 'package-archive-'));
    t.after(() => { support.inside(local, root); fs.rmSync(root, { recursive: true, force: true }); });
    const source = path.join(root, 'source.json');
    fs.writeFileSync(source, JSON.stringify({ name: 'archive-test', version: '1.0.0' }));
    const result = { directory: path.join(root, 'output/distribution'), zipPath: path.join(root, 'output/distribution.zip') };
    return { root, source, result, entries: new Map([['plugin/source.json', { source }]]) };
}

test('流式压缩真实大文件保持有限内存，并允许事件循环继续运行', t => {
    const f = fixture(t);
    const source = path.join(f.root, 'payload.bin');
    const block = crypto.randomBytes(1024 * 1024);
    const fd = fs.openSync(source, 'wx');
    try { for (let i = 0; i < 128; i++) fs.writeSync(fd, block); }
    finally { fs.closeSync(fd); }
    const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'fixtures/package-archive/memory.cjs'), f.root], { encoding: 'utf8' }));
    assert.ok(result.peak < 64 * 1024 * 1024, `Buffer 内存峰值: ${result.peak}`);
    assert.ok(result.ticks > 10);
    assert.equal(result.sha256, support.hashFile(source));
    if (process.platform === 'win32') {
        const extracted = path.join(f.root, 'extracted');
        execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.join(__dirname, 'fixtures/package-archive/expand.ps1'), path.join(f.root, 'distribution.zip'), extracted]);
        assert.equal(support.hashFile(path.join(extracted, 'plugin/resources/payload.bin')), result.sha256);
    }
});

test('源文件读取失败、构建指纹不符和取消均终止发布并清理中间文件', async t => {
    const f = fixture(t);
    for (const entry of [{ source: path.join(f.root, 'missing.bin') }, { source: f.source, sha256: '0'.repeat(64) }]) {
        await assert.rejects(publishPackage({ entries: new Map([['plugin/data.bin', entry]]), result: f.result }), /ENOENT|指纹/);
        assert.deepEqual(fs.readdirSync(path.dirname(f.result.directory)), []);
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(publishPackage(f, controller.signal), { name: 'AbortError' });
    assert.deepEqual(fs.readdirSync(path.dirname(f.result.directory)), []);
});

test('发布目标已存在时保留原文件且删除本次中间文件', async t => {
    const f = fixture(t);
    fs.mkdirSync(path.dirname(f.result.zipPath), { recursive: true });
    fs.writeFileSync(f.result.zipPath, 'user-owned archive');
    await assert.rejects(publishPackage(f), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(f.result.zipPath, 'utf8'), 'user-owned archive');
    assert.deepEqual(fs.readdirSync(path.dirname(f.result.directory)), ['distribution.zip']);
});

test('压缩过程中取消会关闭文件并清理未完成的 ZIP', async t => {
    const f = fixture(t);
    fs.truncateSync(f.source, 128 * 1024 * 1024);
    const controller = new AbortController();
    const output = path.dirname(f.result.directory);
    const timer = setInterval(() => {
        if (!fs.existsSync(output)) return;
        for (const directory of fs.readdirSync(output)) {
            if (directory.startsWith('.package-') && fs.existsSync(path.join(output, directory, 'package.zip'))) controller.abort();
        }
    }, 5);
    try { await assert.rejects(publishPackage(f, controller.signal), { name: 'AbortError' }); }
    finally { clearInterval(timer); }
    assert.deepEqual(fs.readdirSync(output), []);
});
