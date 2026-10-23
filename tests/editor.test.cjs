'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function editorHarness(t, windows = {}, core = {}, editor = {}, electron = {}) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-plugin-ui-'));
    fs.writeFileSync(path.join(project, 'package.json'), '{}');
    fs.mkdirSync(path.join(project, 'assets'));
    t.after(() => fs.rmSync(project, { recursive: true, force: true }));
    const exports = {};
    const messages = [];
    vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
        exports, __dirname: root, process, console, AbortController,
        require: (id) => id === './lib/core.cjs' ? { listPlugins: () => [], ...core }
            : id === './lib/windows.cjs' ? windows : id === 'electron' ? electron : require(id),
        Editor: {
            Project: { path: project }, Panel: { open: async () => true },
            Package: { getPackages: () => [], register: () => {}, enable: () => {}, disable: () => {}, unregister: () => {} },
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
    methods.saveSettings({ enginePath: 'new', buildType: 'RelWithDebInfo', projectPath: 'another-project' });
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(settings.enginePath, 'new');
    assert.equal(settings.buildType, 'RelWithDebInfo');
    assert.equal(settings.custom, 'preserve');
    assert.equal(settings.projectPath, undefined);
});

test('empty optional display name falls back to generator default and refreshes real asset API', async (t) => {
    let input;
    const { methods, messages } = editorHarness(t, {}, { createPlugin: (options) => { input = options; return { name: options.name, extensionPath: path.join(options.projectPath, 'extensions', options.name) }; } });
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

function hostFixture(parent, name) {
    const host = path.join(parent, name);
    fs.mkdirSync(path.join(host, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(host, 'package.json'), '{}');
    return host;
}

test('host selection scopes settings, tasks and prepare callbacks to the selected game', async (t) => {
    const calls = [];
    let finish;
    const { methods, project } = editorHarness(t, {
        prepareHost: async (options) => { calls.push(options); return { projectPath: options.projectPath }; },
        build: () => new Promise((resolve) => { finish = resolve; }),
    });
    methods.saveSettings({ enginePath: 'current-engine' });
    const other = hostFixture(project, 'other');
    const selected = await methods.selectHost(other);
    assert.equal(selected.projectPath, other);
    assert.equal(selected.editorProjectPath, project);
    assert.equal(selected.isEditorHost, false);
    assert.equal(selected.engineError, null);
    assert.equal(selected.settings.enginePath, '');
    methods.saveSettings({ enginePath: 'other-engine', outputDir: path.join(other, 'exports') });
    const task = methods.startTask('prepare');
    await nextTurn();
    assert.equal(calls[0].projectPath, other);
    assert.equal(calls[0].enginePath, 'other-engine');
    assert.equal(calls[0].prepareAssets, undefined);
    assert.match(methods.getTask(task.id).logs.map((line) => line.text).join(''), /关闭该宿主/);
    assert.equal((await methods.selectHost(project)).settings.enginePath, 'current-engine');
    assert.throws(() => methods.getTask(task.id), /任务已失效/);
    const currentTask = methods.startTask('prepare');
    await nextTurn();
    assert.equal(typeof calls[1].prepareAssets, 'function');
    assert.equal(methods.getTask(currentTask.id).projectPath, project);
    const build = methods.startTask('build');
    await nextTurn();
    await assert.rejects(methods.selectHost(other), /当前操作完成后/);
    finish({});
    await nextTurn();
    assert.equal(methods.getTask(build.id).status, 'succeeded');
    assert.equal((await methods.selectHost(other)).settings.outputDir, path.join(other, 'exports'));
});

test('invalid hosts and broken host manifests do not replace the selected host', async (t) => {
    let broken;
    const { methods, project } = editorHarness(t, {}, {
        listPlugins: ({ projectPath }) => { if (projectPath === broken) throw new Error('Invalid plugin manifest'); return []; },
    });
    await assert.rejects(methods.selectHost(path.join(project, 'missing')), /Creator 项目/);
    broken = hostFixture(project, 'broken');
    await assert.rejects(methods.selectHost(broken), /Invalid plugin manifest/);
    assert.equal((await methods.getContext()).projectPath, project);
});

test('context requests explicit reference diagnostics and unlink never resolves missing source', async (t) => {
    let row;
    const { methods, project } = editorHarness(t, {}, {
        listPlugins: (options) => {
            if (!options.includeErrors) throw new Error('Missing source');
            return [row];
        },
        unlinkPlugin: (options) => ({ name: options.name, detached: true }),
    });
    row = {
        name: 'missing', sourceType: 'local', enabled: true,
        sourcePath: path.join(project, 'missing'), pluginPath: path.join(project, 'missing'),
        extensionPath: path.join(project, 'extensions/missing'), error: 'Missing source: plugin-dev.json',
    };
    assert.equal((await methods.getContext()).plugins[0].error, row.error);
    const task = methods.startTask('unlink', { name: 'missing' });
    await nextTurn();
    assert.equal(methods.getTask(task.id).status, 'succeeded');
});

test('current host registers the adapter and opens the canonical independent source', async (t) => {
    const packageCalls = [];
    const opened = [];
    let plugin;
    let input;
    const { methods, project, messages } = editorHarness(t, {}, {
        linkPlugin: (options) => { input = options; return plugin; },
        listPlugins: () => [plugin],
    }, {
        Package: {
            getPackages: () => [],
            register: (folder) => packageCalls.push(['register', folder]),
            enable: (folder) => packageCalls.push(['enable', folder]),
        },
    }, { shell: { openPath: async (folder) => { opened.push(folder); return ''; } } });
    const source = path.join(project, 'source');
    fs.mkdirSync(source);
    const adapter = path.join(project, 'extensions/sample');
    plugin = { name: 'sample', sourceType: 'local', pluginPath: source, sourcePath: source, extensionPath: adapter };
    const task = methods.startTask('link', { sourcePath: source });
    await nextTurn();
    assert.equal(methods.getTask(task.id).status, 'succeeded');
    assert.equal(input.projectPath, project);
    assert.equal(input.sourcePath, source);
    assert.deepEqual(packageCalls, [['register', adapter], ['enable', adapter]]);
    assert.deepEqual(messages, [['sample', 'sync'], ['asset-db', 'refresh-asset', 'db://assets']]);
    await methods.openSource('sample');
    assert.deepEqual(opened, [source]);
});

test('foreign host link, sync and enable never touch the open editor package or asset database', async (t) => {
    const calls = [];
    const { methods, project, messages } = editorHarness(t, {}, {
        linkPlugin: (options) => { calls.push(['link', options.projectPath]); return { name: 'sample' }; },
        syncPlugin: (options) => { calls.push(['sync', options.projectPath]); return {}; },
        setEnabled: (options) => { calls.push(['enable', options.projectPath]); return {}; },
    }, { Package: { getPackages: () => { throw new Error('Foreign package access'); } } });
    const other = hostFixture(project, 'foreign');
    await methods.selectHost(other);
    for (const action of ['link', 'sync', 'enable']) {
        const task = methods.startTask(action, { name: 'sample', sourcePath: 'E:/source', enabled: false });
        await nextTurn();
        assert.equal(methods.getTask(task.id).status, 'succeeded');
    }
    assert.deepEqual(calls, [['link', other], ['sync', other], ['enable', other]]);
    assert.deepEqual(messages, []);
});

test('engine query and asset refresh errors remain visible and refresh failure fails the task', async (t) => {
    const { methods } = editorHarness(t, {}, { syncPlugin: () => ({ changed: true }) }, {
        Message: { request: async (pkg) => { throw new Error(`${pkg} unavailable`); } },
    });
    assert.match((await methods.getContext()).engineError, /engine unavailable/);
    const task = methods.startTask('sync', { name: 'sample' });
    await nextTurn();
    assert.equal(methods.getTask(task.id).status, 'failed');
    assert.match(methods.getTask(task.id).error, /文件已写入.*asset-db unavailable/);
});

test('adapter activation failure reports created files and never claims a successful creation', async (t) => {
    let options;
    const { methods } = editorHarness(t, {}, {
        createPlugin: (value) => { options = value; return { name: 'sample', extensionPath: 'E:/host/extensions/sample' }; },
    }, { Package: { getPackages: () => [], register: () => { throw new Error('register failed'); } } });
    const task = methods.startTask('create', { name: 'sample', pluginPath: 'E:/source/sample' });
    await nextTurn();
    assert.equal(options.pluginPath, 'E:/source/sample');
    assert.equal(methods.getTask(task.id).status, 'failed');
    assert.match(methods.getTask(task.id).error, /文件已写入.*register failed/);
});

test('unlink stops the loaded adapter before removal and restores it when the core operation fails', async (t) => {
    const calls = [];
    let plugin;
    let fail = true;
    const { methods, project } = editorHarness(t, {}, {
        listPlugins: () => [plugin],
        unlinkPlugin: () => { calls.push('unlink'); if (fail) throw new Error('Source conflict'); return { name: 'sample', detached: true }; },
    }, { Package: {
        getPackages: () => [{}],
        disable: () => calls.push('disable'), enable: () => calls.push('enable'), unregister: () => calls.push('unregister'),
    } });
    const adapter = path.join(project, 'extensions/sample');
    fs.mkdirSync(adapter, { recursive: true });
    plugin = { name: 'sample', sourceType: 'local', extensionPath: adapter };
    const failed = methods.startTask('unlink', { name: 'sample' });
    await nextTurn();
    assert.equal(methods.getTask(failed.id).status, 'failed');
    assert.match(methods.getTask(failed.id).error, /Source conflict/);
    assert.deepEqual(calls, ['disable', 'unlink', 'enable']);
    calls.length = 0;
    fail = false;
    const succeeded = methods.startTask('unlink', { name: 'sample' });
    await nextTurn();
    assert.equal(methods.getTask(succeeded.id).status, 'succeeded');
    assert.deepEqual(calls, ['disable', 'unlink', 'unregister']);
});

test('directory picker uses the public directory contract and cancellation leaves inputs unchanged', async (t) => {
    const calls = [];
    let cancelled = false;
    const { methods, project } = editorHarness(t, {}, {}, { Dialog: { select: async (options) => {
        calls.push(options);
        return { canceled: cancelled, filePaths: cancelled ? [] : ['E:/plugins'] };
    } } });
    assert.equal(await methods.chooseDirectory(project), 'E:/plugins');
    assert.equal(calls[0].type, 'directory');
    assert.equal(calls[0].multi, false);
    assert.equal(calls[0].path, project);
    cancelled = true;
    assert.equal(await methods.chooseDirectory(project), null);
});

// Development dependency only; the installed Creator extension needs no npm modules.
const { JSDOM } = require('jsdom');

test('panel uses safe text, sends create and unlocks only after task completion', async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'panels/default/index.html'), 'utf8'));
    const messages = [];
    const timers = [];
    const context = {
        projectPath: 'E:/test-game', editorProjectPath: 'E:/test-game', isEditorHost: true, settings: { enginePath: 'E:/engine', creatorPath: '', outputDir: 'E:/out' },
        plugins: [{ name: 'sample', displayName: '<script>unsafe</script>', template: 'native', enabled: true, sourceType: 'local', pluginPath: 'E:/plugins/sample' }], task: null,
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
        assert.equal(query('#host-details').open, false);
        assert.equal(query('#create-details').open, false);
        assert.match(query('#create-summary-note').textContent, /已关联 1 个/);
        assert.equal(query('#refresh-assets').checked, true);
        query('#plugin-name').value = 'hello-plugin';
        query('#plugin-path').value = 'E:/plugins/hello-plugin';
        query('#create-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
        await nextTurn();
        assert.equal(query('[data-action="build"]').disabled, true);
        assert.equal(messages.find((entry) => entry[1] === 'start-task')[3].refreshAssets, true);
        assert.equal(messages.find((entry) => entry[1] === 'start-task')[3].pluginPath, 'E:/plugins/hello-plugin');
        assert.match(query('.plugin-source').textContent, /E:\/plugins\/sample/);
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
        projectPath: 'E:/game', editorProjectPath: 'E:/game', isEditorHost: true, settings: {}, plugins: [],
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

test('panel host selection replaces per-host settings and exposes link/unlink source actions', async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'panels/default/index.html'), 'utf8'));
    const requests = [];
    const timers = [];
    let context = {
        projectPath: 'E:/open-game', editorProjectPath: 'E:/open-game', isEditorHost: true,
        settings: { enginePath: 'E:/open-engine', outputDir: 'E:/open-game/exports' },
        engineError: null, plugins: [], task: null,
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'panels/default/index.js'), 'utf8'), {
        module, require, __dirname: path.join(root, 'panels/default'),
        setTimeout: (callback) => { timers.push(callback); return timers.length; }, clearTimeout: () => {},
        Editor: { Panel: { define: (options) => options }, Message: { request: async (pkg, message, ...args) => {
            requests.push([message, ...args]);
            if (message === 'get-context') return context;
            if (message === 'select-host') {
                context = {
                    ...context, projectPath: args[0], isEditorHost: false,
                    settings: { enginePath: 'E:/other-engine', outputDir: 'E:/other-game/exports' },
                    plugins: [{ name: 'sample', sourceType: 'local', pluginPath: 'E:/plugins/sample', enabled: true, template: 'native' }],
                };
                return context;
            }
            if (message === 'save-settings') return args[0];
            if (message === 'start-task') return { id: 'task', action: args[0], status: 'running', sequence: 1, logs: [] };
            if (message === 'get-task') return { id: 'task', action: 'link', status: 'succeeded', sequence: 2, logs: [] };
            if (message === 'choose-directory') return 'E:/plugins/sample';
            throw new Error(`Unexpected message ${message}`);
        } } },
    });
    const panel = { $: { app: dom.window.document.querySelector('#app') } };
    const query = (selector) => panel.$.app.querySelector(selector);
    try {
        module.exports.ready.call(panel);
        await nextTurn();
        assert.equal(query('#host-details').open, false);
        assert.equal(query('#create-details').open, true);
        assert.equal(query('#host-mode-badge').textContent, '当前项目');
        query('#toggle-host').click();
        assert.equal(query('#host-details').open, true);
        query('#host-path').value = 'E:/other-game';
        query('#host-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
        await nextTurn();
        assert.equal(query('#host-details').open, true);
        assert.equal(query('#create-details').open, false);
        assert.equal(query('#host-mode-badge').textContent, '外部宿主');
        assert.equal(query('#editor-project-path').textContent, 'E:/open-game');
        assert.equal(query('#project-path').textContent, 'E:/other-game');
        assert.equal(query('#engine-path').value, 'E:/other-engine');
        assert.equal(query('#output-dir').value, 'E:/other-game/exports');
        assert.match(query('#host-note').textContent, /关闭该宿主/);
        assert.match(query('.plugin-source').textContent, /独立源码：E:\/plugins\/sample/);
        assert.ok(Array.from(panel.$.app.querySelectorAll('.plugin-actions button')).some((button) => button.textContent === '解除引用'));
        query('#browse-source').click();
        await nextTurn();
        assert.equal(query('#source-path').value, 'E:/plugins/sample');
        query('#link-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
        await nextTurn();
        const startRequest = requests.find((entry) => entry[0] === 'start-task');
        assert.equal(startRequest[1], 'link');
        assert.equal(startRequest[2].sourcePath, 'E:/plugins/sample');
        assert.equal(query('#host-path').disabled, true);
        assert.equal(query('#use-editor-host').disabled, true);
        await timers.shift()();
        assert.equal(query('#host-path').disabled, false);
    } finally {
        module.exports.close.call(panel);
        dom.window.close();
    }
});

