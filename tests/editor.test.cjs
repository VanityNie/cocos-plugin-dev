'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function editorHarness(t, windows = {}, core = {}, editor = {}) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-plugin-ui-'));
    fs.writeFileSync(path.join(project, 'package.json'), '{}');
    t.after(() => fs.rmSync(project, { recursive: true, force: true }));
    const exports = {};
    const messages = [];
    vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
        exports, __dirname: root, process, console, AbortController,
        require: (id) => id === './lib/core.cjs' ? { listPlugins: () => [], ...core }
            : id === './lib/windows.cjs' ? windows : require(id),
        Editor: {
            Project: { path: project }, Panel: { open: async () => true },
            Package: { getPackages: () => [], register: () => {}, enable: () => {} },
            Message: { request: async (...args) => { messages.push(args); } },
            ...editor,
        },
    }, { filename: path.join(root, 'main.js') });
    return { methods: exports.methods, project, messages };
}

test('standalone editor defaults to the active engine and preserves explicit settings', async (t) => {
    let active;
    const { methods, project } = editorHarness(t, {}, {}, {
        Message: { request: async (pkg, message) => {
            assert.equal(pkg, 'engine');
            assert.equal(message, 'query-info');
            return active;
        } },
    });
    const engine = path.join(project, 'selected-engine');
    fs.mkdirSync(path.join(engine, 'native'), { recursive: true });
    fs.writeFileSync(path.join(engine, 'native/CMakeLists.txt'), '# fixture');
    active = { path: engine, nativePath: path.join(engine, 'native') };
    assert.equal((await methods.getContext()).settings.enginePath, engine);
    assert.equal(fs.existsSync(path.join(project, '.plugin-dev/ui-settings.json')), false);
    methods.saveSettings({ enginePath: 'E:/another-explicit-engine' });
    assert.equal((await methods.getContext()).settings.enginePath, 'E:/another-explicit-engine');
});

test('editor long tasks return immediately and prevent concurrent writes', async (t) => {
    let finish;
    const { methods } = editorHarness(t, { build: () => new Promise((resolve) => { finish = resolve; }) });
    const started = methods.startTask('build');
    assert.equal(started.status, 'running');
    assert.throws(() => methods.startTask('run'), /已有操作/);
    assert.throws(() => methods.saveSettings({ enginePath: 'different' }), /当前操作/);
    await nextTurn();
    finish({ built: true });
    await nextTurn();
    const done = methods.getTask(started.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result.built, true);
    assert.equal(methods.getTask(started.id, done.sequence).logs.length, 0);
});

test('cancelling keeps the operation lock until native cleanup settles and is idempotent', async (t) => {
    let settle;
    let signal;
    let abortEvents = 0;
    const { methods } = editorHarness(t, { build: (options) => {
        signal = options.signal;
        signal.addEventListener('abort', () => abortEvents++);
        return new Promise((resolve) => { settle = resolve; });
    } });
    const started = methods.startTask('build');
    assert.equal(started.canCancel, true);
    await nextTurn();
    assert.throws(() => methods.cancelTask('unknown'), /没有可取消/);
    const cancelling = methods.cancelTask(started.id);
    assert.equal(signal.aborted, true);
    assert.equal(cancelling.status, 'cancelling');
    assert.equal(cancelling.canCancel, false);
    assert.equal(methods.cancelTask(started.id).sequence, cancelling.sequence);
    assert.equal(abortEvents, 1);
    assert.throws(() => methods.startTask('run'), /已有操作/);
    assert.throws(() => methods.saveSettings({}), /当前操作/);
    settle({ built: true });
    await nextTurn();
    assert.equal(methods.getTask(started.id).status, 'cancelled');
    assert.equal(methods.getTask(started.id).error, undefined);
    assert.throws(() => methods.cancelTask(started.id), /没有可取消/);
    methods.saveSettings({});
});

test('cancellation cannot target another project or interrupt plugin file writes', async (t) => {
    let finish;
    const currentProject = { path: '' };
    const { methods, project } = editorHarness(t, { build: () => new Promise((resolve) => { finish = resolve; }) }, {
        syncPlugin: () => new Promise((resolve) => { finish = resolve; }),
    }, { Project: currentProject });
    currentProject.path = project;
    const build = methods.startTask('build');
    await nextTurn();
    const other = path.join(project, 'other-project');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'package.json'), '{}');
    currentProject.path = other;
    assert.throws(() => methods.cancelTask(build.id), /没有可取消/);
    currentProject.path = project;
    finish({});
    await nextTurn();
    const sync = methods.startTask('sync', { name: 'sample' });
    await nextTurn();
    assert.equal(sync.canCancel, false);
    assert.throws(() => methods.cancelTask(sync.id), /不支持取消/);
    finish({ name: 'sample' });
    await nextTurn();
    assert.equal(methods.getTask(sync.id).status, 'succeeded');
});

