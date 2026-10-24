'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { ensureDevHost, _internal } = require('../lib/dev-host.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpd-dev-host-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = (name, value = '') => {
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
        return target;
    };
    file('game/package.json', { name: 'game' });
    fs.mkdirSync(path.join(root, 'game/assets'));
    file('engine/editor/assets/default_file_content/scene/default.scene', [
        { __type__: 'cc.SceneAsset', _name: 'default', scene: { __id__: 1 } },
        { __type__: 'cc.Scene', _name: '', _components: [], _children: [], _id: 'original' },
    ]);
    file('engine/editor/assets/default_file_content/scene/default.scene.meta', { ver: '1.1.50', importer: 'scene', uuid: 'engine-default' });
    return { root, file, options: { projectPath: path.join(root, 'game'), enginePath: path.join(root, 'engine'), plugins: [] } };
}

test('empty host receives a runnable scene with matching script and scene UUIDs', t => {
    const { options } = fixture(t);
    const result = ensureDevHost(options);
    assert.equal(result.changed, true);
    assert.equal(result.scene.url, 'db://assets/__plugin_dev_host/plugin-dev.scene');
    const scene = JSON.parse(fs.readFileSync(path.join(result.directory, 'plugin-dev.scene')));
    const sceneMeta = JSON.parse(fs.readFileSync(path.join(result.directory, 'plugin-dev.scene.meta')));
    const scriptMeta = JSON.parse(fs.readFileSync(path.join(result.directory, 'Bootstrap.ts.meta')));
    assert.equal(scene[1]._id, sceneMeta.uuid);
    assert.equal(result.scene.uuid, sceneMeta.uuid);
    assert.equal(scene[2].__type__, _internal.scriptClassId(scriptMeta.uuid));
    assert.deepEqual(scene[2].node, { __id__: 1 });
    assert.deepEqual(scene[1]._components, [{ __id__: 2 }]);
    assert.equal(fs.existsSync(path.join(options.projectPath, 'settings/v2/packages/builder.json')), false);
});

test('script UUID encoding matches the actual Creator 3.8.8 imported PluginProbe', () => {
    assert.equal(_internal.scriptClassId('f3a13b31-5027-44e9-a067-caf86fdc296d'), 'f3a13sxUCdE6aBnyvhv3Clt');
    assert.throws(() => _internal.scriptClassId('not-a-uuid'), /Invalid script UUID/);
});

test('repeated generation keeps UUIDs, imported metadata and user scenes unchanged', t => {
    const { options, file } = fixture(t);
    const userScene = file('game/assets/MyGame.scene', 'user scene');
    const first = ensureDevHost(options);
    const metaPath = path.join(first.directory, 'Bootstrap.ts.meta');
    const metadata = JSON.parse(fs.readFileSync(metaPath));
    metadata.imported = true;
    metadata.userData = { custom: true };
    fs.writeFileSync(metaPath, JSON.stringify(metadata));
    const second = ensureDevHost(options);
    assert.equal(second.changed, false);
    assert.deepEqual(second.scene, first.scene);
    assert.deepEqual(JSON.parse(fs.readFileSync(metaPath)), metadata);
    assert.equal(fs.readFileSync(userScene, 'utf8'), 'user scene');
});

test('enabled probes participate and disabled plugins do not enter the test scene', t => {
    const { options, file } = fixture(t);
    file('game/assets/__plugin_dev/first/PluginProbe.ts', 'probe');
    file('game/assets/__plugin_dev/disabled/PluginProbe.ts', 'probe');
    options.plugins = [
        { name: 'first', enabled: true, nativeClass: 'NativeFirst' },
        { name: 'disabled', enabled: false, nativeClass: 'NativeDisabled' },
        { name: 'second', enabled: true, nativeClass: 'NativeSecond' },
    ];
    const result = ensureDevHost(options);
    const source = fs.readFileSync(path.join(result.directory, 'Bootstrap.ts'), 'utf8');
    assert.match(source, /import \* as probe0 from '..\/__plugin_dev\/first\/PluginProbe'/);
    assert.doesNotMatch(source, /NativeDisabled|__plugin_dev\/disabled/);
    assert.deepEqual(result.plugins.map(entry => entry.test), ['component', 'native-registration']);
    assert.match(source, /未提供 runtime\/PluginProbe.ts，不执行业务测试/);
    options.plugins[0].enabled = false;
    const disabled = ensureDevHost(options);
    assert.equal(disabled.changed, true);
    assert.equal(disabled.scene.uuid, result.scene.uuid);
    assert.doesNotMatch(fs.readFileSync(path.join(result.directory, 'Bootstrap.ts'), 'utf8'), /NativeFirst/);
});

