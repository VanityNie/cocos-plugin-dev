'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRunLogReader } = require('../lib/run-log.cjs');
const processes = require('../lib/processes.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');

const execute = promisify(execFile);
const writer = path.join(__dirname, 'fixtures/run-log/writer.cjs');
const launcher = path.join(__dirname, 'fixtures/run-log/launcher.cjs');

function fixture(t) {
    const parent = path.resolve(__dirname, '../.local');
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'run-log-'));
    const logPath = path.join(root, '.plugin-dev/logs/runtime.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    support.writeJson(path.join(root, 'package.json'), { name: 'run-log-test' });
    fs.mkdirSync(path.join(root, 'assets'));
    const readers = [];
    t.after(async () => {
        for (const reader of readers) reader.close();
        await processes.stopUnlocked(root);
        support.inside(parent, root);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const reader = (options) => {
        const result = createRunLogReader(root, options);
        readers.push(result);
        return result;
    };
    return { root, logPath, reader };
}

async function waitFor(check, description) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await processes.delay(25);
    }
    assert.fail(description);
}

function drain(reader, input) {
    let text = '';
    let result = reader.read(input);
    text += result.text;
    while (result.hasMore) {
        result = reader.read({ ...input, offset: result.offset });
        text += result.text;
    }
    return { ...result, text };
}

test('UTF-8 中文与 emoji 跨文件写入和读取分段仍完整', async t => {
    const f = fixture(t);
    const reader = f.reader({ maxBytes: 2 });
    assert.equal(reader.read({ running: true }).exists, false);
    const bytes = Buffer.from('中文🙂\n');
    fs.writeFileSync(f.logPath, bytes.subarray(0, 2));
    assert.equal(reader.read({ running: true }).text, '');
    fs.appendFileSync(f.logPath, bytes.subarray(2));
    assert.equal(drain(reader, { running: true }).text, '中文🙂\n');
    assert.equal(reader.read({ running: false }).text, '');
});

test('首次历史预览保持完整行，单次读取上限为64KiB', async t => {
    const f = fixture(t);
    const prefix = `${'历史中文'.repeat(20000)}\n`;
    fs.writeFileSync(f.logPath, `${prefix}最新输出中文🙂\n`);
    const reader = f.reader();
    const result = reader.read({ running: false });
    assert.equal(result.truncated, true);
    assert.equal(result.text, '最新输出中文🙂\n');
    assert.equal(result.hasMore, false);
    const complete = f.reader();
    const first = complete.read({ offset: 0, running: false });
    assert.equal(first.offset, 65536);
    assert.equal(first.hasMore, true);
    assert.equal(first.text + drain(complete, { running: false }).text, `${prefix}最新输出中文🙂\n`);
});

test('日志替换、截断和明确读取位置重置正确', async t => {
    const f = fixture(t);
    fs.writeFileSync(f.logPath, '第一段日志\n');
    const reader = f.reader();
    assert.equal(reader.read({ running: true }).text, '第一段日志\n');
    fs.writeFileSync(f.logPath, '短\n');
    const shortened = reader.read({ running: true });
    assert.equal(shortened.reset, true);
    assert.equal(shortened.text, '短\n');
    fs.renameSync(f.logPath, `${f.logPath}.previous`);
    fs.writeFileSync(f.logPath, '替换后的完整日志内容\n');
    const replaced = reader.read({ running: true });
    assert.equal(replaced.reset, true);
    assert.equal(replaced.text, '替换后的完整日志内容\n');
    assert.equal(reader.read({ offset: 0, running: false }).text, '替换后的完整日志内容\n');
    const future = f.reader({ initialBytes: 0 });
    assert.equal(future.read({ running: true }).text, '');
    fs.appendFileSync(f.logPath, '追加完整行\n');
    assert.equal(future.read({ running: true }).text, '追加完整行\n');
});

test('进程退出后读取全部积压，最后不完整的UTF-8序列只结束一次', async t => {
    const f = fixture(t);
    fs.writeFileSync(f.logPath, Buffer.concat([Buffer.from('最后中文🙂\n'), Buffer.from([0xe4, 0xb8])]));
    const reader = f.reader({ maxBytes: 2 });
    const result = drain(reader, { running: false });
    assert.equal(result.text, '最后中文🙂\n�');
    assert.equal(reader.read({ running: false }).text, '');
});