test('native cleanup failures remain failures after cancellation was requested', async (t) => {
    let fail;
    const { methods } = editorHarness(t, { build: () => new Promise((resolve, reject) => { fail = reject; }) });
    const task = methods.startTask('build');
    await nextTurn();
    methods.cancelTask(task.id);
    fail(new Error('Failed to terminate child process'));
    await nextTurn();
    assert.equal(methods.getTask(task.id).status, 'failed');
    assert.match(methods.getTask(task.id).error, /Failed to terminate/);
});

test('build-run does not launch after cancellation and disables cancellation during launch', async (t) => {
    let finishBuild;
    let finishRun;
    let runCount = 0;
    const { methods } = editorHarness(t, {
        build: () => new Promise((resolve) => { finishBuild = resolve; }),
        run: () => { runCount++; return new Promise((resolve) => { finishRun = resolve; }); },
    });
    const cancelled = methods.startTask('build-run');
    await nextTurn();
    methods.cancelTask(cancelled.id);
    finishBuild({ built: true });
    await nextTurn();
    assert.equal(methods.getTask(cancelled.id).status, 'cancelled');
    assert.equal(runCount, 0);

    const launched = methods.startTask('build-run');
    await nextTurn();
    finishBuild({ built: true });
    await nextTurn();
    assert.equal(runCount, 1);
    assert.equal(methods.getTask(launched.id).canCancel, false);
    assert.throws(() => methods.cancelTask(launched.id), /不支持取消/);
    finishRun({ pid: 123, alreadyRunning: false });
    await nextTurn();
    assert.equal(methods.getTask(launched.id).status, 'succeeded');
});

test('run, stop and restart preserve process results and do not claim duplicate launches', async (t) => {
    const calls = [];
    const { methods, project } = editorHarness(t, {
        run: async (options) => { calls.push(['run', options.projectPath]); return { pid: 123, alreadyRunning: true }; },
        stop: async (options) => { calls.push(['stop', options.projectPath]); return { stopped: false, reason: 'not-running' }; },
        restart: async (options) => { calls.push(['restart', options.projectPath]); return { pid: 456, restarted: true, alreadyRunning: false }; },
    });
    const run = methods.startTask('run');
    await nextTurn();
    assert.match(methods.getTask(run.id).logs.map((line) => line.text).join(''), /游戏已在运行，未启动新进程/);
    const stop = methods.startTask('stop');
    await nextTurn();
    assert.match(methods.getTask(stop.id).logs.map((line) => line.text).join(''), /没有由工作台管理/);
    const restart = methods.startTask('restart');
    await nextTurn();
    assert.equal(methods.getTask(restart.id).result.restarted, true);
    assert.deepEqual(calls, [['run', project], ['stop', project], ['restart', project]]);
});

test('editor differentiates tool attention from process failure', async (t) => {
    const { methods } = editorHarness(t, {
        doctor: async () => ({ ok: false, checks: [{ name: 'cmake', ok: false }] }),
        run: async () => { throw new Error('executable missing'); },
    });
    const doctor = methods.startTask('doctor');
    await nextTurn();
    assert.equal(methods.getTask(doctor.id).status, 'attention');
    const run = methods.startTask('run');
    await nextTurn();
    assert.equal(methods.getTask(run.id).status, 'failed');
    assert.match(methods.getTask(run.id).error, /executable missing/);
});

test('settings preserve unrelated values and cannot redirect the current project', (t) => {
    const { methods, project } = editorHarness(t);
    fs.mkdirSync(path.join(project, '.plugin-dev'));
    const file = path.join(project, '.plugin-dev', 'ui-settings.json');
    fs.writeFileSync(file, JSON.stringify({ custom: 'preserve', enginePath: 'old' }));
    methods.saveSettings({ enginePath: 'new', projectPath: 'another-project' });
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(settings.enginePath, 'new');
    assert.equal(settings.custom, 'preserve');
    assert.equal(settings.projectPath, undefined);
});

test('empty optional display name falls back to generator default and refreshes real asset API', async (t) => {
    let input;
    const { methods, messages } = editorHarness(t, {}, { createPlugin: (options) => { input = options; return { name: options.name, path: path.join(options.projectPath, 'extensions', options.name) }; } });
    const task = methods.startTask('create', { name: 'sample', displayName: '', template: 'native' });
    await nextTurn();
    assert.equal(input.displayName, undefined);
    assert.equal(methods.getTask(task.id).status, 'succeeded');
    assert.deepEqual(messages[0], ['sample', 'sync']);
    assert.deepEqual(messages[1], ['asset-db', 'refresh-asset', 'db://assets']);
});