test('modified generated content aborts before any other generated file is changed', t => {
    const { options, file } = fixture(t);
    const result = ensureDevHost(options);
    const scenePath = file('game/assets/__plugin_dev_host/plugin-dev.scene', 'edited scene');
    const scriptPath = path.join(result.directory, 'Bootstrap.ts');
    const before = fs.readFileSync(scriptPath, 'utf8');
    options.plugins = [{ name: 'example', enabled: true, nativeClass: 'Example' }];
    assert.throws(() => ensureDevHost(options), /已被修改，拒绝覆盖/);
    assert.equal(fs.readFileSync(scenePath, 'utf8'), 'edited scene');
    assert.equal(fs.readFileSync(scriptPath, 'utf8'), before);
});

test('missing generated files regenerate with the original UUIDs', t => {
    const { options } = fixture(t);
    const result = ensureDevHost(options);
    fs.unlinkSync(path.join(result.directory, 'Bootstrap.ts'));
    const next = ensureDevHost(options);
    assert.equal(next.changed, true);
    assert.equal(next.scene.uuid, result.scene.uuid);
    assert.equal(fs.existsSync(path.join(result.directory, 'Bootstrap.ts')), true);
});

test('unowned directory and edited metadata identity are explicit conflicts', t => {
    const { options, file } = fixture(t);
    const result = ensureDevHost(options);
    const meta = JSON.parse(fs.readFileSync(path.join(result.directory, 'Bootstrap.ts.meta')));
    meta.uuid = 'something-else';
    file('game/assets/__plugin_dev_host/Bootstrap.ts.meta', meta);
    assert.throws(() => ensureDevHost(options), /UUID 或 importer 已被修改/);
    fs.unlinkSync(path.join(options.projectPath, '.plugin-dev/dev-host.json'));
    assert.throws(() => ensureDevHost(options), /不属于工作台，拒绝覆盖/);
});

function runBootstrap(entries, bridges = {}, native = true, moduleFactory) {
    class Component {}
    class Probe extends Component {}
    const attached = [];
    const logs = [];
    const exports = {};
    const source = _internal.bootstrapSource(entries);
    const compiled = ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2015, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
    } }).outputText;
    vm.runInNewContext(compiled, {
        exports, ...bridges,
        require: name => name === 'cc' ? {
            Component, Node: class {}, _decorator: { ccclass: () => ctor => ctor },
            js: { isChildClassOf: (value, base) => value.prototype instanceof base }, log: line => logs.push(line),
        } : name === 'cc/env' ? { NATIVE: native } : moduleFactory ? moduleFactory(Component) : { Probe },
    });
    const instance = new exports.CocosPluginDevelopmentBootstrap();
    instance.node = { addComponent: component => attached.push(component) };
    return { start: () => instance.start(), attached, logs };
}

test('runtime bootstrap refuses JavaScript fallback before invoking any probe', () => {
    const fixture = runBootstrap([{ name: 'test', nativeClass: 'NativeTest', probePath: 'yes' }]);
    assert.throws(fixture.start, /NativeTest 未注册/);
    assert.equal(fixture.attached.length, 0);
    const browser = runBootstrap([], {}, false);
    assert.throws(browser.start, /Windows 原生插件调试/);
});

test('runtime bootstrap registers the probe and distinguishes registration-only checks', () => {
    const fixture = runBootstrap([
        { name: 'test', nativeClass: 'NativeTest', probePath: 'yes' },
        { name: 'library', nativeClass: 'NativeLibrary', probePath: null },
    ], { NativeTest: {}, NativeLibrary: {} });
    fixture.start();
    assert.equal(fixture.attached.length, 1);
    assert.ok(fixture.logs.some(line => line.includes('不执行业务测试')));
    assert.ok(fixture.logs.some(line => line.includes('测试结果由组件输出')));
});

test('ambiguous or missing test component exports fail explicitly', () => {
    const entries = [{ name: 'test', nativeClass: 'NativeTest', probePath: 'yes' }];
    assert.throws(runBootstrap(entries, { NativeTest: {} }, true, () => ({})).start, /实际找到 0 个/);
    assert.throws(runBootstrap(entries, { NativeTest: {} }, true, Component => ({ One: class extends Component {}, Two: class extends Component {} })).start, /实际找到 2 个/);
});