test('panel requires an independent source path and displays engine discovery errors', async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'panels/default/index.html'), 'utf8'));
    const requests = [];
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'panels/default/index.js'), 'utf8'), {
        module, require, __dirname: path.join(root, 'panels/default'), setTimeout: () => 1, clearTimeout: () => {},
        Editor: { Panel: { define: (options) => options }, Message: { request: async (pkg, message, ...args) => {
            requests.push([message, ...args]);
            if (message === 'get-context') return {
                projectPath: 'E:/game', editorProjectPath: 'E:/game', isEditorHost: true,
                settings: {}, plugins: [], task: null, engineError: 'Engine API unavailable',
            };
            if (message === 'save-settings') return args[0];
            if (message === 'start-task') return { id: '1', action: 'create', status: 'running', logs: [], sequence: 0 };
            throw new Error(`Unexpected message ${message}`);
        } } },
    });
    const panel = { $: { app: dom.window.document.querySelector('#app') } };
    const query = (selector) => panel.$.app.querySelector(selector);
    try {
        module.exports.ready.call(panel);
        await nextTurn();
        assert.equal(query('#engine-error').hidden, false);
        assert.match(query('#engine-error').textContent, /Engine API unavailable/);
        query('#plugin-name').value = 'sample';
        query('#create-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
        await nextTurn();
        assert.equal(requests.some((entry) => entry[0] === 'start-task'), false);
        assert.match(query('#notice').textContent, /新建目录/);
        query('#plugin-location').value = 'embedded';
        query('#plugin-location').dispatchEvent(new dom.window.Event('change'));
        assert.equal(query('#plugin-path').required, false);
        query('#create-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
        await nextTurn();
        assert.equal(requests.find((entry) => entry[0] === 'start-task')[2].pluginPath, undefined);
    } finally {
        module.exports.close.call(panel);
        dom.window.close();
    }
});

