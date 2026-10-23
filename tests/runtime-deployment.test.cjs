'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../lib/core.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');
const { deployRuntimeFiles } = require('../templates/common/editor/runtime-deployment.cjs');

function fixture(t) {
    const local = path.resolve(__dirname, '../.local');
    fs.mkdirSync(local, { recursive: true });
    const root = fs.mkdtempSync(path.join(local, 'runtime-deployment-'));
    t.after(() => {
        support.inside(local, root);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const project = path.join(root, 'host');
    const put = (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
        return file;
    };
    put(path.join(project, 'package.json'), { name: 'runtime-deployment-host' });
    fs.mkdirSync(path.join(project, 'assets'));
    const executable = (name = 'output') => {
        const file = path.join(project, name, 'Game.exe');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const source = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32/where.exe') : process.execPath;
        fs.copyFileSync(source, file);
        return file;
    };
    const plugin = (name, embedded = false) => core.createPlugin({ projectPath: project, name,
        ...(embedded ? {} : { pluginPath: path.join(root, name) }) });
    const resource = (pluginInfo, relative = 'config/settings.json', value = { quality: 'high' }) =>
        put(path.join(pluginInfo.pluginPath, 'native/third_party/bin', relative), value);
    const enabled = (name, value) => core.setEnabled({ projectPath: project, name, enabled: value });
    const manifest = () => support.readJson(path.join(project, '.plugin-dev/runtime-binaries.json'));
    const output = (exe) => manifest().outputs[path.dirname(exe).replace(/\\/g, '/').toLowerCase()];
    return { root, project, put, executable, plugin, resource, enabled, manifest, output };
}

test('相同内容的宿主文件保留原有归属，禁用插件后继续存在', t => {
    const f = fixture(t);
    const plugin = f.plugin('host-resource');
    const source = f.resource(plugin);
    const exe = f.executable();
    const destination = f.put(path.join(path.dirname(exe), 'config/settings.json'), fs.readFileSync(source));
    assert.equal(deployRuntimeFiles(f.project, exe).deployed, 0);
    assert.equal(f.output(exe).files['config/settings.json'].managed, false);
    f.enabled('host-resource', false);
    assert.equal(deployRuntimeFiles(f.project, exe).removed, 0);
    assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(source));
    assert.deepEqual(f.output(exe).files, {});
});

test('跨输出目录清理使用各自的创建归属，保留新目录的宿主文件', t => {
    const f = fixture(t);
    const plugin = f.plugin('directory-resource');
    const source = f.resource(plugin);
    const first = f.executable('output-a');
    const second = f.executable('output-b');
    deployRuntimeFiles(f.project, first);
    const hostFile = f.put(path.join(path.dirname(second), 'config/settings.json'), fs.readFileSync(source));
    f.enabled('directory-resource', false);
    assert.equal(deployRuntimeFiles(f.project, second).removed, 1);
    assert.equal(fs.existsSync(path.join(path.dirname(first), 'config/settings.json')), false);
    assert.deepEqual(fs.readFileSync(hostFile), fs.readFileSync(source));
    assert.equal(Object.keys(f.manifest().outputs).length, 2);
});

test('共享资源保存全部插件 owners，最后一个引用解除后清理全部输出目录', t => {
    const f = fixture(t);
    const pluginA = f.plugin('shared-one');
    const pluginB = f.plugin('shared-two', true);
    f.resource(pluginA);
    f.resource(pluginB);
    const first = f.executable('output-a');
    const second = f.executable('output-b');
    deployRuntimeFiles(f.project, first);
    deployRuntimeFiles(f.project, second);
    assert.deepEqual(f.output(first).files['config/settings.json'].owners, ['shared-one', 'shared-two']);
    core.unlinkPlugin({ projectPath: f.project, name: 'shared-one' });
    assert.equal(deployRuntimeFiles(f.project, second).removed, 0);
    assert.deepEqual(f.output(first).files['config/settings.json'].owners, ['shared-two']);
    f.enabled('shared-two', false);
    assert.equal(deployRuntimeFiles(f.project, second).removed, 2);
});

test('其他输出目录保留原构建内容，当前输出目录更新受管资源', t => {
    const f = fixture(t);
    const plugin = f.plugin('resource-upgrade');
    f.resource(plugin, 'settings.json', { version: 1 });
    const first = f.executable('output-a');
    const second = f.executable('output-b');
    deployRuntimeFiles(f.project, first);
    f.resource(plugin, 'settings.json', { version: 2 });
    deployRuntimeFiles(f.project, second);
    assert.equal(support.readJson(path.join(path.dirname(first), 'settings.json')).version, 1);
    assert.equal(support.readJson(path.join(path.dirname(second), 'settings.json')).version, 2);
    assert.equal(deployRuntimeFiles(f.project, first).deployed, 1);
    assert.equal(support.readJson(path.join(path.dirname(first), 'settings.json')).version, 2);
});

test('旧版本归属记录保留备查，不能赋予宿主文件删除权限', t => {
    const f = fixture(t);
    const plugin = f.plugin('legacy-resource');
    const source = f.resource(plugin, 'settings.json');
    const exe = f.executable();
    const destination = f.put(path.join(path.dirname(exe), 'settings.json'), fs.readFileSync(source));
    const legacy = { schemaVersion: 1, files: { 'settings.json': { target: 'settings.json', plugin: 'legacy-resource', sha256: support.hash(fs.readFileSync(source)) } } };
    f.put(path.join(f.project, '.plugin-dev/runtime-binaries.json'), legacy);
    const result = deployRuntimeFiles(f.project, exe);
    assert.equal(result.legacyUnowned, true);
    assert.deepEqual(f.manifest().legacyUnowned, legacy);
    assert.equal(f.output(exe).files['settings.json'].managed, false);
    f.enabled('legacy-resource', false);
    assert.equal(deployRuntimeFiles(f.project, exe).removed, 0);
    assert.ok(fs.existsSync(destination));
});

test('旧版本清单迁移遇到内容不匹配立即终止并保持文件与记录', t => {
    const f = fixture(t);
    const plugin = f.plugin('legacy-change');
    f.resource(plugin, 'settings.json', { version: 2 });
    const exe = f.executable();
    const destination = f.put(path.join(path.dirname(exe), 'settings.json'), { version: 1 });
    const legacy = { schemaVersion: 1, files: { 'settings.json': { target: 'settings.json', plugin: 'legacy-change', sha256: support.hash(fs.readFileSync(destination)) } } };
    f.put(path.join(f.project, '.plugin-dev/runtime-binaries.json'), legacy);
    assert.throws(() => deployRuntimeFiles(f.project, exe), /宿主已有文件/);
    assert.equal(support.readJson(destination).version, 1);
    assert.deepEqual(f.manifest(), legacy);
});

test('插件内容冲突在复制任何文件之前终止', t => {
    const f = fixture(t);
    const first = f.plugin('conflict-one');
    const second = f.plugin('conflict-two');
    f.resource(first, 'settings.json', { version: 1 });
    f.resource(first, 'additional.json', { enabled: true });
    f.resource(second, 'settings.json', { version: 2 });
    const exe = f.executable();
    assert.throws(() => deployRuntimeFiles(f.project, exe), /冲突/);
    assert.equal(fs.existsSync(path.join(path.dirname(exe), 'additional.json')), false);
    assert.equal(fs.existsSync(path.join(f.project, '.plugin-dev/runtime-binaries.json')), false);
});

test('手工修改受管资源时拒绝覆盖以及禁用清理', t => {
    const f = fixture(t);
    const plugin = f.plugin('manual-resource');
    f.resource(plugin, 'settings.json', { version: 1 });
    const exe = f.executable();
    deployRuntimeFiles(f.project, exe);
    const destination = f.put(path.join(path.dirname(exe), 'settings.json'), { version: 3 });
    f.resource(plugin, 'settings.json', { version: 3 });
    assert.throws(() => deployRuntimeFiles(f.project, exe), /手工修改/);
    f.enabled('manual-resource', false);
    assert.throws(() => deployRuntimeFiles(f.project, exe), /手工修改/);
    assert.equal(support.readJson(destination).version, 3);
});

test('其他输出目录存在手工修改时，当前目录的复制与部署记录保持完整', t => {
    const f = fixture(t);
    const plugin = f.plugin('changed-output');
    f.resource(plugin, 'settings.json', { version: 1 });
    const first = f.executable('output-a');
    const second = f.executable('output-b');
    deployRuntimeFiles(f.project, first);
    const record = f.manifest();
    f.put(path.join(path.dirname(first), 'settings.json'), { version: 9 });
    assert.throws(() => deployRuntimeFiles(f.project, second), /手工修改/);
    assert.equal(fs.existsSync(path.join(path.dirname(second), 'settings.json')), false);
    assert.deepEqual(f.manifest(), record);
});

test('宿主已有文件缺失后由插件创建的新文件具有清理归属', t => {
    const f = fixture(t);
    const plugin = f.plugin('recreated-resource');
    const source = f.resource(plugin, 'settings.json');
    const exe = f.executable();
    const destination = f.put(path.join(path.dirname(exe), 'settings.json'), fs.readFileSync(source));
    deployRuntimeFiles(f.project, exe);
    fs.unlinkSync(destination);
    assert.equal(deployRuntimeFiles(f.project, exe).deployed, 1);
    assert.equal(f.output(exe).files['settings.json'].managed, true);
    f.enabled('recreated-resource', false);
    assert.equal(deployRuntimeFiles(f.project, exe).removed, 1);
});

test('运行时文件不能覆盖宿主可执行文件，不能使用文件与目录重叠的目标', t => {
    const f = fixture(t);
    const plugin = f.plugin('protected-target');
    const exe = f.executable();
    const source = f.resource(plugin, 'Game.exe', fs.readFileSync(exe));
    assert.throws(() => deployRuntimeFiles(f.project, exe), /宿主可执行文件/);
    fs.unlinkSync(source);
    f.put(path.join(plugin.pluginPath, 'resources/a.json'), { version: 1 });
    f.put(path.join(plugin.pluginPath, 'resources/b.json'), { version: 2 });
    const metaFile = path.join(plugin.pluginPath, 'plugin-dev.json');
    f.put(metaFile, { ...support.readJson(metaFile), runtimeFiles: [
        { source: 'resources/a.json', target: 'model' },
        { source: 'resources/b.json', target: 'model/metadata.json' },
    ] });
    assert.throws(() => deployRuntimeFiles(f.project, exe), /文件与目录冲突/);
    assert.equal(fs.existsSync(path.join(path.dirname(exe), 'model')), false);
});

test('输出目录联接与部署记录路径越界在写入之前终止', t => {
    const f = fixture(t);
    const plugin = f.plugin('linked-target');
    f.resource(plugin);
    const exe = f.executable();
    const external = path.join(f.root, 'external');
    fs.mkdirSync(external);
    const link = path.join(path.dirname(exe), 'config');
    fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => deployRuntimeFiles(f.project, exe), /符号链接|目录联接/);
    assert.deepEqual(fs.readdirSync(external), []);
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(f.root, 'missing'), link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => deployRuntimeFiles(f.project, exe), /符号链接|目录联接/);
    fs.unlinkSync(link);
    deployRuntimeFiles(f.project, exe);
    const record = f.manifest();
    const files = record.outputs[path.dirname(exe).replace(/\\/g, '/').toLowerCase()].files;
    files['../external.json'] = { ...files['config/settings.json'], target: '../external.json' };
    f.put(path.join(f.project, '.plugin-dev/runtime-binaries.json'), record);
    assert.throws(() => deployRuntimeFiles(f.project, exe), /目标路径无效/);
});

test('真实 DLL 的宿主原文件在插件禁用后保持完整', { skip: !process.env.CPD_TEST_RUNTIME_DLL }, t => {
    const f = fixture(t);
    const plugin = f.plugin('native-dll');
    const bytes = fs.readFileSync(process.env.CPD_TEST_RUNTIME_DLL);
    f.resource(plugin, 'zlib1.dll', bytes);
    const exe = f.executable();
    const hostDll = f.put(path.join(path.dirname(exe), 'zlib1.dll'), bytes);
    assert.equal(deployRuntimeFiles(f.project, exe).deployed, 0);
    f.enabled('native-dll', false);
    assert.equal(deployRuntimeFiles(f.project, exe).removed, 0);
    assert.equal(support.hash(fs.readFileSync(hostDll)), support.hash(bytes));
});