test('读取器关闭后释放资源且拒绝继续读取，不允许访问项目之外', async t => {
    const f = fixture(t);
    fs.writeFileSync(f.logPath, '关闭读取器\n');
    const reader = f.reader();
    assert.throws(() => reader.read({ running: true, logPath: __filename }));
    assert.throws(() => reader.read({ running: true, offset: -1 }));
    assert.throws(() => reader.read({ running: true, logPath: path.dirname(f.logPath) }));
    assert.equal(reader.read({ running: true, logPath: f.logPath }).text, '关闭读取器\n');
    reader.close();
    reader.close();
    assert.throws(() => reader.read({ running: true }), /已经关闭/);
    fs.renameSync(f.logPath, `${f.logPath}.closed`);
    assert.equal(fs.existsSync(f.logPath), false);
});

test('真实独立进程在启动调用完成后持续输出，已有进程、退出、重启均可读取', { timeout: 60000 }, async t => {
    const f = fixture(t);
    fs.writeFileSync(f.logPath, '较早运行输出\n');
    const commandDirectory = path.join(f.root, 'first-control');
    fs.mkdirSync(commandDirectory);
    const launch = await execute(process.execPath, [launcher, f.root, writer, commandDirectory], { windowsHide: true, timeout: 20000 });
    const started = JSON.parse(launch.stdout);
    await waitFor(() => fs.existsSync(path.join(commandDirectory, 'ready')), '游戏没有完成初始日志写入');
    assert.equal(started.logOffset, Buffer.byteLength('较早运行输出\n'));
    const record = await processes.recorded(f.root);
    assert.equal(record.logOffset, started.logOffset);
    assert.equal(record.identity.pid, started.pid);
    const duplicate = await processes.startUnlocked(f.root, process.execPath, { args: [writer, 'early-exit'] });
    assert.equal(duplicate.alreadyRunning, true);
    assert.equal(duplicate.logOffset, started.logOffset);
    assert.equal(duplicate.pid, started.pid);
    const reader = f.reader({ maxBytes: 5 });
    assert.equal(drain(reader, { offset: started.logOffset, running: true, identity: record.identity }).text,
        '游戏启动中文\nstderr 中文\n');
    let commandId = 0;
    async function command(bytes, options = {}) {
        const id = ++commandId;
        support.writeJson(path.join(commandDirectory, 'command.json'), { id, bytes: bytes.toString('base64'), ...options });
        await waitFor(() => fs.existsSync(path.join(commandDirectory, `done-${id}`)), '游戏没有完成日志写入');
    }
    const split = Buffer.from('持续中文🙂\n');
    await command(split.subarray(0, 2));
    assert.equal(reader.read({ running: true }).text, '');
    await command(split.subarray(2));
    assert.equal(drain(reader, { running: true }).text, '持续中文🙂\n');
    reader.close();
    assert.ok(await processes.inspect(started.pid));
    const reopened = f.reader();
    assert.equal(reopened.read({ offset: started.logOffset, running: true }).text,
        '游戏启动中文\nstderr 中文\n持续中文🙂\n');
    const final = Buffer.from('退出前最后输出中文\n');
    await command(final, { channel: 2, exit: true });
    await waitFor(async () => !await processes.inspect(started.pid), '游戏没有正常退出');
    assert.equal(reopened.read({ running: false }).text, final.toString());
    assert.equal(await processes.recorded(f.root), null);
    const secondDirectory = path.join(f.root, 'second-control');
    fs.mkdirSync(secondDirectory);
    const expectedOffset = fs.statSync(f.logPath).size;
    const restarted = await processes.startUnlocked(f.root, process.execPath, { args: [writer, secondDirectory] });
    await waitFor(() => fs.existsSync(path.join(secondDirectory, 'ready')), '重启游戏没有完成初始日志写入');
    assert.equal(restarted.alreadyRunning, false);
    assert.equal(restarted.logOffset, expectedOffset);
    assert.equal(reopened.read({ offset: restarted.logOffset, running: true, identity: restarted }).text,
        '游戏启动中文\nstderr 中文\n');
});

test('真实启动失败携带本次stderr的日志路径和起点', { timeout: 30000, skip: process.platform !== 'win32' }, async t => {
    const f = fixture(t);
    fs.writeFileSync(f.logPath, '原有历史日志\n');
    const logOffset = fs.statSync(f.logPath).size;
    let failure;
    await assert.rejects(processes.startUnlocked(f.root, process.execPath, { args: [writer, 'early-exit'] }), error => {
        failure = error;
        assert.deepEqual(error.runLog, { logPath: f.logPath, logOffset });
        return true;
    });
    const reader = f.reader();
    assert.equal(reader.read({ logPath: failure.runLog.logPath, offset: failure.runLog.logOffset, running: false }).text,
        '启动阶段中文错误\n');
});