test('invalid reference rows preserve the diagnostic and offer only unlink', async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'panels/default/index.html'), 'utf8'));
    const requests = [];
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'panels/default/index.js'), 'utf8'), {
        module, require, __dirname: path.join(root, 'panels/default'), setTimeout: () => 1, clearTimeout: () => {},
        Editor: { Panel: { define: (options) => options }, Message: { request: async (pkg, message, ...args) => {
            requests.push([message, ...args]);
            if (message === 'get-context') return {
                projectPath: 'E:/game', editorProjectPath: 'E:/game', isEditorHost: true, settings: {}, task: null,
                plugins: [{ name: 'missing', pluginPath: 'E:/missing', sourceType: 'local', enabled: true, error: 'Source not found: E:/missing/plugin-dev.json' }],
            };
            if (message === 'save-settings') return args[0];
            if (message === 'start-task') return { id: '1', action: args[0], status: 'running', logs: [], sequence: 0 };
            throw new Error(`Unexpected message ${message}`);
        } } },
    });
    const panel = { $: { app: dom.window.document.querySelector('#app') } };
    try {
        module.exports.ready.call(panel);
        await nextTurn();
        assert.equal(panel.$.app.querySelector('.plugin-error').textContent, '开发引用无效：Source not found: E:/missing/plugin-dev.json');
        assert.equal(panel.$.app.querySelector('.plugin .enabled'), null);
        const buttons = panel.$.app.querySelectorAll('.plugin-actions button');
        assert.equal(buttons.length, 1);
        assert.equal(buttons[0].textContent, '解除引用');
        buttons[0].click();
        await nextTurn();
        const start = requests.find((entry) => entry[0] === 'start-task');
        assert.equal(start[1], 'unlink');
        assert.equal(start[2].name, 'missing');
    } finally {
        module.exports.close.call(panel);
        dom.window.close();
    }
});

test('panel package task ignores saved buildType and exports source package cleanly', async (t) => {
    const realCore = require('../lib/core.cjs');
    let packagePromise;
    let receivedOptions;
    const { methods, project } = editorHarness(t, {}, {
        ...realCore,
        packagePlugin: (options) => {
            receivedOptions = options;
            packagePromise = realCore.packagePlugin(options);
            return packagePromise;
        },
    });
    methods.saveSettings({ buildType: 'RelWithDebInfo' });
    realCore.createPlugin({ projectPath: project, name: 'panel-pkg' });
    const started = methods.startTask('package', { name: 'panel-pkg' });
    await nextTurn();
    await packagePromise;
    await nextTurn();
    const done = methods.getTask(started.id);
    assert.equal(receivedOptions.buildType, undefined);
    assert.equal(receivedOptions.binary, false);
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(done.result.binary, false);
    assert.ok(fs.existsSync(done.result.zipPath));
});
