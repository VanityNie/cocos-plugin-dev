'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
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
    put(path.join(source, 'node_modules/typescript/package.json'), JSON.stringify({ name: 'typescript', version: '5.9.3' }));
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

test('standalone plugin creation needs no game and contains no host state', t => {
    const { root } = fixture(t);
    const pluginPath = path.join(root, 'plugin-repository');
    const created = core.createPlugin({ pluginPath, name: 'independent-render', template: 'render' });
    assert.equal(created.pluginPath, pluginPath);
    assert.equal(created.standalone, true);
    const descriptor = readJson(path.join(pluginPath, 'plugin-dev.json'));
    assert.equal(descriptor.schemaVersion, 2);
    assert.equal(Object.hasOwn(descriptor, 'enabled'), false);
    assert.equal(fs.existsSync(path.join(pluginPath, 'plugin-dev.host.json')), false);
    assert.equal(fs.existsSync(path.join(pluginPath, '.plugin-dev')), false);
    assert.match(fs.readFileSync(path.join(pluginPath, '.gitignore'), 'utf8'), /CMakeCache\.txt/);
    assert.throws(() => core.createPlugin({ name: 'no-location' }), /pluginPath/);
});

test('two hosts compile original sources and maintain independent enable and import state', t => {
    const { root, projectPath, project } = fixture(t);
    const pluginPath = path.join(root, 'shared source');
    const created = core.createPlugin({ pluginPath, name: 'shared-runtime', projectPath });
    const second = project('second-game');
    const linked = core.linkPlugin({ projectPath: second, sourcePath: pluginPath });
    assert.equal(linked.sourceType, 'local');
    assert.equal(created.pluginPath, linked.pluginPath);
    assert.notEqual(created.extensionPath, linked.extensionPath);
    assert.equal(readJson(path.join(projectPath, 'plugin-dev.host.json')).plugins['shared-runtime'].source, '../shared source');
    const sourceBefore = fs.readFileSync(path.join(pluginPath, 'plugin-dev.json'), 'utf8');
    const nativeBefore = fs.readFileSync(path.join(pluginPath, 'native/cc_plugin.json'), 'utf8');
    core.setEnabled({ projectPath, name: 'shared-runtime', enabled: false });
    assert.equal(core.listPlugins({ projectPath })[0].enabled, false);
    assert.equal(core.listPlugins({ projectPath: second })[0].enabled, true);
    assert.equal(readJson(path.join(created.extensionPath, 'native/cc_plugin.json')).disabled, true);
    assert.equal(readJson(path.join(linked.extensionPath, 'native/cc_plugin.json')).disabled, false);
    assert.equal(fs.readFileSync(path.join(pluginPath, 'plugin-dev.json'), 'utf8'), sourceBefore);
    assert.equal(fs.readFileSync(path.join(pluginPath, 'native/cc_plugin.json'), 'utf8'), nativeBefore);
    const config = fs.readFileSync(path.join(created.extensionPath, `native/windows/${created.target}-config.cmake`), 'utf8');
    assert.ok(config.includes(path.join(pluginPath, `native/windows/${created.target}-config.cmake`).replace(/\\/g, '/')));
    assert.equal(fs.existsSync(path.join(created.extensionPath, 'native/src')), false);
    fs.appendFileSync(path.join(pluginPath, 'runtime/index.ts'), '\n// one source, two hosts\n');
    // The adapter ships its own sync implementation and needs no workbench at runtime.
    const adapter = require(path.join(linked.extensionPath, 'editor/plugin-support.cjs'));
    adapter.syncPlugin({ projectPath: second, name: 'shared-runtime' });
    core.syncPlugin({ projectPath, name: 'shared-runtime' });
    for (const item of [created, linked]) assert.match(fs.readFileSync(path.join(item.runtimePath, 'index.ts'), 'utf8'), /one source, two hosts/);
    assert.match(fs.readFileSync(path.join(created.runtimePath, 'plugin-enabled.ts'), 'utf8'), /= false/);
    assert.match(fs.readFileSync(path.join(linked.runtimePath, 'plugin-enabled.ts'), 'utf8'), /= true/);
});

