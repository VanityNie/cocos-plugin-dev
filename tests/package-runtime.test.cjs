'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../lib/core.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');

function fixture(t) {
    const local = path.resolve(__dirname, '../.local');
    fs.mkdirSync(local, { recursive: true });
    const root = fs.mkdtempSync(path.join(local, 'package-runtime-'));
    t.after(() => {
        support.inside(local, root);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const put = (file, value) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
        return file;
    };
    const host = name => {
        const project = path.join(root, name);
        put(path.join(project, 'package.json'), { name });
        fs.mkdirSync(path.join(project, 'assets'));
        return project;
    };
    return { root, put, host };
}

test('发布包及独立插件适配目录包含完整构建入口，并独立部署资源', async t => {
    const f = fixture(t);
    const project = f.host('development-host');
    const plugin = core.createPlugin({ projectPath: project, pluginPath: path.join(f.root, 'source'), name: 'published-runtime' });
    const settings = { model: 'sample-model', quality: 'high' };
    f.put(path.join(plugin.pluginPath, 'resources/settings.json'), settings);
    const descriptorPath = path.join(plugin.pluginPath, 'plugin-dev.json');
    f.put(descriptorPath, { ...support.readJson(descriptorPath), runtimeFiles: [{ source: 'resources/settings.json', target: 'config/settings.json' }] });
    const packaged = await core.packagePlugin({ projectPath: project, name: plugin.name });
    const helpers = ['plugin-support.cjs', 'builder.js', 'build-hooks.cjs', 'runtime-deployment.cjs', 'runtime-build.cmake', 'deploy-runtime.cjs', 'windows-build.cjs', 'windows-build.cmake', 'typescript-plugin.cjs'];
    for (const directory of [plugin.extensionPath, packaged.packagePath]) {
        const pkg = support.readJson(path.join(directory, 'package.json'));
        assert.equal(pkg.contributions.builder, './editor/builder.js');
        const builder = require(path.join(directory, pkg.contributions.builder));
        const hooks = require(path.join(directory, 'editor', builder.configs.windows.hooks));
        for (const name of ['onBeforeBuild', 'onAfterCompressSettings', 'onAfterBuild', 'onBeforeMake', 'onAfterMake']) assert.equal(typeof hooks[name], 'function');
        for (const file of helpers) {
            const source = fs.readFileSync(path.join(directory, 'editor', file), 'utf8');
            assert.equal(source.includes('{{NAME}}'), false, file);
        }
    }
    const installation = f.host('installation-host');
    const destination = path.join(installation, 'extensions', plugin.name);
    fs.cpSync(packaged.packagePath, destination, { recursive: true });
    const nativeSourceDir = path.join(installation, 'native/engine/win64');
    fs.mkdirSync(nativeSourceDir, { recursive: true });
    const hook = require(path.join(destination, 'editor/windows-build.cjs')).ensureWindowsBuildHook(installation, nativeSourceDir);
    assert.equal(fs.readFileSync(hook.hookPath, 'utf8').includes(f.root.replace(/\\/g, '/')), false);
    const executable = path.join(installation, 'build/Game.exe');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32/where.exe') : process.execPath, executable);
    const deployment = require(path.join(installation, '.plugin-dev/native-build/runtime-deployment.cjs'));
    assert.equal(deployment.deployRuntimeFiles(installation, executable).deployed, 1);
    assert.deepEqual(support.readJson(path.join(path.dirname(executable), 'config/settings.json')), settings);
    assert.equal(fs.existsSync(path.join(packaged.packagePath, '.local')), false);
});

test('声明的运行时资源被发布过滤规则排除时拒绝生成包', async t => {
    const f = fixture(t);
    const project = f.host('filtered-host');
    const plugin = core.createPlugin({ projectPath: project, pluginPath: path.join(f.root, 'source'), name: 'filtered-runtime' });
    const descriptorPath = path.join(plugin.pluginPath, 'plugin-dev.json');
    const descriptor = support.readJson(descriptorPath);
    for (const source of ['.local/settings.json', 'build/settings.json', 'node_modules/settings.json', 'resources/settings.log']) {
        f.put(path.join(plugin.pluginPath, source), { quality: 'high' });
        f.put(descriptorPath, { ...descriptor, runtimeFiles: [{ source, target: 'config/settings.json' }] });
        await assert.rejects(() => core.packagePlugin({ projectPath: project, name: plugin.name }), /运行时文件未包含在发布包中/);
        assert.equal(fs.existsSync(path.join(project, '.plugin-dev/packages')), false);
    }
});

test('旧插件的发布副本获得完整构建支持，并保留源码和自定义编辑器入口', async t => {
    const f = fixture(t);
    const project = f.host('upgraded-package-host');
    const plugin = core.createPlugin({ projectPath: project, pluginPath: path.join(f.root, 'source'), name: 'upgraded-runtime' });
    const packagePath = path.join(plugin.pluginPath, 'package.json');
    const pkg = support.readJson(packagePath);
    delete pkg.contributions.builder;
    pkg.contributions.menu = [{ path: 'Developer', label: 'Custom', message: 'sync' }];
    pkg.author = 'Plugin developer';
    f.put(packagePath, pkg);
    const mainPath = path.join(plugin.pluginPath, 'editor/main.js');
    fs.appendFileSync(mainPath, '\nexports.customSetting = true;\n');
    const sourceMain = fs.readFileSync(mainPath);
    const sourcePackage = fs.readFileSync(packagePath);
    fs.unlinkSync(path.join(plugin.pluginPath, 'editor/builder.js'));
    fs.unlinkSync(path.join(plugin.pluginPath, 'editor/build-hooks.cjs'));
    const packaged = await core.packagePlugin({ projectPath: project, name: plugin.name });
    const publishedPackage = support.readJson(path.join(packaged.packagePath, 'package.json'));
    assert.equal(publishedPackage.contributions.builder, './editor/builder.js');
    assert.deepEqual(publishedPackage.contributions.menu, pkg.contributions.menu);
    assert.equal(publishedPackage.author, pkg.author);
    assert.deepEqual(fs.readFileSync(path.join(packaged.packagePath, 'editor/main.js')), sourceMain);
    const builder = require(path.join(packaged.packagePath, publishedPackage.contributions.builder));
    const hooks = require(path.join(packaged.packagePath, 'editor', builder.configs.windows.hooks));
    assert.equal(typeof hooks.onBeforeMake, 'function');
    assert.deepEqual(fs.readFileSync(mainPath), sourceMain);
    assert.deepEqual(fs.readFileSync(packagePath), sourcePackage);
    assert.equal(fs.existsSync(path.join(plugin.pluginPath, 'editor/builder.js')), false);
    assert.equal(fs.existsSync(path.join(plugin.pluginPath, 'editor/build-hooks.cjs')), false);
});

test('发布包缺少已声明的编辑器入口时立即报错', async t => {
    const f = fixture(t);
    const project = f.host('missing-entry-host');
    const plugin = core.createPlugin({ projectPath: project, pluginPath: path.join(f.root, 'source'), name: 'missing-entry' });
    const packagePath = path.join(plugin.pluginPath, 'package.json');
    f.put(packagePath, { ...support.readJson(packagePath), main: './editor/missing-main.js' });
    await assert.rejects(() => core.packagePlugin({ projectPath: project, name: plugin.name }), /编辑器入口未包含在发布包中/);
    assert.equal(fs.existsSync(path.join(project, '.plugin-dev/packages')), false);
});

test('无效的目录链接不能作为运行时来源或 CMake hook 输出目录', async t => {
    const f = fixture(t);
    const project = f.host('broken-link-host');
    const plugin = core.createPlugin({ projectPath: project, pluginPath: path.join(f.root, 'source'), name: 'linked-runtime' });
    const missing = path.join(f.root, 'missing-destination');
    const link = path.join(plugin.pluginPath, 'native/third_party/bin');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(missing, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(fs.existsSync(link), false);
    assert.throws(() => support.collectRuntimeFiles(plugin.pluginPath), /符号链接|目录联接/);
    await assert.rejects(() => core.packagePlugin({ projectPath: project, name: plugin.name }), /符号链接|目录联接/);
    const nativeSourceDir = path.join(project, 'native/engine/win64');
    fs.mkdirSync(nativeSourceDir, { recursive: true });
    fs.symlinkSync(missing, path.join(project, '.plugin-dev/native-build'), process.platform === 'win32' ? 'junction' : 'dir');
    const { ensureWindowsBuildHook } = require('../templates/common/editor/windows-build.cjs');
    assert.throws(() => ensureWindowsBuildHook(project, nativeSourceDir), /符号链接|目录联接/);
    assert.equal(fs.existsSync(missing), false);
});
