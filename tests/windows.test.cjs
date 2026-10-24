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
    const file = (name, value = '') => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); return p; };
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

test('compiler log decoder handles UTF-8 and localized linker lines split across chunks', () => {
    let output = '';
    const decoder = internal.outputDecoder('gbk', text => { output += text; });
    const bytes = Buffer.concat([
        Buffer.from('构建 [1/2]\n', 'utf8'),
        Buffer.from([0xce, 0xde, 0xb7, 0xa8]), // 无法 (CP936)
        Buffer.from(' LNK2019\r\n'),
        Buffer.from('完成', 'utf8'),
    ]);
    for (const byte of bytes) decoder.write(Buffer.from([byte]));
    decoder.end();
    assert.equal(output, '构建 [1/2]\n无法 LNK2019\r\n完成');
    let environment = '';
    const unicode = internal.outputDecoder(undefined, text => { environment += text; }, 'utf-16le');
    const bytes16 = Buffer.from('Path=C:\\开发工具\r\n', 'utf16le');
    for (const byte of bytes16) unicode.write(Buffer.from([byte]));
    unicode.end();
    assert.equal(environment, 'Path=C:\\开发工具\r\n');
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
    const state = { configuredAt: 'now', builtAt: 'now', enginePath: path.join(root, 'engine'), executable: path.join(root, 'build/MyGame.exe'), buildDir: path.join(root, 'build'), creatorPath: path.join(root, 'Creator.exe'), tools: { clangd: path.join(root, 'clangd.exe') } };
    const ws = internal.workspaceData(state, root, 'cli.cjs', process.execPath, 6086);
    assert.equal(ws.launch.configurations[0].program, state.executable);
    assert.equal(ws.launch.configurations[0].type, 'cppvsdbg');
    assert.equal(ws.launch.configurations[0].preLaunchTask, undefined);
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
        const ws = internal.workspaceData({ buildDir, configuredAt: 'now', builtAt: 'now', executable: path.join(buildDir, 'Game.exe') }, project, 'cli.cjs', process.execPath, 6086, plugins);
        assert.equal(ws.folders.find(folder => folder.name === 'Plugin: shared-plugin').path, source);
        assert.equal(ws.settings['clangd.arguments'][0], `--compile-commands-dir=${buildDir.replace(/\\/g, '/')}`);
        const mirror = path.join(project, 'assets/__plugin_dev/shared-plugin/index.ts').replace(/\\/g, '/');
        const mapping = ws.launch.configurations[1].sourceMapPathOverrides;
        assert.equal(mapping[`*${mirror}`], path.join(source, 'runtime/index.ts').replace(/\\/g, '/'));
        assert.equal(Object.keys(mapping).some(key => key.endsWith('/plugin-enabled.ts')), false);
    }
    assert.equal(fs.readFileSync(path.join(source, '.clangd'), 'utf8'), 'User configuration');
});

test('running host debugging attaches both languages without launching a second game', t => {
    const { root } = fixture(t);
    const state = { configuredAt: 'now', builtAt: 'now', executable: path.join(root, 'Game.exe'), runningPid: 12345 };
    const ws = internal.workspaceData(state, root, 'cli.cjs', null, 6087);
    assert.equal(ws.launch.configurations[0].request, 'attach');
    assert.equal(ws.launch.configurations[0].processId, '12345');
    assert.equal(ws.launch.configurations.find(item => item.type === 'pwa-node').port, 6087);
    assert.ok(ws.launch.compounds[0].configurations.every(name => name.includes('attach')));
    assert.equal(ws.tasks.tasks.length, 0);
    assert.ok(ws.launch.configurations.every(item => !item.preLaunchTask));
    assert.ok(ws.launch.configurations.every(item => item.request === 'attach'));
});