test('unlink retains imported assets and UUIDs, relink restores the same source with independent state', t => {
    const { root, projectPath } = fixture(t);
    const pluginPath = path.join(root, 'reusable');
    const plugin = core.createPlugin({ pluginPath, projectPath, name: 'reusable' });
    const metadata = path.join(plugin.runtimePath, 'PluginProbe.ts.meta');
    put(metadata, '{"uuid":"existing-scene-component"}');
    const result = core.unlinkPlugin({ projectPath, name: 'reusable' });
    assert.equal(result.detached, true);
    assert.equal(result.pluginPath, pluginPath);
    assert.equal(fs.existsSync(plugin.extensionPath), false);
    assert.equal(fs.existsSync(path.join(pluginPath, 'native/src/PluginEntry.cpp')), true);
    assert.equal(readJson(metadata).uuid, 'existing-scene-component');
    assert.match(fs.readFileSync(path.join(plugin.runtimePath, 'plugin-enabled.ts'), 'utf8'), /= false/);
    assert.equal(readJson(path.join(projectPath, 'plugin-dev.host.json')).plugins.reusable, undefined);
    assert.deepEqual(core.listPlugins({ projectPath }), []);
    const record = readJson(path.join(projectPath, '.plugin-dev/state.json')).plugins.reusable;
    assert.equal(record.detached, true);
    assert.equal(record.needsRebuild, true);
    assert.equal(record.assetsDirty, true);
    core.linkPlugin({ projectPath, sourcePath: pluginPath });
    assert.equal(core.listPlugins({ projectPath })[0].enabled, true);
    assert.equal(readJson(metadata).uuid, 'existing-scene-component');
    assert.match(fs.readFileSync(path.join(plugin.runtimePath, 'plugin-enabled.ts'), 'utf8'), /= true/);
});

test('external source, adapter and runtime errors remain visible and preserve existing files', t => {
    const { root, projectPath } = fixture(t);
    const pluginPath = path.join(root, 'external');
    const plugin = core.createPlugin({ pluginPath, projectPath, name: 'external' });
    const config = path.join(plugin.extensionPath, `native/windows/${plugin.target}-config.cmake`);
    const original = fs.readFileSync(config);
    fs.appendFileSync(config, '\n# hand edit\n');
    assert.throws(() => core.syncPlugin({ projectPath, name: 'external' }), /宿主适配文件包含手工修改/);
    assert.throws(() => core.unlinkPlugin({ projectPath, name: 'external' }), /手工修改/);
    assert.equal(readJson(path.join(projectPath, 'plugin-dev.host.json')).plugins.external.enabled, true);
    put(config, original);
    fs.appendFileSync(path.join(plugin.runtimePath, 'index.ts'), '\n// conflict\n');
    assert.throws(() => core.setEnabled({ projectPath, name: 'external', enabled: false }), /同步冲突/);
    assert.equal(readJson(path.join(projectPath, 'plugin-dev.host.json')).plugins.external.enabled, true);
    const moved = `${pluginPath}-moved`;
    fs.renameSync(pluginPath, moved);
    assert.throws(() => core.listPlugins({ projectPath }), /源码不存在/);
    assert.throws(() => core.syncPlugin({ projectPath, name: 'external' }), /源码不存在/);
    assert.ok(fs.existsSync(plugin.extensionPath));
});

