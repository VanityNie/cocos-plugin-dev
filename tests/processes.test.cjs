'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const processes = require('../lib/processes.cjs');

const execFile = promisify(cp.execFile);
const modulePath = require.resolve('../lib/processes.cjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const supported = process.platform === 'win32' || process.platform === 'linux';
const processTest = (name, options, fn) => {
    if (typeof options === 'function') { fn = options; options = {}; }
    return test(name, { timeout: 60000, skip: !supported, ...options }, fn);
};

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

async function waitFor(check, message, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await sleep(25);
    }
    assert.fail(message);
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-plugin-processes-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'process-test' }));
    fs.mkdirSync(path.join(root, 'assets'));
    const identities = new Map();
    const pendingIdentities = [];
    const children = [];
    const recordPath = path.join(root, '.plugin-dev/game-process.json');
    const lockPath = path.join(root, '.plugin-dev/windows-operation.lock');
    const track = (identity) => { if (identity) identities.set(identity.pid, identity); return identity; };
    t.after(async () => {
        const failures = [];
        for (const pending of pendingIdentities) {
            try { track(await pending); } catch (error) { failures.push(error); }
        }
        // A startup assertion may fail before returning its identity. The record
        // still provides the exact identity of the process this fixture created.
        if (fs.existsSync(recordPath)) {
            try {
                const state = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
                // Do not trust forged records used by the mismatch test.
                if (!identities.has(state.identity?.pid) && state.identity) {
                    const actual = await processes.inspect(state.identity.pid);
                    if (processes.matches(actual, state.identity)) track(actual);
                }
            } catch (error) { failures.push(error); }
        }
        for (const identity of [...identities.values()].reverse()) {
            try { await processes.terminate(identity); } catch (error) { failures.push(error); }
        }
        for (const { child, closed } of children) {
            let timeout;
            try {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
                await Promise.race([closed, new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error(`Fixture process ${child.pid} did not exit.`)), 5000);
                })]);
            } catch (error) { failures.push(error); }
            finally { clearTimeout(timeout); }
        }
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        if (failures.length) throw new AggregateError(failures, 'Could not clean up test processes');
    });
    async function spawnNode(source, args = []) {
        const child = cp.spawn(process.execPath, ['-e', source, ...args], {
            cwd: root, detached: true, windowsHide: true, shell: false, stdio: 'ignore',
        });
        const closed = new Promise((resolve) => child.once('close', resolve));
        children.push({ child, closed });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        const identity = track(await processes.inspect(child.pid));
        assert.ok(identity, 'fixture process must remain alive');
        return { child, closed, identity };
    }
    const observe = (pending) => {
        pendingIdentities.push(pending);
        // Cleanup awaits the original promise even if the test fails first.
        pending.catch(() => {});
    };
    return { root, recordPath, lockPath, track, spawnNode, observe };
}

async function inSeparateNode(project, action) {
    const source = `
        const p = require(process.argv[1]);
        const project = process.argv[2];
        const action = process.argv[3];
        p.withLock(project, () => action === 'start'
            ? p.startUnlocked(project, process.execPath, { args: ['-e', 'setInterval(() => {}, 1000)'] })
            : action === 'stop' ? p.stopUnlocked(project) : p.recorded(project))
            .then(result => process.stdout.write(JSON.stringify(result)))
            .catch(error => { console.error(error.stack); process.exitCode = 1; });
    `;
    const result = await execFile(process.execPath, ['-e', source, modulePath, project, action], {
        cwd: project, windowsHide: true, timeout: 30000, encoding: 'utf8',
    });
    return JSON.parse(result.stdout);
}

processTest('a game record survives its launching CLI and prevents duplicate starts', async (t) => {
    const f = fixture(t);
    const started = f.track(await inSeparateNode(f.root, 'start'));
    assert.equal(started.alreadyRunning, false);
    assert.equal(path.resolve(started.executable).toLowerCase(), path.resolve(process.execPath).toLowerCase());
    assert.ok(fs.existsSync(started.logPath));
    const duplicate = await processes.withLock(f.root, () => processes.startUnlocked(f.root, process.execPath, {
        args: ['-e', 'process.exit(99)'],
    }));
    assert.equal(duplicate.alreadyRunning, true);
    assert.equal(duplicate.pid, started.pid);
    assert.equal(duplicate.startedAt, started.startedAt);
    const persisted = await inSeparateNode(f.root, 'recorded');
    assert.equal(persisted.identity.pid, started.pid);
    const stopped = await inSeparateNode(f.root, 'stop');
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.pid, started.pid);
    assert.equal(await processes.inspect(started.pid), null);
    assert.equal(fs.existsSync(f.recordPath), false);
    assert.deepEqual(await processes.withLock(f.root, () => processes.stopUnlocked(f.root)), { stopped: false, reason: 'not-running' });
});

