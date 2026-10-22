'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const windows = require('../lib/windows.cjs');
const processes = require('../lib/processes.cjs');
const { _internal: internal } = windows;

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-plugin-windows-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = (name, value = '') => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); return p; };
    file('package.json', { name: 'game' }); fs.mkdirSync(path.join(root, 'assets'));
    return { root, file };
}

test('discovers both official Windows source names without touching an Android cache', (t) => {
    const { root, file } = fixture(t);
    file('native/engine/win64/CMakeLists.txt');
    file('native/engine/android/CMakeLists.txt');
    file('native/compile_commands.json', 'android');
    file('build/windows/proj/cfg.cmake');
    const host = internal.discoverHost(root);
    assert.equal(host.nativeSourceDir, path.join(root, 'native/engine/win64'));
    assert.equal(host.resourceDir, path.join(root, 'build/windows'));
    assert.equal(fs.readFileSync(path.join(root, 'native/compile_commands.json'), 'utf8'), 'android');
});

test('literal CMake engine path reader handles spaces and rejects unresolved variables', () => {
    assert.equal(internal.cmakeSet('set(COCOS_X_PATH "C:/My Engine/native" CACHE PATH "")', 'COCOS_X_PATH'), 'C:/My Engine/native');
    assert.equal(internal.cmakeSet('set(COCOS_X_PATH "${ROOT}/native")', 'COCOS_X_PATH'), null);
    assert.equal(internal.cmakeSet('set(OTHER x)', 'COCOS_X_PATH'), null);
});

test('normalizes engine root and native directory to the same root', (t) => {
    const { root, file } = fixture(t);
    file('engine/native/CMakeLists.txt');
    assert.equal(internal.normalizeEngine(path.join(root, 'engine')), path.join(root, 'engine'));
    assert.equal(internal.normalizeEngine(path.join(root, 'engine/native')), path.join(root, 'engine'));
    assert.throws(() => internal.normalizeEngine(path.join(root, 'assets')), /native\/CMakeLists/);
});

test('CMake invocation preserves paths as arguments instead of shell-quoting them', (t) => {
    const { root } = fixture(t);
    const state = { nativeSourceDir: path.join(root, 'game with spaces/native/engine/win64'), buildDir: path.join(root, '.plugin-dev/build/windows'), resourceDir: path.join(root, 'resource path'), enginePath: path.join(root, 'engine path'), tools: { ninja: path.join(root, 'ninja.exe'), node: process.execPath } };
    const args = internal.cmakeArguments(state, path.join(root, 'VC Tools/cl.exe'));
    assert.equal(args[1], state.nativeSourceDir);
    assert.ok(args.includes('-DCMAKE_EXPORT_COMPILE_COMMANDS:BOOL=ON'));
    assert.ok(args.includes('-DUSE_PLUGINS:BOOL=ON'));
    assert.ok(args.includes(`-DRES_DIR:PATH=${state.resourceDir.replace(/\\/g, '/')}`));
    assert.ok(args.every((arg) => !arg.startsWith('"')));
});

test('VsDevCmd bootstrap accepts spaces but rejects shell expansion and metacharacters', () => {
    const clean = path.resolve('Visual Studio (x86)', 'VsDevCmd.bat');
    assert.match(internal.vsBootstrapCommand(clean), /-arch=x64 -host_arch=x64/);
    for (const bad of ['bad&name', '%TEMP%', 'bad!name', 'bad|name', 'bad\nname', 'bad^name', 'bad"name']) {
        assert.throws(() => internal.vsBootstrapCommand(path.join(bad, 'VsDevCmd.bat')), /Unsafe/);
    }
    assert.throws(() => internal.vsBootstrapCommand('other.bat'), /Unsafe/);
});

test('environment capture handles equals signs and ignores drive pseudo-variables', () => {
    assert.deepEqual(internal.parseEnvironment('banner\r\n=C:=C:\\a\r\nPath=C:\\VS;C:\\SDK\r\nCUSTOM=a=b\r\n'), { Path: 'C:\\VS;C:\\SDK', CUSTOM: 'a=b' });
});