test('in-editor prepare waits for official BUILD_SUCCESS and never starts a second Creator', async (t) => {
    const calls = [];
    let enginePath;
    const { methods, project } = editorHarness(t, {
        prepareHost: async (options) => options.prepareAssets({ projectPath: options.projectPath, enginePath: options.enginePath, buildConfig: { platform: 'windows', stage: 'build' } }),
    }, {}, { Message: { request: async (pkg, message, ...args) => {
        calls.push([pkg, message, ...args]);
        if (message === 'query-info') return { path: enginePath, nativePath: path.join(enginePath, 'native') };
        if (message === 'query-worker-ready') return true;
        if (message === 'add-task') return 36;
        throw new Error('Unexpected message');
    } } });
    enginePath = path.join(project, 'test-engine');
    fs.mkdirSync(path.join(enginePath, 'native'), { recursive: true });
    fs.writeFileSync(path.join(enginePath, 'native', 'CMakeLists.txt'), '');
    methods.saveSettings({ enginePath });
    const task = methods.startTask('prepare');
    await nextTurn();
    assert.equal(methods.getTask(task.id).status, 'succeeded');
    const build = calls.find((entry) => entry[1] === 'add-task');
    assert.equal(build[3], true);
    assert.equal(build[2].platform, 'windows');
    assert.equal(build[2].nextStages.length, 0);
});

test('in-editor engine mismatch is blocked before any builder call', async (t) => {
    let builderCalls = 0;
    const { methods, project } = editorHarness(t, {
        prepareHost: async (options) => options.prepareAssets({ projectPath: options.projectPath, enginePath: options.enginePath, buildConfig: {} }),
    }, {}, { Message: { request: async (pkg, message) => {
        if (pkg === 'builder') builderCalls++;
        if (message === 'query-info') return { path: 'C:/different-engine', nativePath: 'C:/different-engine/native' };
    } } });
    methods.saveSettings({ enginePath: project });
    const task = methods.startTask('prepare');
    await nextTurn();
    assert.equal(methods.getTask(task.id).status, 'failed');
    assert.match(methods.getTask(task.id).error, /引擎与工作台设置不一致/);
    assert.match(methods.getTask(task.id).error, /保存并关闭当前项目/);
    assert.equal(builderCalls, 0);
});

test('cancelling the editor asset stage waits for it before unlocking and blocks native work', async (t) => {
    let enginePath;
    let finishAssets;
    let nativeStarted = false;
    const { methods, project, messages } = editorHarness(t, {
        build: async (options) => {
            await options.prepareAssets({ projectPath: options.projectPath, enginePath: options.enginePath, buildConfig: { platform: 'windows' } });
            nativeStarted = true;
        },
    }, {}, { Message: { request: async (pkg, message) => {
        messages.push([pkg, message]);
        if (message === 'query-info') return { path: enginePath, nativePath: path.join(enginePath, 'native') };
        if (message === 'query-worker-ready') return true;
        if (message === 'add-task') return new Promise((resolve) => { finishAssets = resolve; });
        throw new Error(`Unexpected message ${message}`);
    } } });
    enginePath = path.join(project, 'engine');
    fs.mkdirSync(path.join(enginePath, 'native'), { recursive: true });
    fs.writeFileSync(path.join(enginePath, 'native/CMakeLists.txt'), '');
    methods.saveSettings({ enginePath });
    const task = methods.startTask('build');
    await nextTurn();
    assert.equal(methods.getTask(task.id).waitingForEditorBuild, true);
    const cancelling = methods.cancelTask(task.id);
    assert.equal(cancelling.status, 'cancelling');
    assert.match(cancelling.logs.at(-1).text, /等待 Creator 资源构建结束/);
    await nextTurn();
    assert.equal(methods.getTask(task.id).status, 'cancelling');
    assert.throws(() => methods.startTask('configure'), /已有操作/);
    assert.equal(messages.some((entry) => /cancel|break/.test(entry[1])), false);
    finishAssets(36);
    await nextTurn();
    assert.equal(methods.getTask(task.id).status, 'cancelled');
    assert.equal(nativeStarted, false);
    methods.saveSettings({});
});

// Development dependency only; the installed Creator extension needs no npm modules.
const { JSDOM } = require('jsdom');