test('starting a host refreshes an existing workspace to attach to that same process', async t => {
    const { root, file } = fixture(t);
    const executable = file('build/Game.exe', 'test fixture; never executed');
    file('.plugin-dev/windows.json', { configuredAt: 'now', builtAt: 'now', executable,
        buildType: 'Debug', tools: { node: process.execPath } });
    const originalStart = processes.startUnlocked;
    const originalRecorded = processes.recorded;
    let started = false;
    const logPath = file('.plugin-dev/logs/game.log', 'Debugger listening on ws://127.0.0.1:6089/test\n');
    processes.startUnlocked = async () => { started = true; return { pid: 12345, logPath }; };
    processes.recorded = async () => started ? { identity: { pid: 12345 }, logPath } : null;
    t.after(() => { processes.startUnlocked = originalStart; processes.recorded = originalRecorded; });
    await windows.debugWorkspace({ projectPath: root });
    const workspacePath = path.join(root, '.plugin-dev/plugin-dev.code-workspace');
    assert.equal(JSON.parse(fs.readFileSync(workspacePath)).launch.configurations[0].request, 'launch');
    await windows.run({ projectPath: root });
    const workspace = JSON.parse(fs.readFileSync(workspacePath));
    assert.equal(workspace.launch.configurations[0].processId, '12345');
    assert.ok(workspace.launch.configurations.every(item => item.request === 'attach'));
    assert.equal(workspace.launch.configurations.find(item => item.type === 'pwa-node').port, 6089);
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
    file('.plugin-dev/windows.json', { configuredAt: 'now', builtAt: 'now', executable: file('build/MyGame.exe', 'fixture'), buildDir: path.join(root, 'build'), tools: { node: process.execPath } });
    const result = await windows.debugWorkspace({ projectPath: root });
    assert.equal(result.workspacePath, path.join(root, '.plugin-dev/plugin-dev.code-workspace'));
    assert.equal(fs.readFileSync(path.join(root, '.vscode/launch.json'), 'utf8'), 'user debugging');
    assert.equal(fs.readFileSync(path.join(root, 'native/compile_commands.json'), 'utf8'), 'android database');
    assert.ok(result.warnings.some((warning) => warning.includes('source maps')));
});