test('Creator only treats documented build exit 36 as success', async () => {
    assert.equal(internal.CREATOR_BUILD_SUCCESS, 36);
    const result = await internal.execute(process.execPath, ['-e', 'process.exit(36)'], { successCodes: [36] });
    assert.equal(result.code, 36);
    await assert.rejects(internal.execute(process.execPath, ['-e', 'process.exit(32)'], { successCodes: [36] }), /exit 32/);
    await assert.rejects(internal.execute(process.execPath, ['-e', 'process.exit(0)'], { successCodes: [36] }), /exit 0/);
});

test('native subprocess preserves special characters in arguments and reports errors', async () => {
    const value = 'a space & %test% ; $(echo nope)';
    const result = await internal.execute(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value]);
    assert.equal(result.output, value);
    await assert.rejects(internal.execute(process.execPath, ['-e', 'console.error("useful reason");process.exit(2)']), /useful reason/);
});

test('CMake File API discovers the game target rather than unrelated nested test tools', (t) => {
    const { root, file } = fixture(t);
    const prefix = 'build/.cmake/api/v1/reply/';
    file(`${prefix}index-01.json`, { reply: { 'codemodel-v2': { jsonFile: 'model.json' } } });
    file(`${prefix}model.json`, { configurations: [{ targets: [{ jsonFile: 'game.json' }, { jsonFile: 'tool.json' }] }] });
    file(`${prefix}game.json`, { type: 'EXECUTABLE', paths: { source: '.' }, artifacts: [{ path: 'Game.exe' }] });
    file(`${prefix}tool.json`, { type: 'EXECUTABLE', paths: { source: 'engine/tests' }, artifacts: [{ path: 'test.exe' }] });
    assert.equal(internal.fileApiExecutable(path.join(root, 'build')), path.join(root, 'build/Game.exe'));
});

test('workspace uses actual executable, a process task, native debugger and separate inspector', (t) => {
    const { root } = fixture(t);
    const state = { enginePath: path.join(root, 'engine'), executable: path.join(root, 'build/MyGame.exe'), buildDir: path.join(root, 'build'), creatorPath: path.join(root, 'Creator.exe'), tools: { clangd: path.join(root, 'clangd.exe') } };
    const ws = internal.workspaceData(state, root, 'cli.cjs', process.execPath, 6086);
    assert.equal(ws.launch.configurations[0].program, state.executable);
    assert.equal(ws.launch.configurations[0].type, 'cppvsdbg');
    assert.equal(ws.launch.configurations[1].port, 6086);
    assert.equal(ws.tasks.tasks[0].type, 'process');
    assert.ok(ws.tasks.tasks[0].args.includes('--project'));
    assert.ok(ws.settings['clangd.arguments'][0].includes('build'));
});

test('two host workspaces use shared original source and separate compile databases', t => {
    const { root, file } = fixture(t);
    const source = path.join(root, 'shared-plugin');
    file('shared-plugin/runtime/index.ts', 'export const shared = true;');
    file('shared-plugin/.clangd', 'User configuration');
    const plugins = [{ name: 'shared-plugin', sourceType: 'local', sourcePath: source }];
    for (const name of ['host-a', 'host-b']) {
        const project = path.join(root, name);
        const buildDir = path.join(project, '.plugin-dev/build/windows');
        const ws = internal.workspaceData({ buildDir }, project, 'cli.cjs', process.execPath, 6086, plugins);
        assert.equal(ws.folders.find(folder => folder.name === 'Plugin: shared-plugin').path, source);
        assert.equal(ws.settings['clangd.arguments'][0], `--compile-commands-dir=${buildDir.replace(/\\/g, '/')}`);
        const mirror = path.join(project, 'assets/__plugin_dev/shared-plugin/index.ts').replace(/\\/g, '/');
        const mapping = ws.launch.configurations[1].sourceMapPathOverrides;
        assert.equal(mapping[`*${mirror}`], path.join(source, 'runtime/index.ts').replace(/\\/g, '/'));
        assert.equal(Object.keys(mapping).some(key => key.endsWith('/plugin-enabled.ts')), false);
    }
    assert.equal(fs.readFileSync(path.join(source, '.clangd'), 'utf8'), 'User configuration');
});