test('panel uses safe text, sends create and unlocks only after task completion', async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'panels/default/index.html'), 'utf8'));
    const messages = [];
    const timers = [];
    const context = {
        projectPath: 'E:/test-game', settings: { enginePath: 'E:/engine', creatorPath: '', outputDir: 'E:/out' },
        plugins: [{ name: 'sample', displayName: '<script>unsafe</script>', template: 'native', enabled: true }], task: null,
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'panels/default/index.js'), 'utf8'), {
        module, require, __dirname: path.join(root, 'panels/default'),
        setTimeout: (callback) => { timers.push(callback); return timers.length; }, clearTimeout: () => {},
        Editor: {
            Panel: { define: (options) => options },
            Message: { request: async (pkg, message, ...args) => {
                messages.push([pkg, message, ...args]);
                if (message === 'get-context') return context;
                if (message === 'save-settings') return args[0];
                if (message === 'start-task') return { id: '1', action: args[0], status: 'running', sequence: 1, logs: [{ seq: 1, text: 'start\n' }] };
                if (message === 'get-task') return { id: '1', action: 'create', status: 'succeeded', sequence: 2, logs: [{ seq: 2, text: 'done\n' }] };
                throw new Error(`Unexpected message: ${message}`);
            } },
        },
    });
    const panel = { $: { app: dom.window.document.querySelector('#app') } };
    try {
        module.exports.ready.call(panel);
        await nextTurn();
        const query = (selector) => panel.$.app.querySelector(selector);
        assert.equal(query('.plugin-name').textContent, '<script>unsafe</script>');
        assert.equal(query('.plugin-name script'), null);
        assert.equal(query('#refresh-assets').checked, true);
        query('#plugin-name').value = 'hello-plugin';
        query('#create-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
        await nextTurn();
        assert.equal(query('[data-action="build"]').disabled, true);
        assert.equal(messages.find((entry) => entry[1] === 'start-task')[3].refreshAssets, true);
        await timers.shift()();
        assert.equal(query('[data-action="build"]').disabled, false);
        assert.match(query('#log').textContent, /done/);
    } finally {
        module.exports.close.call(panel);
        dom.window.close();
    }
});

test('panel cancellation stays locked across refresh until cancelled is confirmed', async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'panels/default/index.html'), 'utf8'));
    const timers = new Map();
    let nextTimer = 0;
    let cancelCalls = 0;
    let finishCancel;
    const context = {
        projectPath: 'E:/game', settings: {}, plugins: [],
        task: { id: '1', action: 'build', status: 'running', canCancel: true, sequence: 1, logs: [{ seq: 1, text: 'start\n' }] },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'panels/default/index.js'), 'utf8'), {
        module, require, __dirname: path.join(root, 'panels/default'),
        setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: (id) => { timers.delete(id); },
        Editor: {
            Panel: { define: (value) => value },
            Message: { request: async (pkg, message) => {
                if (message === 'get-context') return context;
                if (message === 'cancel-task') { cancelCalls++; return new Promise((resolve) => { finishCancel = resolve; }); }
                if (message === 'get-task') return context.task;
                throw new Error(`Unexpected message: ${message}`);
            } },
        },
    });
    const panel = { $: { app: dom.window.document.querySelector('#app') } };
    const query = (selector) => panel.$.app.querySelector(selector);
    try {
        module.exports.ready.call(panel);
        await nextTurn();
        assert.equal(query('#cancel-task').hidden, false);
        assert.equal(query('#cancel-task').disabled, false);
        query('#cancel-task').click();
        query('#cancel-task').dispatchEvent(new dom.window.Event('click'));
        assert.equal(cancelCalls, 1);
        assert.equal(query('#cancel-task').disabled, true);
        context.task = { ...context.task, status: 'cancelling', canCancel: false, waitingForEditorBuild: true, sequence: 2, logs: [...context.task.logs, { seq: 2, text: 'wait\n' }] };
        finishCancel(context.task);
        await nextTurn();
        assert.equal(query('[data-action="build"]').disabled, true);
        assert.match(query('#task-detail').textContent, /等待 Creator/);
        assert.equal(query('#log').textContent, 'start\nwait\n');
        query('#refresh').click();
        await nextTurn();
        assert.equal(query('#cancel-task').hidden, false);
        assert.equal(query('#cancel-task').disabled, true);
        assert.equal(query('[data-action="stop"]').disabled, true);
        context.task = { ...context.task, status: 'cancelled', sequence: 3, logs: [{ seq: 3, text: 'cancelled\n' }] };
        await timers.values().next().value();
        assert.equal(query('#cancel-task').hidden, true);
        assert.equal(query('[data-action="build"]').disabled, false);
        assert.equal(query('[data-action="restart"]').disabled, false);
        assert.match(query('#task-status').textContent, /已取消/);
    } finally {
        module.exports.close.call(panel);
        dom.window.close();
    }
});
