'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const support = require('../templates/common/editor/plugin-support.cjs');

const MAX_BYTES = 64 * 1024;

function createRunLogReader(projectPath, options = {}) {
    const project = path.resolve(projectPath);
    const initialBytes = options.initialBytes ?? MAX_BYTES;
    const maxBytes = options.maxBytes ?? MAX_BYTES;
    let closed = false;
    let position = 0;
    let currentPath = null;
    let fileIdentity = null;
    let processIdentity = null;
    let decoder = new StringDecoder('utf8');
    let skipPartialLine = false;

    function read(input = {}) {
        if (closed) throw new Error('运行日志读取器已经关闭。');
        if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) {
            throw new Error('运行日志 offset 必须是非负整数。');
        }
        const running = Boolean(input.running);
        const logPath = path.resolve(input.logPath || path.join(project, '.plugin-dev/logs/runtime.log'));
        if (logPath !== currentPath) {
            support.inside(project, logPath);
            support.noLinks(project, logPath);
        }
        const session = input.identity ? `${input.identity.pid}:${input.identity.startedAt}` : null;
        const changedPath = currentPath !== null && currentPath !== logPath;
        const changedSession = processIdentity !== null && session !== null && processIdentity !== session;
        const changedOffset = input.offset !== undefined && input.offset !== position;
        let reset = changedPath || changedSession || changedOffset;
        let truncated = false;
        if (reset) {
            decoder = new StringDecoder('utf8');
            skipPartialLine = false;
        }
        if (changedPath) { fileIdentity = null; position = 0; }
        currentPath = logPath;
        if (session !== null) processIdentity = session;
        let fd;
        try { fd = fs.openSync(logPath, 'r'); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const text = running ? '' : decoder.end();
            if (!running) decoder = new StringDecoder('utf8');
            return { text, logPath, offset: position, hasMore: false, reset, truncated, exists: false };
        }
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) throw new Error(`运行日志必须是普通文件：${logPath}`);
            const nextIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
            const firstRead = fileIdentity === null;
            const replaced = !firstRead && fileIdentity !== nextIdentity;
            if (input.offset !== undefined) position = input.offset;
            else if (firstRead) {
                position = Math.max(0, stat.size - initialBytes);
                skipPartialLine = position > 0 && initialBytes > 0;
                truncated = position > 0;
                if (skipPartialLine) {
                    const previous = Buffer.allocUnsafe(1);
                    fs.readSync(fd, previous, 0, 1, position - 1);
                    skipPartialLine = previous[0] !== 10;
                }
            }
            if (replaced || position > stat.size) {
                position = 0;
                reset = true;
                skipPartialLine = false;
                decoder = new StringDecoder('utf8');
            }
            fileIdentity = nextIdentity;
            const buffer = Buffer.allocUnsafe(Math.min(maxBytes, stat.size - position));
            const count = buffer.length ? fs.readSync(fd, buffer, 0, buffer.length, position) : 0;
            position += count;
            let bytes = buffer.subarray(0, count);
            // 末尾预览从完整日志行开始，跨读取块的 UTF-8 字符由 StringDecoder 保存。
            if (skipPartialLine) {
                const newline = bytes.indexOf(10);
                bytes = newline < 0 ? bytes.subarray(bytes.length) : bytes.subarray(newline + 1);
                if (newline >= 0) skipPartialLine = false;
            }
            let text = decoder.write(bytes);
            const hasMore = position < stat.size;
            if (!running && !hasMore) {
                text += decoder.end();
                decoder = new StringDecoder('utf8');
                skipPartialLine = false;
            }
            return { text, logPath, offset: position, hasMore, reset, truncated, exists: true };
        } finally { fs.closeSync(fd); }
    }

    function close() {
        closed = true;
        decoder = new StringDecoder('utf8');
        currentPath = null;
        fileIdentity = null;
        processIdentity = null;
        skipPartialLine = false;
    }

    return { read, close };
}

module.exports = { createRunLogReader };