test('detaching a plugin prevents running the old executable until assets and native build finish', async t => {
    const { root, file } = fixture(t);
    const executable = file('build/Game.exe', 'placeholder, must never launch');
    file('.plugin-dev/windows.json', { builtAt: 'previous', executable });
    const removed = { detached: true, enabled: false, needsRebuild: true, assetsDirty: true, tracked: {} };
    file('.plugin-dev/state.json', { schemaVersion: 1, plugins: { removed } });
    await assert.rejects(windows.run({ projectPath: root }), /Plugins changed.*removed/);
    internal.acknowledgePlugins(root, { removed }, 'assetsDirty');
    await assert.rejects(windows.run({ projectPath: root }), /Plugins changed.*removed/);
    internal.acknowledgePlugins(root, { removed }, 'needsRebuild', true);
    const records = JSON.parse(fs.readFileSync(path.join(root, '.plugin-dev/state.json'), 'utf8')).plugins;
    assert.equal(records.removed.needsRebuild, false);
    assert.equal(records.removed.assetsDirty, false);
});

test('debug workspace never changes the project .vscode or native compile database', async (t) => {
    const { root, file } = fixture(t);
    file('.vscode/launch.json', 'user debugging');
    file('native/compile_commands.json', 'android database');
    file('.plugin-dev/windows.json', { configuredAt: 'now', executable: path.join(root, 'build/MyGame.exe'), buildDir: path.join(root, 'build'), tools: { node: process.execPath } });
    const result = await windows.debugWorkspace({ projectPath: root });
    assert.equal(result.workspacePath, path.join(root, '.plugin-dev/plugin-dev.code-workspace'));
    assert.equal(fs.readFileSync(path.join(root, '.vscode/launch.json'), 'utf8'), 'user debugging');
    assert.equal(fs.readFileSync(path.join(root, 'native/compile_commands.json'), 'utf8'), 'android database');
    assert.ok(result.warnings.some((warning) => warning.includes('source maps')));
});

test('run and debugger do not guess an executable before a successful build/configure', async (t) => {
    const { root } = fixture(t);
    await assert.rejects(windows.run({ projectPath: root }), /Build the Windows host/);
    await assert.rejects(windows.debugWorkspace({ projectPath: root }), /Configure the Windows host/);
});

test('build acknowledgements preserve edits made while the compiler was running', (t) => {
    const { root, file } = fixture(t);
    const snapshot = { stable: { enabled: true, tracked: { 'a.ts': 'abc' }, nativeFingerprint: 'native1', needsRebuild: true }, edited: { enabled: true, tracked: { 'a.ts': 'abc' }, nativeFingerprint: 'native1', needsRebuild: true } };
    const current = JSON.parse(JSON.stringify(snapshot));
    current.edited.nativeFingerprint = 'native2';
    file('.plugin-dev/state.json', { schemaVersion: 1, plugins: current });
    internal.acknowledgePlugins(root, snapshot, 'needsRebuild', true);
    const result = JSON.parse(fs.readFileSync(path.join(root, '.plugin-dev/state.json'), 'utf8'));
    assert.equal(result.plugins.stable.needsRebuild, false);
    assert.equal(result.plugins.edited.needsRebuild, true);
});

test('build acknowledgements do not erase a source relocation or detach during the build', t => {
    const { root, file } = fixture(t);
    const record = { enabled: true, tracked: {}, nativeFingerprint: 'same-content', sourcePath: 'E:/plugins/old', needsRebuild: true };
    const snapshot = { moved: { ...record }, removed: { ...record } };
    file('.plugin-dev/state.json', { schemaVersion: 1, plugins: {
        moved: { ...record, sourcePath: 'E:/plugins/new' }, removed: { ...record, detached: true },
    } });
    internal.acknowledgePlugins(root, snapshot, 'needsRebuild', true);
    const records = JSON.parse(fs.readFileSync(path.join(root, '.plugin-dev/state.json'), 'utf8')).plugins;
    assert.equal(records.moved.needsRebuild, true);
    assert.equal(records.removed.needsRebuild, true);
});

test('MSVC encoding probe distinguishes UTF-8 and GBK localized include prefixes', () => {
    assert.equal(internal.detectOutputEncoding(Buffer.from('Note: including file: a.h'), 'Note: including file:'), 'utf-8');
    assert.equal(internal.detectOutputEncoding(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), '中文'), 'gbk');
    assert.throws(() => internal.detectOutputEncoding(Buffer.from('unrelated'), 'a required prefix'), /Cannot match MSVC/);
});

