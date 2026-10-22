'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const core = require('../lib/core.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-plugin-dev-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    function project(name = 'game') {
        const dir = path.join(root, name);
        fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, creator: { version: '3.8.8' } }));
        return dir;
    }
    return { root, project, projectPath: project() };
}
function put(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

test('creation wires official manifest, CMake, JSB and importable typed runtime', t => {
    const { projectPath } = fixture(t);
    const plugin = core.createPlugin({ projectPath, name: 'neural-render', template: 'native', displayName: '神经渲染' });
    const manifest = readJson(path.join(plugin.pluginPath, 'native/cc_plugin.json'));
    const pkg = readJson(path.join(plugin.pluginPath, 'package.json'));
    const cpp = fs.readFileSync(path.join(plugin.pluginPath, 'native/src/PluginEntry.cpp'), 'utf8');
    assert.equal(manifest.modules[0].target, plugin.target);
    assert.match(cpp, new RegExp(`CC_PLUGIN_ENTRY\\(${plugin.target}, loadPlugin\\)`));
    assert.match(cpp, /AFTER_INIT/);
    assert.match(cpp, /static double add/);
    assert.equal(manifest.disabled, false);
    assert.equal(pkg.package_version, 2);
    assert.ok(fs.existsSync(path.join(plugin.pluginPath, pkg.main)));
    assert.ok(fs.existsSync(path.join(plugin.pluginPath, `native/windows/${plugin.target}-config.cmake`)));
    const ts = fs.readFileSync(path.join(plugin.runtimePath, 'index.ts'), 'utf8');
    assert.match(ts, /globalThis\.CpdNeuralRender_/);
    assert.doesNotMatch(ts, /\bany\b|\{\{[A-Z_]+\}\}/);
    assert.match(fs.readFileSync(path.join(plugin.runtimePath, 'PluginProbe.ts'), 'utf8'), /NeuralRender\.add\(20, 22\)/);
    assert.equal(core.listPlugins({ projectPath })[0].displayName, '神经渲染');
    assert.equal(core.listPlugins({ projectPath })[0].needsRebuild, true);
});

test('creation rejects escaping, reserved names and existing source/assets', t => {
    const { projectPath, root } = fixture(t);
    for (const name of ['../escape', 'a/b', 'a\\b', 'A-b', 'cocos-plugin-dev', 'con', 'lpt1', 'bad--name', '', '1bad']) {
        assert.throws(() => core.createPlugin({ projectPath, name }), /名称/);
    }
    assert.equal(fs.existsSync(path.join(root, 'escape')), false);
    core.createPlugin({ projectPath, name: 'first' });
    assert.throws(() => core.createPlugin({ projectPath, name: 'first' }), /拒绝覆盖/);
    fs.mkdirSync(path.join(projectPath, 'assets/__plugin_dev/occupied'), { recursive: true });
    assert.throws(() => core.createPlugin({ projectPath, name: 'occupied' }), /拒绝接管/);
});

test('sync updates owned files, preserves UUID metadata and ignores user files', t => {
    const { projectPath } = fixture(t);
    const plugin = core.createPlugin({ projectPath, name: 'identity' });
    const source = path.join(plugin.pluginPath, 'runtime/index.ts');
    const destination = path.join(plugin.runtimePath, 'index.ts');
    const meta = path.join(plugin.runtimePath, 'index.ts.meta');
    put(meta, '{"uuid":"stable-scene-reference"}');
    put(path.join(plugin.runtimePath, 'notes.txt'), 'user note');
    put(path.join(plugin.pluginPath, 'runtime/index.ts.meta'), '{"uuid":"different-source-uuid"}');
    fs.appendFileSync(source, '\n// source update\n');
    const result = core.syncPlugin({ projectPath, name: 'identity' });
    assert.equal(result.copied, 1);
    assert.equal(fs.readFileSync(destination, 'utf8'), fs.readFileSync(source, 'utf8'));
    assert.equal(readJson(meta).uuid, 'stable-scene-reference');
    assert.equal(fs.readFileSync(path.join(plugin.runtimePath, 'notes.txt'), 'utf8'), 'user note');
    fs.unlinkSync(path.join(plugin.pluginPath, 'runtime/PluginProbe.ts'));
    const removed = core.syncPlugin({ projectPath, name: 'identity' });
    assert.equal(removed.removed, 1);
    assert.equal(fs.existsSync(path.join(plugin.runtimePath, 'PluginProbe.ts')), false);
});

test('conflict preflight prevents partial writes and partial enable changes', t => {
    const { projectPath } = fixture(t);
    const plugin = core.createPlugin({ projectPath, name: 'conflict' });
    const index = path.join(plugin.runtimePath, 'index.ts');
    fs.appendFileSync(index, '\n// manually edited in assets\n');
    put(path.join(plugin.pluginPath, 'runtime/new.ts'), 'export const value = 1;');
    assert.throws(() => core.setEnabled({ projectPath, name: 'conflict', enabled: false }), /同步冲突/);
    assert.equal(fs.existsSync(path.join(plugin.runtimePath, 'new.ts')), false);
    assert.equal(readJson(path.join(plugin.pluginPath, 'plugin-dev.json')).enabled, true);
    assert.equal(readJson(path.join(plugin.pluginPath, 'native/cc_plugin.json')).disabled, false);
    assert.match(fs.readFileSync(index, 'utf8'), /manually edited/);
    assert.match(fs.readFileSync(path.join(plugin.runtimePath, 'plugin-enabled.ts'), 'utf8'), /= true/);
});

test('stale manually edited files are protected from removal', t => {
    const { projectPath } = fixture(t);
    const plugin = core.createPlugin({ projectPath, name: 'stale-file' });
    const destination = path.join(plugin.runtimePath, 'PluginProbe.ts');
    fs.appendFileSync(destination, '\n// user modification\n');
    fs.unlinkSync(path.join(plugin.pluginPath, 'runtime/PluginProbe.ts'));
    assert.throws(() => core.syncPlugin({ projectPath, name: 'stale-file' }), /同步冲突/);
    assert.match(fs.readFileSync(destination, 'utf8'), /user modification/);
});

test('disable keeps component/API/UUID and aligns native manifest with TS flag', t => {
    const { projectPath } = fixture(t);
    const plugin = core.createPlugin({ projectPath, name: 'toggle' });
    put(path.join(plugin.runtimePath, 'PluginProbe.ts.meta'), '{"uuid":"keep-this"}');
    const original = fs.readFileSync(path.join(plugin.runtimePath, 'index.ts'), 'utf8');
    core.setEnabled({ projectPath, name: 'toggle', enabled: false });
    assert.equal(readJson(path.join(plugin.pluginPath, 'native/cc_plugin.json')).disabled, true);
    assert.equal(core.listPlugins({ projectPath })[0].enabled, false);
    assert.match(fs.readFileSync(path.join(plugin.runtimePath, 'plugin-enabled.ts'), 'utf8'), /= false/);
    assert.equal(fs.readFileSync(path.join(plugin.runtimePath, 'index.ts'), 'utf8'), original);
    assert.equal(readJson(path.join(plugin.runtimePath, 'PluginProbe.ts.meta')).uuid, 'keep-this');
    assert.ok(fs.existsSync(path.join(plugin.runtimePath, 'PluginProbe.ts')));
    core.setEnabled({ projectPath, name: 'toggle', enabled: true });
    assert.equal(readJson(path.join(plugin.pluginPath, 'native/cc_plugin.json')).disabled, false);
    assert.throws(() => core.setEnabled({ projectPath, name: 'toggle', enabled: 'false' }), /boolean/);
});

test('runtime mirroring rejects directory junction escapes', t => {
    const { projectPath, root } = fixture(t);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(projectPath, 'assets/__plugin_dev'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => core.createPlugin({ projectPath, name: 'escape-test' }), /符号链接|目录联接/);
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('render template registers a probe without claiming image production', t => {
    const { projectPath } = fixture(t);
    const plugin = core.createPlugin({ projectPath, name: 'render-probe', template: 'render' });
    const cpp = fs.readFileSync(path.join(plugin.pluginPath, 'native/src/RenderProbe.cpp'), 'utf8');
    assert.match(cpp, /pipeline->custom.computePasses.find/);
    assert.match(cpp, /addCustomComputePass/);
    assert.doesNotMatch(cpp, /dispatch\(/);
    assert.match(fs.readFileSync(path.join(plugin.runtimePath, 'index.ts'), 'utf8'), /installRenderProbe/);
    assert.match(fs.readFileSync(path.join(plugin.pluginPath, 'README.md'), 'utf8'), /未添加渲染图节点或执行推理/);
});

test('native changes mark rebuild but not asset refresh, TS and enable changes mark both', t => {
    const { projectPath } = fixture(t);
    const plugin = core.createPlugin({ projectPath, name: 'incremental' });
    const stateFile = path.join(projectPath, '.plugin-dev/state.json');
    const clean = () => {
        const state = readJson(stateFile);
        state.plugins.incremental.assetsDirty = false;
        state.plugins.incremental.needsRebuild = false;
        put(stateFile, JSON.stringify(state));
    };
    clean();
    let result = core.syncPlugin({ projectPath, name: 'incremental' });
    assert.equal(result.needsRebuild, false);
    assert.equal(result.assetsDirty, false);
    fs.appendFileSync(path.join(plugin.pluginPath, 'native/src/PluginEntry.cpp'), '\n// native edit\n');
    assert.equal(core.listPlugins({ projectPath })[0].needsRebuild, true);
    result = core.syncPlugin({ projectPath, name: 'incremental' });
    assert.equal(result.needsRebuild, true);
    assert.equal(result.assetsDirty, false);
    clean();
    fs.appendFileSync(path.join(plugin.pluginPath, 'runtime/index.ts'), '\n// runtime edit\n');
    assert.equal(core.listPlugins({ projectPath })[0].needsRebuild, true);
    assert.equal(core.listPlugins({ projectPath })[0].assetsDirty, true);
    result = core.syncPlugin({ projectPath, name: 'incremental' });
    assert.equal(result.needsRebuild, true);
    assert.equal(result.assetsDirty, true);
    clean();
    result = core.setEnabled({ projectPath, name: 'incremental', enabled: false });
    assert.equal(result.needsRebuild, true);
    assert.equal(result.assetsDirty, true);
});

test('local build state is ignored without rewriting user ignore rules', t => {
    const { projectPath } = fixture(t);
    core.createPlugin({ projectPath, name: 'local-state' });
    const ignore = path.join(projectPath, '.plugin-dev/.gitignore');
    assert.equal(fs.readFileSync(ignore, 'utf8'), '*\n');
    put(ignore, '*\n# user additions\n');
    core.syncPlugin({ projectPath, name: 'local-state' });
    assert.equal(fs.readFileSync(ignore, 'utf8'), '*\n# user additions\n');
    assert.equal(fs.existsSync(path.join(projectPath, '.gitignore')), false);
});

test('packaging filters caches, creates readable ZIP, and installs independently', t => {
    const { projectPath, project, root } = fixture(t);
    const plugin = core.createPlugin({ projectPath, name: 'portable-plugin' });
    put(path.join(plugin.pluginPath, 'native/build/CMakeCache.txt'), 'C:/private/cache');
    put(path.join(plugin.pluginPath, 'node_modules/dependency/index.js'), 'do not ship');
    put(path.join(plugin.pluginPath, '.git/config'), 'private');
    put(path.join(plugin.pluginPath, 'native/src/temp.obj'), 'binary');
    put(path.join(plugin.runtimePath, 'PluginProbe.ts.meta'), '{"uuid":"portable-component-uuid"}');
    put(path.join(plugin.pluginPath, 'runtime/PluginProbe.ts.meta'), '{"uuid":"outdated-source-uuid"}');
    put(path.join(plugin.pluginPath, 'runtime/example.prefab'), '{"component":"portable-component-uuid"}');
    put(path.join(plugin.runtimePath, 'example.prefab.meta'), '{"uuid":"portable-prefab-uuid"}');
    core.setEnabled({ projectPath, name: 'portable-plugin', enabled: false });
    const result = core.packagePlugin({ projectPath, name: 'portable-plugin' });
    assert.equal(result.metadataSeeds, 2);
    assert.equal(result.warnings.length, 1);
    assert.equal(readJson(path.join(plugin.pluginPath, 'runtime/PluginProbe.ts.meta')).uuid, 'outdated-source-uuid');
    assert.ok(fs.existsSync(result.zipPath));
    assert.equal(fs.existsSync(path.join(result.packagePath, 'native/build')), false);
    assert.equal(fs.existsSync(path.join(result.packagePath, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(result.packagePath, '.git')), false);
    assert.equal(fs.existsSync(path.join(result.packagePath, 'native/src/temp.obj')), false);
    const target = project('other-game');
    fs.mkdirSync(path.join(target, 'extensions'), { recursive: true });
    fs.cpSync(result.packagePath, path.join(target, 'extensions/portable-plugin'), { recursive: true });
    // Use the package's own code; the development tool need not be installed.
    const standalone = require(path.join(target, 'extensions/portable-plugin/editor/plugin-support.cjs'));
    standalone.syncPlugin({ projectPath: target, name: 'portable-plugin' });
    assert.equal(readJson(path.join(target, 'assets/__plugin_dev/portable-plugin/PluginProbe.ts.meta')).uuid, 'portable-component-uuid');
    assert.equal(readJson(path.join(target, 'assets/__plugin_dev/portable-plugin/example.prefab.meta')).uuid, 'portable-prefab-uuid');
    assert.equal(readJson(path.join(target, 'assets/__plugin_dev/portable-plugin/example.prefab')).component, 'portable-component-uuid');
    assert.match(fs.readFileSync(path.join(target, 'assets/__plugin_dev/portable-plugin/plugin-enabled.ts'), 'utf8'), /= true/);
    assert.equal(readJson(path.join(target, 'extensions/portable-plugin/native/cc_plugin.json')).disabled, false);
    assert.equal(readJson(path.join(plugin.pluginPath, 'native/cc_plugin.json')).disabled, true);
    assert.throws(() => core.packagePlugin({ projectPath, name: 'portable-plugin' }), /已存在/);
    assert.throws(() => core.packagePlugin({ projectPath, name: 'portable-plugin', outputDir: path.join(plugin.pluginPath, 'dist') }), /不能位于/);
    if (process.platform === 'win32') {
        const zipTarget = path.join(root, 'unzip-check');
        const script = "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1]";
        const scriptFile = path.join(root, 'unzip.ps1');
        put(scriptFile, script);
        execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, result.zipPath, zipTarget]);
        assert.equal(readJson(path.join(zipTarget, 'portable-plugin/package.json')).name, 'portable-plugin');
    }
});

test('independent editor/CLI processes serialize state updates without dropping plugins', async t => {
    const { projectPath, root } = fixture(t);
    const runner = path.join(root, 'parallel.cjs');
    put(runner, `const core = require(${JSON.stringify(path.resolve(__dirname, '../lib/core.cjs'))});\ncore.createPlugin({ projectPath: process.argv[2], name: process.argv[3] });\n`);
    const run = promisify(execFile);
    await Promise.all(['parallel-one', 'parallel-two', 'parallel-three'].map(name => run(process.execPath, [runner, projectPath, name])));
    const state = readJson(path.join(projectPath, '.plugin-dev/state.json'));
    assert.equal(Object.keys(state.plugins).length, 3);
    assert.equal(core.listPlugins({ projectPath }).length, 3);
    assert.equal(fs.existsSync(path.join(projectPath, '.plugin-dev/operation.lock')), false);
});

test('tool install supports owned upgrades and refuses unrelated or edited files', t => {
    const { projectPath, project, root } = fixture(t);
    const source = path.join(root, 'tool-source');
    put(path.join(source, 'package.json'), JSON.stringify({ name: 'cocos-plugin-dev', version: '0.1.0' }));
    put(path.join(source, 'main.js'), 'module.exports = {};');
    put(path.join(source, '.local/private.txt'), 'do not ship');
    const installed = core.installTools({ projectPath, sourcePath: source });
    assert.equal(fs.existsSync(path.join(installed.path, '.local')), false);
    put(path.join(source, 'main.js'), 'module.exports = { upgraded: true };');
    core.installTools({ projectPath, sourcePath: source });
    assert.match(fs.readFileSync(path.join(installed.path, 'main.js'), 'utf8'), /upgraded/);
    put(path.join(installed.path, 'main.js'), 'user customized');
    assert.throws(() => core.installTools({ projectPath, sourcePath: source }), /手工修改/);
    const other = project('unrelated');
    put(path.join(other, 'extensions/cocos-plugin-dev/package.json'), '{"name":"unrelated"}');
    assert.throws(() => core.installTools({ projectPath: other, sourcePath: source }), /不属于/);
});