test('host reference rejects collisions, nesting and linked directories before generating adapters', t => {
    const { root, projectPath, project } = fixture(t);
    const source = path.join(root, 'collision-source');
    core.createPlugin({ pluginPath: source, name: 'collision' });
    const occupied = path.join(projectPath, 'extensions/collision');
    put(path.join(occupied, 'user.txt'), 'keep');
    assert.throws(() => core.linkPlugin({ projectPath, sourcePath: source }), /拒绝覆盖/);
    assert.equal(fs.existsSync(path.join(projectPath, 'plugin-dev.host.json')), false);
    assert.equal(fs.readFileSync(path.join(occupied, 'user.txt'), 'utf8'), 'keep');
    assert.throws(() => core.createPlugin({ projectPath, pluginPath: path.join(projectPath, 'my-plugin'), name: 'nested' }), /互不包含/);
    assert.equal(fs.existsSync(path.join(projectPath, 'my-plugin')), false);
    const junction = path.join(root, 'linked-source');
    fs.symlinkSync(source, junction, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => core.linkPlugin({ projectPath: project('junction-host'), sourcePath: junction }), /符号链接|目录联接/);
    const embedded = core.createPlugin({ projectPath: project('embedded-host'), name: 'embedded' });
    assert.throws(() => core.unlinkPlugin({ projectPath: path.dirname(path.dirname(embedded.pluginPath)), name: 'embedded' }), /内嵌插件/);
});

test('host manifest edits are reflected as pending build and source enable remains unchanged', t => {
    const { root, projectPath } = fixture(t);
    const plugin = core.createPlugin({ pluginPath: path.join(root, 'manual-host'), projectPath, name: 'manual-host' });
    const stateFile = path.join(projectPath, '.plugin-dev/state.json');
    const state = readJson(stateFile);
    state.plugins['manual-host'].needsRebuild = false;
    state.plugins['manual-host'].assetsDirty = false;
    put(stateFile, JSON.stringify(state));
    const hostFile = path.join(projectPath, 'plugin-dev.host.json');
    const host = readJson(hostFile);
    host.plugins['manual-host'].enabled = false;
    put(hostFile, JSON.stringify(host));
    const listed = core.listPlugins({ projectPath })[0];
    assert.equal(listed.enabled, false);
    assert.equal(listed.needsRebuild, true);
    assert.equal(listed.assetsDirty, true);
    core.syncPlugin({ projectPath, name: 'manual-host' });
    assert.equal(readJson(path.join(plugin.extensionPath, 'native/cc_plugin.json')).disabled, true);
    assert.equal(Object.hasOwn(readJson(path.join(plugin.pluginPath, 'plugin-dev.json')), 'enabled'), false);
});

test('packaging an independent plugin produces a portable embedded extension without host paths', t => {
    const { root, projectPath, project } = fixture(t);
    const plugin = core.createPlugin({ pluginPath: path.join(root, 'package-source'), projectPath, name: 'package-source' });
    core.setEnabled({ projectPath, name: 'package-source', enabled: false });
    const packaged = core.packagePlugin({ projectPath, name: 'package-source' });
    const descriptor = readJson(path.join(packaged.packagePath, 'plugin-dev.json'));
    assert.equal(descriptor.schemaVersion, 1);
    assert.equal(descriptor.enabled, true);
    assert.equal(fs.existsSync(path.join(packaged.packagePath, '.plugin-dev-adapter.json')), false);
    assert.equal(fs.existsSync(path.join(packaged.packagePath, 'plugin-dev.host.json')), false);
    assert.equal(Object.hasOwn(readJson(path.join(plugin.pluginPath, 'plugin-dev.json')), 'enabled'), false);
    const target = project('package-game');
    const destination = path.join(target, 'extensions/package-source');
    fs.cpSync(packaged.packagePath, destination, { recursive: true });
    require(path.join(destination, 'editor/plugin-support.cjs')).syncPlugin({ projectPath: target, name: 'package-source' });
    assert.equal(core.listPlugins({ projectPath: target })[0].sourceType, 'embedded');
});

