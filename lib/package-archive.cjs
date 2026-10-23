'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const support = require('../templates/common/editor/plugin-support.cjs');
const { throwIfAborted } = require('./processes.cjs');

async function copyEntry(entry, destination, signal) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (Buffer.isBuffer(entry)) {
        await fs.promises.writeFile(destination, entry, { flag: 'wx', signal });
        return;
    }
    support.noLinks(path.parse(entry.source).root, entry.source);
    const before = fs.statSync(entry.source);
    const digest = crypto.createHash('sha256');
    const checksum = new Transform({
        transform(chunk, encoding, callback) { digest.update(chunk); callback(null, chunk); },
    });
    await pipeline(fs.createReadStream(entry.source), checksum, fs.createWriteStream(destination, { flags: 'wx' }), { signal });
    const after = fs.statSync(entry.source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error(`打包期间文件发生变化，请重新导出: ${entry.source}`);
    }
    const sha256 = digest.digest('hex');
    if (entry.sha256 && sha256 !== entry.sha256) throw new Error(`文件与构建记录的指纹不符，请重新构建: ${entry.source}`);
}

async function createArchive(directory, files, destination, signal) {
    const archive = new yazl.ZipFile();
    let input;
    const abort = error => {
        input?.destroy(error);
        archive.outputStream.destroy(error);
    };
    archive.on('error', abort);
    try {
        for (const relative of files) {
            const file = path.join(directory, relative);
            archive.addReadStreamLazy(relative, { size: fs.statSync(file).size, compressionLevel: 6 }, callback => {
                input = fs.createReadStream(file);
                callback(null, input);
            });
        }
        archive.end();
        await pipeline(archive.outputStream, fs.createWriteStream(destination, { flags: 'wx' }), { signal });
    } finally {
        input?.destroy();
        archive.outputStream.destroy();
    }
}

async function publishPackage({ entries, result }, signal) {
    throwIfAborted(signal);
    const output = path.dirname(result.directory);
    fs.mkdirSync(output, { recursive: true });
    const staging = fs.mkdtempSync(path.join(output, '.package-'));
    const contents = path.join(staging, 'contents');
    const archive = path.join(staging, 'package.zip');
    let linked = false;
    let published = false;
    try {
        for (const [relative, entry] of entries) {
            throwIfAborted(signal);
            await copyEntry(entry, support.inside(contents, path.join(contents, relative)), signal);
        }
        await createArchive(contents, entries.keys(), archive, signal);
        throwIfAborted(signal);
        // 文件链接以排他方式发布 ZIP，避免覆盖同时生成的同名包。
        fs.linkSync(archive, result.zipPath);
        linked = true;
        fs.renameSync(contents, result.directory);
        published = true;
    } finally {
        if (linked && !published) fs.unlinkSync(result.zipPath);
        support.inside(output, staging);
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

module.exports = { publishPackage };