processTest('Windows startup reports a process that exits before identity inspection completes', { skip: process.platform !== 'win32' }, async (t) => {
    const f = fixture(t);
    await assert.rejects(processes.withLock(f.root, () => processes.startUnlocked(f.root, process.execPath, {
        args: ['-e', 'process.exit(23)'],
    })), /Game exited during startup \(exit 23/);
    assert.equal(fs.existsSync(f.recordPath), false);
    assert.equal(fs.existsSync(f.lockPath), false);
});

processTest('mismatching creation time, executable or recorded PID never terminates an innocent process', async (t) => {
    const f = fixture(t);
    const first = await f.spawnNode('setInterval(() => {}, 1000)');
    await sleep(30); // Linux creation times use scheduler ticks.
    const second = await f.spawnNode('setInterval(() => {}, 1000)');
    for (const forged of [
        { ...first.identity, startedAt: `${first.identity.startedAt}0` },
        { ...first.identity, executable: path.join(f.root, 'unrelated.exe') },
        { ...first.identity, pid: second.identity.pid },
    ]) {
        await assert.rejects(processes.terminate(forged), { code: 'PROCESS_IDENTITY_MISMATCH' });
        assert.ok(processes.matches(await processes.inspect(first.identity.pid), first.identity));
        assert.ok(processes.matches(await processes.inspect(second.identity.pid), second.identity));
    }
    fs.mkdirSync(path.dirname(f.recordPath), { recursive: true });
    const stale = JSON.stringify({ schemaVersion: 1, projectPath: f.root, identity: { ...first.identity, pid: second.identity.pid }, logPath: 'unused' });
    fs.writeFileSync(f.recordPath, stale);
    await assert.rejects(processes.withLock(f.root, () => processes.stopUnlocked(f.root)), { code: 'PROCESS_IDENTITY_MISMATCH' });
    assert.equal(fs.readFileSync(f.recordPath, 'utf8'), stale);
    assert.ok(await processes.inspect(second.identity.pid));
});

processTest('stopping a recorded game terminates its existing child process tree', async (t) => {
    const f = fixture(t);
    const childFile = path.join(f.root, 'child.json');
    const source = `
        const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
        require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: child.pid }));
        setInterval(() => {}, 1000);
    `;
    const parent = f.track(await processes.withLock(f.root, () => processes.startUnlocked(f.root, process.execPath, {
        args: ['-e', source, childFile], cwd: f.root,
    })));
    await waitFor(() => fs.existsSync(childFile), 'game did not create its child');
    const child = f.track(await processes.inspect(JSON.parse(fs.readFileSync(childFile, 'utf8')).pid));
    assert.ok(child);
    const result = await processes.withLock(f.root, () => processes.stopUnlocked(f.root));
    assert.equal(result.stopped, true);
    assert.equal(await processes.inspect(parent.pid), null);
    assert.equal(await processes.inspect(child.pid), null);
    assert.equal(fs.existsSync(f.recordPath), false);
});

processTest('concurrent operations serialize and a timed out waiter leaves the owner lock intact', async (t) => {
    const f = fixture(t);
    const entered = deferred();
    const release = deferred();
    const order = [];
    const first = processes.withLock(f.root, async () => {
        order.push('first'); entered.resolve(); await release.promise; order.push('released');
    });
    try {
        await entered.promise;
        const original = fs.readFileSync(path.join(f.lockPath, 'owner.json'), 'utf8');
        await assert.rejects(processes.withLock(f.root, () => assert.fail('busy operation entered'), { lockTimeoutMs: 0 }), { code: 'PROJECT_BUSY' });
        assert.equal(fs.readFileSync(path.join(f.lockPath, 'owner.json'), 'utf8'), original);
        const second = processes.withLock(f.root, () => { order.push('second'); return 42; });
        await sleep(30);
        assert.deepEqual(order, ['first']);
        release.resolve();
        await first;
        assert.equal(await second, 42);
        assert.deepEqual(order, ['first', 'released', 'second']);
        assert.equal(fs.existsSync(f.lockPath), false);
    } finally { release.resolve(); await first; }
});

processTest('cancelling a lock waiter does not run its callback or release the current owner', async (t) => {
    const f = fixture(t);
    const entered = deferred();
    const release = deferred();
    const owner = processes.withLock(f.root, async () => { entered.resolve(); await release.promise; });
    try {
        await entered.promise;
        const original = fs.readFileSync(path.join(f.lockPath, 'owner.json'), 'utf8');
        const controller = new AbortController();
        const waiter = processes.withLock(f.root, () => assert.fail('cancelled waiter entered'), { signal: controller.signal });
        await sleep(30);
        controller.abort();
        await assert.rejects(waiter, { name: 'AbortError', code: 'ABORT_ERR' });
        assert.equal(fs.readFileSync(path.join(f.lockPath, 'owner.json'), 'utf8'), original);
        await assert.rejects(processes.withLock(f.root, () => assert.fail('pre-cancelled operation entered'), { signal: controller.signal }), { code: 'ABORT_ERR' });
    } finally { release.resolve(); await owner; }
    assert.equal(fs.existsSync(f.lockPath), false);
});

processTest('an abruptly exited lock owner requires recovery and its lock is never taken over', async (t) => {
    const f = fixture(t);
    const ready = path.join(f.root, 'owner-ready');
    const source = `
        require(process.argv[1]).withLock(process.argv[2], async () => {
            require('node:fs').writeFileSync(process.argv[3], 'ready');
            await new Promise(() => { setInterval(() => {}, 1000); });
        }).catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const owner = await f.spawnNode(source, [modulePath, f.root, ready]);
    await waitFor(() => fs.existsSync(ready), 'independent owner did not acquire its lock');
    const ownerFile = path.join(f.lockPath, 'owner.json');
    const original = fs.readFileSync(ownerFile, 'utf8');
    assert.equal(JSON.parse(original).identity.pid, owner.identity.pid);
    await processes.terminate(owner.identity);
    await owner.closed;
    await assert.rejects(processes.withLock(f.root, () => assert.fail('dead lock was taken over')), { code: 'PROJECT_LOCK_RECOVERY_REQUIRED' });
    assert.equal(fs.readFileSync(ownerFile, 'utf8'), original);
});

processTest('failed process cleanup retains the operation lock with an explicit recovery reason', async (t) => {
    const f = fixture(t);
    const failure = Object.assign(new Error('fixture cleanup could not be verified'), { code: 'PROCESS_CLEANUP_FAILED' });
    await assert.rejects(processes.withLock(f.root, () => { throw failure; }), { code: 'PROCESS_CLEANUP_FAILED' });
    const owner = JSON.parse(fs.readFileSync(path.join(f.lockPath, 'owner.json'), 'utf8'));
    assert.match(owner.cleanupFailure, /fixture cleanup could not be verified/);
    await assert.rejects(processes.withLock(f.root, () => assert.fail('unsafe lock was taken over')), { code: 'PROJECT_LOCK_RECOVERY_REQUIRED' });
});

processTest('Windows cancellation during startup waits for the spawned game to exit before unlocking', { skip: process.platform !== 'win32' }, async (t) => {
    const f = fixture(t);
    const pidFile = path.join(f.root, 'starting.pid');
    const controller = new AbortController();
    const startup = processes.withLock(f.root, () => processes.startUnlocked(f.root, process.execPath, {
        signal: controller.signal,
        args: ['-e', "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", pidFile],
    }), { signal: controller.signal }).then(f.track);
    const settled = startup.then(value => ({ value }), error => ({ error }));
    try {
        await waitFor(() => fs.existsSync(pidFile), 'game did not reach startup');
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        f.observe(processes.inspect(pid));
        controller.abort();
        assert.ok(fs.existsSync(f.lockPath), 'cancellation must not release the lock before cleanup');
        const result = await settled;
        assert.equal(result.error?.name, 'AbortError');
        assert.equal(result.error?.code, 'ABORT_ERR');
        assert.equal(await processes.inspect(pid), null);
        assert.equal(fs.existsSync(f.recordPath), false);
        assert.equal(fs.existsSync(f.lockPath), false);
    } finally { controller.abort(); await settled; }
});