test('checked-in host references restore absent adapters and repeated link preserves host enable state', t => {
    const { root, projectPath } = fixture(t);
    const sourcePath = path.join(root, 'restorable');
    const created = core.createPlugin({ pluginPath: sourcePath, projectPath, name: 'restorable' });
    core.setEnabled({ projectPath, name: 'restorable', enabled: false });
    const sourceBefore = fs.readFileSync(path.join(sourcePath, 'plugin-dev.json'));
    const flagBefore = fs.readFileSync(path.join(created.runtimePath, 'plugin-enabled.ts'));
    fs.rmSync(created.extensionPath, { recursive: true });
    assert.equal(core.listPlugins({ projectPath })[0].needsRebuild, true);
    core.syncPlugin({ projectPath, name: 'restorable' });
    assert.equal(readJson(path.join(created.extensionPath, 'native/cc_plugin.json')).disabled, true);
    fs.rmSync(created.extensionPath, { recursive: true });
    const linked = core.linkPlugin({ projectPath, sourcePath });
    assert.equal(linked.enabled, false);
    assert.deepEqual(fs.readFileSync(path.join(created.runtimePath, 'plugin-enabled.ts')), flagBefore);
    assert.deepEqual(fs.readFileSync(path.join(sourcePath, 'plugin-dev.json')), sourceBefore);
    fs.rmSync(created.extensionPath, { recursive: true });
    put(path.join(created.extensionPath, 'unrelated.txt'), 'do not take over');
    assert.throws(() => core.syncPlugin({ projectPath, name: 'restorable' }), /拒绝接管/);
    assert.equal(fs.readFileSync(path.join(created.extensionPath, 'unrelated.txt'), 'utf8'), 'do not take over');
});

test('unlink can remove a missing source reference without deleting imported assets', t => {
    const { root, projectPath } = fixture(t);
    const plugin = core.createPlugin({ pluginPath: path.join(root, 'moved-source'), projectPath, name: 'moved-source' });
    put(path.join(plugin.runtimePath, 'PluginProbe.ts.meta'), '{"uuid":"keep-on-detach"}');
    fs.renameSync(plugin.pluginPath, `${plugin.pluginPath}-new-location`);
    assert.throws(() => core.listPlugins({ projectPath }), /源码不存在/);
    const result = core.unlinkPlugin({ projectPath, name: 'moved-source' });
    assert.equal(result.detached, true);
    assert.equal(fs.existsSync(plugin.extensionPath), false);
    assert.equal(readJson(path.join(plugin.runtimePath, 'PluginProbe.ts.meta')).uuid, 'keep-on-detach');
    assert.match(fs.readFileSync(path.join(plugin.runtimePath, 'plugin-enabled.ts'), 'utf8'), /= false/);
    assert.deepEqual(core.listPlugins({ projectPath }), []);
});

test('orphaned host adapters are reported instead of silently remaining in native builds', t => {
    const { root, projectPath } = fixture(t);
    const plugin = core.createPlugin({ pluginPath: path.join(root, 'orphan-source'), projectPath, name: 'orphan-source' });
    fs.unlinkSync(path.join(projectPath, 'plugin-dev.host.json'));
    assert.throws(() => core.listPlugins({ projectPath }), /缺少 plugin-dev.host.json 引用/);
    assert.ok(fs.existsSync(path.join(plugin.extensionPath, 'native/cc_plugin.json')));
});

test('diagnostic listing exposes a broken local reference without hiding strict build failures', t => {
    const { root, projectPath } = fixture(t);
    const plugin = core.createPlugin({ pluginPath: path.join(root, 'diagnostic-source'), projectPath, name: 'diagnostic-source' });
    fs.renameSync(plugin.pluginPath, `${plugin.pluginPath}-moved`);
    assert.throws(() => core.listPlugins({ projectPath }), /源码不存在/);
    const [diagnostic] = core.listPlugins({ projectPath, includeErrors: true });
    assert.equal(diagnostic.name, 'diagnostic-source');
    assert.equal(diagnostic.sourcePath, plugin.pluginPath);
    assert.equal(diagnostic.extensionPath, plugin.extensionPath);
    assert.equal(diagnostic.enabled, true);
    assert.match(diagnostic.error, /源码不存在/);
    put(path.join(projectPath, 'plugin-dev.host.json'), '{"schemaVersion":99}');
    assert.throws(() => core.listPlugins({ projectPath, includeErrors: true }), /配置格式/);
});