test('MSVC launcher converts streamed compiler output and preserves compiler status', async (t) => {
    const { file } = fixture(t);
    const launcher = file('launcher.cjs', internal.compilerLauncherSource());
    const result = await internal.execute(process.execPath, [launcher, 'gbk', process.execPath, '-e', 'process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))']);
    assert.equal(result.output, '中文');
    await assert.rejects(internal.execute(process.execPath, [launcher, 'gbk', process.execPath, '-e', 'process.exit(7)']), /exit 7/);
});

test('already cancelled subprocess never launches or creates a log', async (t) => {
    const { root } = fixture(t);
    const sentinel = path.join(root, 'launched');
    const logPath = path.join(root, 'log.txt');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(internal.execute(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "spawned")', sentinel], { signal: controller.signal, logPath }), { name: 'AbortError', code: 'ABORT_ERR' });
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal(fs.existsSync(logPath), false);
});

test('Windows operations reject an already cancelled signal before touching project state', async (t) => {
    const { root } = fixture(t);
    const controller = new AbortController(); controller.abort();
    for (const operation of [windows.doctor, windows.prepareHost, windows.configure, windows.build, windows.run, windows.stop, windows.restart, windows.debugWorkspace]) {
        await assert.rejects(operation({ projectPath: root, signal: controller.signal }), { name: 'AbortError', code: 'ABORT_ERR' });
    }
    assert.equal(fs.existsSync(path.join(root, '.plugin-dev')), false);
});

test('cancelling a native task waits for its real child and grandchild to exit before releasing the project lock', { timeout: 40000 }, async (t) => {
    const { root } = fixture(t);
    const pidFile = path.join(root, 'children.json');
    const controller = new AbortController();
    let reportedReady = false;
    const timeout = setTimeout(() => controller.abort(), 15000);
    t.after(() => clearTimeout(timeout));
    const script = 'const cp=require("child_process");const fs=require("fs");const c=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:c.pid}));console.log("READY");setInterval(()=>{},1000);';
    const operation = processes.withLock(root, () => internal.execute(process.execPath, ['-e', script, pidFile], {
        signal: controller.signal,
        onOutput: (text) => { if (text.includes('READY')) { reportedReady = true; controller.abort(); } },
    }), { signal: controller.signal });
    await assert.rejects(operation, { name: 'AbortError', code: 'ABORT_ERR' });
    assert.equal(reportedReady, true);
    const children = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(await processes.inspect(children.parent), null);
    assert.equal(await processes.inspect(children.child), null);
    assert.equal(fs.existsSync(path.join(root, '.plugin-dev/windows-operation.lock')), false);
});

test('editor asset preparation finishes before cancellation is acknowledged', async () => {
    const controller = new AbortController();
    let finish;
    let settled = false;
    const result = internal.waitForAssets(({ signal }) => {
        assert.equal(signal, controller.signal);
        return new Promise((resolve) => { finish = resolve; });
    }, { projectPath: 'test' }, controller.signal);
    result.then(() => { settled = true; }, () => { settled = true; });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    finish({ enginePath: 'engine' });
    await assert.rejects(result, { name: 'AbortError', code: 'ABORT_ERR' });
});

test('editor asset preparation failures are not hidden by a concurrent cancellation', async () => {
    const controller = new AbortController();
    await assert.rejects(internal.waitForAssets(async () => { controller.abort(); throw new Error('Builder worker failed'); }, {}, controller.signal), /Builder worker failed/);
});

test('restart refuses an unbuilt host before stopping the existing owned game', { timeout: 15000 }, async (t) => {
    const { root, file } = fixture(t);
    const started = await processes.withLock(root, () => processes.startUnlocked(root, process.execPath, { args: ['-e', 'setInterval(()=>{},1000)'] }));
    try {
        file('.plugin-dev/windows.json', { executable: process.execPath });
        await assert.rejects(windows.restart({ projectPath: root }), /Build the Windows host/);
        assert.equal((await processes.inspect(started.pid)).pid, started.pid);
    } finally { await windows.stop({ projectPath: root }); }
});
