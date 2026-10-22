'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { parseArgs, createSandbox } = require('../cli.cjs');

function cliHarness(windows = {}) {
    const fakeProcess = new EventEmitter();
    const output = { stdout: '', stderr: '' };
    fakeProcess.stdout = { write: (text) => { output.stdout += text; } };
    fakeProcess.stderr = { write: (text) => { output.stderr += text; } };
    fakeProcess.exitCode = 0;
    const module = { exports: {} };
    const root = path.resolve(__dirname, '..');
    vm.runInNewContext(fs.readFileSync(path.join(root, 'cli.cjs'), 'utf8'), {
        module, exports: module.exports, __dirname: root, process: fakeProcess, AbortController,
        require: (id) => id === './lib/windows.cjs' ? windows : require(id),
    }, { filename: path.join(root, 'cli.cjs') });
    return { ...module.exports, process: fakeProcess, output };
}

test('CLI accepts explicit values and rejects misspelled or ambiguous flags', () => {
    assert.equal(parseArgs(['create', '--project', '.', '--name', 'neural-demo']).options.name, 'neural-demo');
    assert.throws(() => parseArgs(['create', '--project']), /Missing value/);
    assert.throws(() => parseArgs(['create', '--project', '.', '--project', '..']), /Duplicate/);
    assert.throws(() => parseArgs(['create', '--projet', '.']), /Unknown/);
});

test('sandbox creation preserves template assets but assigns project identity and refuses overwrite', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-cli-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const creator = path.join(root, 'Creator');
    const template = path.join(creator, 'resources/templates/hello-3d-world');
    fs.mkdirSync(template, { recursive: true });
    fs.writeFileSync(path.join(creator, 'CocosCreator.exe'), 'test executable placeholder');
    fs.writeFileSync(path.join(template, 'package.json'), JSON.stringify({ uuid: 'template-id', creator: { version: '3.8.8' } }));
    fs.writeFileSync(path.join(template, 'scene.scene'), 'fixture');
    const project = path.join(root, 'new-project');
    createSandbox({ projectPath: project, creatorPath: path.join(creator, 'CocosCreator.exe') });
    const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json')));
    assert.notEqual(pkg.uuid, 'template-id');
    assert.equal(fs.readFileSync(path.join(project, 'scene.scene'), 'utf8'), 'fixture');
    assert.throws(() => createSandbox({ projectPath: project, creatorPath: creator }), /already exists/);
    assert.equal(fs.readFileSync(path.join(project, 'scene.scene'), 'utf8'), 'fixture');
});

test('CLI routes stop and restart with the selected project and cancellation signal', async () => {
    const calls = [];
    const cli = cliHarness(Object.fromEntries(['stop', 'restart'].map((action) => [action, async (options) => {
        calls.push({ action, options });
        return { action };
    }])));
    const controller = new AbortController();
    for (const action of ['stop', 'restart']) await cli.main([action, '--project', '.'], { signal: controller.signal });
    assert.deepEqual(calls.map(({ action }) => action), ['stop', 'restart']);
    for (const { options } of calls) {
        assert.equal(options.projectPath, path.resolve('.'));
        assert.equal(options.signal, controller.signal);
    }
    assert.match(cli.output.stdout, /"action": "stop"/);
    assert.match(cli.output.stdout, /"action": "restart"/);
});

test('pre-cancelled CLI does not dispatch a command', async () => {
    let called = false;
    const cli = cliHarness({ run: async () => { called = true; } });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(cli.main(['run', '--project', '.'], { signal: controller.signal }), { name: 'AbortError', code: 'ABORT_ERR' });
    assert.equal(called, false);
    assert.equal(cli.output.stdout, '');
});

for (const event of ['SIGINT', 'SIGTERM']) {
    test(`CLI ${event} waits for cancellation cleanup and exits with 130`, async () => {
        let signal; let finish;
        const cli = cliHarness({ build: (options) => {
            signal = options.signal;
            return new Promise((resolve, reject) => { finish = reject; });
        } });
        let completed = false;
        const pending = cli.runCLI(['build', '--project', '.']).then(() => { completed = true; });
        cli.process.emit(event);
        cli.process.emit(event);
        assert.equal(signal.aborted, true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(completed, false);
        assert.equal(cli.process.listenerCount(event), 1);
        const error = new Error('stopped');
        error.name = 'AbortError'; error.code = 'ABORT_ERR';
        finish(error);
        await pending;
        assert.equal(cli.process.exitCode, 130);
        assert.equal(cli.process.listenerCount('SIGINT'), 0);
        assert.equal(cli.process.listenerCount('SIGTERM'), 0);
        assert.equal(cli.output.stdout, '');
        assert.equal(cli.output.stderr.match(/Cancelling/g).length, 1);
    });
}

test('CLI reports cleanup failures even after cancellation was requested', async () => {
    let fail;
    const cli = cliHarness({ build: () => new Promise((resolve, reject) => { fail = reject; }) });
    const pending = cli.runCLI(['build', '--project', '.']);
    cli.process.emit('SIGINT');
    fail(new Error('Owned process could not be stopped'));
    await pending;
    assert.equal(cli.process.exitCode, 1);
    assert.match(cli.output.stderr, /Owned process could not be stopped/);
    assert.equal(cli.process.listenerCount('SIGINT'), 0);
});