test('external editor watcher auto-syncs, retargets source references and exposes synchronization failures', async t => {
    const { root, projectPath } = fixture(t);
    const plugin = core.createPlugin({ pluginPath: path.join(root, 'watched-source'), projectPath, name: 'watched-source' });
    const nextSource = path.join(root, 'retargeted-source');
    core.createPlugin({ pluginPath: nextSource, name: 'watched-source' });
    const file = path.join(plugin.extensionPath, 'editor/main.js');
    const exports = {};
    const failures = [];
    const refreshes = [];
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { exports, require: createRequire(file), __dirname: path.dirname(file),
        setTimeout, clearTimeout, console: { error: (...args) => failures.push(args.join(' ')) },
        Editor: { Project: { path: projectPath }, Message: { request: async (...args) => refreshes.push(args) } },
    }, { filename: file });
    t.after(() => exports.unload());
    const until = async predicate => {
        const limit = Date.now() + 5000;
        while (!predicate()) {
            if (Date.now() >= limit) throw new Error(`Watcher did not reach expected state; reported errors: ${failures.join('\n')}`);
            await new Promise(resolve => setTimeout(resolve, 30));
        }
    };
    await exports.load();
    const mirror = path.join(plugin.runtimePath, 'index.ts');
    fs.appendFileSync(path.join(plugin.pluginPath, 'runtime/index.ts'), '\n// watch first source\n');
    await until(() => fs.readFileSync(mirror, 'utf8').includes('watch first source'));
    const hostFile = path.join(projectPath, 'plugin-dev.host.json');
    const host = readJson(hostFile);
    host.plugins['watched-source'].source = '../retargeted-source';
    put(hostFile, JSON.stringify(host));
    await until(() => !fs.readFileSync(mirror, 'utf8').includes('watch first source'));
    fs.appendFileSync(path.join(nextSource, 'runtime/index.ts'), '\n// watch second source\n');
    await until(() => fs.readFileSync(mirror, 'utf8').includes('watch second source'));
    fs.appendFileSync(mirror, '\n// user conflict\n');
    fs.appendFileSync(path.join(nextSource, 'runtime/index.ts'), '\n// surface sync failure\n');
    await until(() => failures.some(message => message.includes('同步冲突')));
    assert.ok(refreshes.some(args => args[0] === 'asset-db' && args[1] === 'refresh-asset'));
    assert.match(fs.readFileSync(mirror, 'utf8'), /user conflict/);
    assert.doesNotMatch(fs.readFileSync(mirror, 'utf8'), /surface sync failure/);
    fs.renameSync(path.join(nextSource, 'runtime'), path.join(nextSource, 'runtime-removed'));
    await until(() => failures.some(message => message.includes('runtime 目录缺失')));
});

test('watcher setup failure closes already opened source watchers and rejects extension load', async t => {
    const { root, projectPath } = fixture(t);
    const plugin = core.createPlugin({ pluginPath: path.join(root, 'watch-failure'), projectPath, name: 'watch-failure' });
    const file = path.join(plugin.extensionPath, 'editor/main.js');
    const requireFromPlugin = createRequire(file);
    const exports = {};
    let watchCalls = 0;
    let closed = 0;
    const fakeFs = { ...fs, watch() {
        if (++watchCalls === 2) throw new Error('Host watcher permission denied');
        const watcher = new EventEmitter();
        watcher.close = () => closed++;
        return watcher;
    } };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { exports, require: id => id === 'node:fs' ? fakeFs : requireFromPlugin(id),
        setTimeout, clearTimeout, console,
        Editor: { Project: { path: projectPath }, Message: { request: async () => {} } },
    }, { filename: file });
    await assert.rejects(exports.load(), /Host watcher permission denied/);
    assert.equal(watchCalls, 2);
    assert.equal(closed, 1);
    exports.unload();
    assert.equal(closed, 1);
});

