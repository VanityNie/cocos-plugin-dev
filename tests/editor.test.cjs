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
        exports, __dirname: root, process, console,
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