test('unbuilt hosts open a development workspace without guessed executables', async (t) => {
    const { root } = fixture(t);
    await assert.rejects(windows.run({ projectPath: root }), /Build the Windows host/);
    const result = await windows.debugWorkspace({ projectPath: root });
    assert.equal(result.nativeReady, false);
    const workspace = JSON.parse(fs.readFileSync(result.workspacePath, 'utf8'));
    assert.deepEqual(workspace.launch.configurations, []);
    assert.deepEqual(workspace.launch.compounds, []);
    assert.ok(result.warnings.some(text => text.includes('自动准备')));
    assert.equal(fs.existsSync(path.join(root, '.plugin-dev/windows.json')), false);
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

test('CMake and workspace support Debug, RelWithDebInfo and Release configurations', (t) => {
    const { root } = fixture(t);
    assert.equal(internal.normalizeBuildType('debug'), 'Debug');
    assert.equal(internal.normalizeBuildType('RelWithDebInfo'), 'RelWithDebInfo');
    assert.equal(internal.normalizeBuildType('RELEASE'), 'Release');
    assert.equal(internal.normalizeBuildType(''), null);
    assert.throws(() => internal.normalizeBuildType(' Shipping '), /Unsupported buildType/);

    const baseState = {
        nativeSourceDir: path.join(root, 'native/engine/win64'),
        buildDir: path.join(root, '.plugin-dev/build/windows'),
        resourceDir: path.join(root, 'build/windows-plugin-dev'),
        enginePath: path.join(root, 'engine'),
        tools: { ninja: path.join(root, 'ninja.exe'), node: process.execPath },
    };
    for (const buildType of ['Debug', 'RelWithDebInfo', 'Release']) {
        const args = internal.cmakeArguments({ ...baseState, buildType }, path.join(root, 'cl.exe'));
        assert.ok(args.includes(`-DCMAKE_BUILD_TYPE:STRING=${buildType}`));
        const ws = internal.workspaceData({ ...baseState, buildType }, root, 'cli.cjs', process.execPath, 6086);
        assert.ok(ws.tasks.tasks[0].args.includes('--build-type'));
        assert.ok(ws.tasks.tasks[0].args.includes(buildType));
    }
});

test('deployRuntimeFiles stages plugin DLLs/assets, guards unmanaged files, and cleans up disabled plugins', { skip: process.platform !== 'win32' }, (t) => {
    const { root, file } = fixture(t);
    const core = require('../lib/core.cjs');
    const pluginA = core.createPlugin({ pluginPath: path.join(root, '../plugin-a'), projectPath: root, name: 'plugin-a' });
    const pluginB = core.createPlugin({ pluginPath: path.join(root, '../plugin-b'), projectPath: root, name: 'plugin-b' });
    t.after(() => {
        fs.rmSync(pluginA.pluginPath, { recursive: true, force: true });
        fs.rmSync(pluginB.pluginPath, { recursive: true, force: true });
    });

    fs.mkdirSync(path.join(pluginA.pluginPath, 'native/third_party/bin'), { recursive: true });
    const runtimeDll = fs.readFileSync(path.join(process.env.SystemRoot, 'System32/version.dll'));
    const differentDll = fs.readFileSync(path.join(process.env.SystemRoot, 'System32/winmm.dll'));
    fs.writeFileSync(path.join(pluginA.pluginPath, 'native/third_party/bin/version.dll'), runtimeDll);
    fs.mkdirSync(path.join(pluginA.pluginPath, 'config'), { recursive: true });
    fs.writeFileSync(path.join(pluginA.pluginPath, 'config/quality.json'), JSON.stringify({ quality: 'high' }));
    const metaA = JSON.parse(fs.readFileSync(path.join(pluginA.pluginPath, 'plugin-dev.json'), 'utf8'));
    fs.writeFileSync(path.join(pluginA.pluginPath, 'plugin-dev.json'), JSON.stringify({
        ...metaA,
        runtimeFiles: [{ source: 'config/quality.json', target: 'config/quality.json' }],
    }, null, 2));

    const exe = file('build/bin/Game.exe', fs.readFileSync(process.execPath));
    file('build/bin/engine.dll', differentDll);
    const first = internal.deployRuntimeFiles(root, exe);
    assert.equal(first.deployed, 2);
    assert.deepEqual(fs.readFileSync(path.join(root, 'build/bin/version.dll')), runtimeDll);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'build/bin/config/quality.json'), 'utf8')), { quality: 'high' });

    // 两个插件可以共同使用内容一致的 DLL。
    fs.mkdirSync(path.join(pluginB.pluginPath, 'native/windows/bin'), { recursive: true });
    fs.writeFileSync(path.join(pluginB.pluginPath, 'native/windows/bin/version.dll'), runtimeDll);
    assert.equal(internal.deployRuntimeFiles(root, exe).deployed, 0);

    fs.writeFileSync(path.join(pluginB.pluginPath, 'native/windows/bin/version.dll'), differentDll);
    assert.throws(() => internal.deployRuntimeFiles(root, exe), /冲突/);

    // 宿主已有文件由宿主管理。
    fs.writeFileSync(path.join(pluginB.pluginPath, 'native/windows/bin/version.dll'), runtimeDll);
    fs.writeFileSync(path.join(pluginB.pluginPath, 'native/windows/bin/engine.dll'), runtimeDll);
    assert.throws(() => internal.deployRuntimeFiles(root, exe), /拒绝覆盖宿主已有文件/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'build/bin/engine.dll')), differentDll);
    fs.unlinkSync(path.join(pluginB.pluginPath, 'native/windows/bin/engine.dll'));

    // 禁用插件后删除受管文件，保留宿主文件。
    core.setEnabled({ projectPath: root, name: 'plugin-a', enabled: false });
    core.setEnabled({ projectPath: root, name: 'plugin-b', enabled: false });
    const cleaned = internal.deployRuntimeFiles(root, exe);
    assert.equal(cleaned.removed, 2);
    assert.equal(fs.existsSync(path.join(root, 'build/bin/version.dll')), false);
    assert.equal(fs.existsSync(path.join(root, 'build/bin/config/quality.json')), false);
    assert.deepEqual(fs.readFileSync(path.join(root, 'build/bin/engine.dll')), differentDll);
});