test('插件创建生成独立的源码类型环境与宿主类型项目', t => {
    const { root, projectPath, project } = fixture(t);
    const pluginPath = path.join(root, 'typed-plugin');
    const created = core.createPlugin({ pluginPath, name: 'typed-plugin' });
    const tsconfig = readJson(path.join(pluginPath, 'tsconfig.json'));
    assert.equal(tsconfig.compilerOptions.experimentalDecorators, true);
    assert.ok(!tsconfig.include.includes('.local/**/*.d.ts'));
    const fallbackFile = path.join(pluginPath, '.local/cc-default.d.ts');
    const defaultTypes = fs.readFileSync(fallbackFile, 'utf8');
    assert.match(defaultTypes, /export class Component/);
    core.linkPlugin({ projectPath, sourcePath: pluginPath });
    const support = require('../templates/common/editor/plugin-support.cjs');
    const first = support.syncTypeDeclarations(projectPath, pluginPath);
    const secondHost = project('engine-only-host');
    core.linkPlugin({ projectPath: secondHost, sourcePath: pluginPath });
    const second = support.syncTypeDeclarations(secondHost, pluginPath);
    assert.notEqual(first.configFile, second.configFile);
    assert.notEqual(first.targetFile, second.targetFile);
    assert.equal(fs.readFileSync(fallbackFile, 'utf8'), defaultTypes);
    assert.match(fs.readFileSync(first.targetFile, 'utf8'), /declare module 'cc'/);
    assert.match(fs.readFileSync(second.targetFile, 'utf8'), /declare module 'cc'/);

    const packaged = core.packagePlugin({ projectPath, name: 'typed-plugin' });
    assert.equal(fs.existsSync(path.join(packaged.packagePath, 'tsconfig.json')), true);
    assert.equal(fs.existsSync(path.join(packaged.packagePath, '.local')), false);
    assert.equal(created.pluginPath, pluginPath);
});

test('third_party CMake hooks and runtimeFiles validation track native binary fingerprints', t => {
    const { root, projectPath } = fixture(t);
    const pluginPath = path.join(root, 'inference-plugin');
    const plugin = core.createPlugin({ pluginPath, projectPath, name: 'inference-plugin', template: 'render' });
    const cmake = fs.readFileSync(path.join(pluginPath, 'native/src/CMakeLists.txt'), 'utf8');
    assert.match(cmake, /third_party\/include/);
    assert.match(cmake, /third_party\/lib\/\*\.lib/);
    assert.match(cmake, /third_party\/CMakeLists\.txt/);

    const stateFile = path.join(projectPath, '.plugin-dev/state.json');
    const markClean = () => {
        const state = readJson(stateFile);
        state.plugins['inference-plugin'].needsRebuild = false;
        state.plugins['inference-plugin'].assetsDirty = false;
        put(stateFile, JSON.stringify(state));
    };
    markClean();
    assert.equal(core.listPlugins({ projectPath })[0].needsRebuild, false);

    put(path.join(pluginPath, 'native/third_party/bin/runtime-settings.json'), JSON.stringify({ quality: 'high' }));
    assert.equal(core.listPlugins({ projectPath })[0].needsRebuild, true);
    core.syncPlugin({ projectPath, name: 'inference-plugin' });
    markClean();

    const metaFile = path.join(pluginPath, 'plugin-dev.json');
    const meta = readJson(metaFile);
    put(path.join(pluginPath, 'models/settings.json'), JSON.stringify({ scale: 2 }));
    put(metaFile, JSON.stringify({ ...meta, runtimeFiles: [{ source: 'models/settings.json', target: 'models/settings.json' }] }, null, 2));
    assert.equal(core.listPlugins({ projectPath })[0].needsRebuild, true);
    core.syncPlugin({ projectPath, name: 'inference-plugin' });
    markClean();

    put(path.join(pluginPath, 'models/settings.json'), JSON.stringify({ scale: 4 }));
    assert.equal(core.listPlugins({ projectPath })[0].needsRebuild, true);

    put(metaFile, JSON.stringify({ ...meta, runtimeFiles: [{ source: '../outside.dll', target: 'outside.dll' }] }, null, 2));
    assert.throws(() => core.syncPlugin({ projectPath, name: 'inference-plugin' }), /路径越界/);
    put(metaFile, JSON.stringify({ ...meta, runtimeFiles: [{ source: 'models/settings.json', target: '../escape.json' }] }, null, 2));
    assert.throws(() => core.syncPlugin({ projectPath, name: 'inference-plugin' }), /无效的运行时目标路径/);
    assert.ok(plugin.target);
});
