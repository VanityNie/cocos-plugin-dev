'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const core = require('../lib/core.cjs');
const android = require('../lib/android.cjs');
const { prepareBinaryPackage } = require('../lib/binary-package.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');
const { deployAndroidBuildFiles } = require('../templates/common/editor/android-build.cjs');

function put(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
}
function descriptor(plugin, runtimeFiles) {
    const file = path.join(plugin.pluginPath, 'plugin-dev.json');
    put(file, { ...support.readJson(file), runtimeFiles });
}
function fixture(t) {
    const local = path.resolve(__dirname, '../.local');
    fs.mkdirSync(local, { recursive: true });
    const root = fs.mkdtempSync(path.join(local, 'android-deployment-'));
    t.after(() => {
        support.inside(local, root);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const host = name => {
        const project = path.join(root, name);
        put(path.join(project, 'package.json'), { name, creator: { version: '3.8.8' } });
        fs.mkdirSync(path.join(project, 'assets'));
        const nativeAndroidDir = path.join(project, 'native/engine/android');
        const buildRoot = path.join(project, 'build/android');
        const assetsDataDir = path.join(buildRoot, 'data');
        const libs = path.join(nativeAndroidDir, 'libs');
        fs.mkdirSync(assetsDataDir, { recursive: true });
        const cmake = put(path.join(nativeAndroidDir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.22)\n');
        const inputs = { nativeAndroidDir, assetsDataDir };
        return { project, buildRoot, libs, assetsDataDir, inputs, cmake,
            deploy: options => deployAndroidBuildFiles(project, { ...inputs, ...options }),
            plugin: (name, linked = false) => core.createPlugin({ projectPath: project, name,
                ...(linked ? { pluginPath: path.join(root, name) } : {}) }),
            manifest: () => support.readJson(path.join(project, '.plugin-dev/android-runtime-binaries.json')),
        };
    };
    return { root, host };
}
function useHooks(t, project, extension) {
    const previous = global.Editor;
    global.Editor = { Project: { path: project } };
    t.after(() => {
        if (previous === undefined) delete global.Editor;
        else global.Editor = previous;
    });
    const { configs } = require(path.join(extension, 'editor/builder.js'));
    return require(path.join(extension, 'editor', configs.android.hooks));
}
function outputKey(directory) {
    return directory.replace(/\\/g, '/').toLowerCase();
}

test('Windows 二进制打包保留运行时文件的平台声明', t => {
    const f = fixture(t).host('host');
    const plugin = f.plugin('windows-runtime');
    const runtimeFiles = [
        'native/third_party/bin/legacy.dll',
        'native/windows/bin/helper.dll',
        'native/windows/lib/runtime/declared.dll',
        'resources/shared.json',
        'resources/all.json',
        'resources/android.json',
    ];
    for (const file of runtimeFiles) put(path.join(plugin.pluginPath, file), file);
    descriptor(plugin, [runtimeFiles[0], runtimeFiles[2], runtimeFiles[3],
        { source: runtimeFiles[4], platform: 'all' }, { source: runtimeFiles[5], platform: 'android' }]);
    core.syncPlugin({ projectPath: f.project, name: plugin.name });
    const info = support.pluginInfo(f.project, plugin.name);
    const expected = [
        ['all.json', 'all'], ['declared.dll', 'windows'], ['helper.dll', 'windows'],
        ['legacy.dll', 'windows'], ['shared.json', undefined],
    ];
    assert.deepEqual(support.collectPackageRuntimeFiles(info.pluginPath, info.meta, 'windows')
        .map(({ target, platform }) => [target, platform]), expected);

    const artifact = put(path.join(f.buildRoot, 'plugin.lib'), 'plugin library');
    const dependency = put(path.join(f.buildRoot, 'dependency.dll'), 'runtime dependency');
    const state = { builtAt: '2026-01-01T00:00:00.000Z', buildType: 'Debug' };
    put(path.join(f.project, '.plugin-dev/windows.json'), state);
    put(path.join(f.project, '.plugin-dev/binary-build.json'), {
        ...state, toolchain: { systemName: 'Windows', pointerSize: 8, architecture: 'x64' },
        plugins: {
            [plugin.name]: {
                target: plugin.target, sourcePath: plugin.pluginPath, nativeFingerprint: support.nativeFingerprint(plugin.pluginPath),
                symbolsVersion: 1, artifact: { source: artifact, sha256: support.hashFile(artifact), symbols: [] },
                runtimeFiles: [{ source: dependency, sha256: support.hashFile(dependency), target: 'dependency.dll' }],
                includeDirectories: [], links: [], options: [], compileOptions: [], compileDefinitions: [],
            },
        },
    });
    const packaged = prepareBinaryPackage({ projectPath: f.project, info });
    expected.push(['dependency.dll', 'windows']);
    assert.deepEqual(JSON.parse(packaged.entries.get('plugin-dev.json')).runtimeFiles, expected.map(([target, platform]) => ({
        target,
        source: `${platform === 'windows' ? 'native/windows/lib/runtime' : 'native/runtime'}/${target}`,
        ...(platform === undefined ? {} : { platform }),
    })));
});

test('修改 native 目录之外的 Android 运行时资源会改变 nativeFingerprint', t => {
    const f = fixture(t).host('host');
    const plugin = f.plugin('android-fingerprint');
    const source = 'resources/choice.json';
    const resource = put(path.join(plugin.pluginPath, source), { choice: 1 });
    descriptor(plugin, [{ source, platform: 'android' }]);
    const fingerprint = support.nativeFingerprint(plugin.pluginPath);
    put(resource, { choice: 2 });
    assert.notEqual(support.nativeFingerprint(plugin.pluginPath), fingerprint);
});

test('Windows 和 Android 校验二进制清单中的所有文件', t => {
    const f = fixture(t).host('host');
    const plugin = f.plugin('binary-integrity');
    const { pluginPath } = plugin;
    const descriptorFile = path.join(pluginPath, 'plugin-dev.json');
    const meta = support.readJson(descriptorFile);
    const runtime = 'native/runtime/config.json';
    for (const [platform, artifact, collectors] of [
        ['windows', 'native/windows/lib/runtime/dep.dll', [support.collectRuntimeFiles]],
        ['android', 'native/android/arm64-v8a/lib/libplugin.a', [support.collectAndroidRuntimeAssets, support.collectAndroidNativeLibs]],
    ]) {
        const distribution = platform === 'windows' ? { platform } : { platforms: [platform] };
        put(descriptorFile, { ...meta, distribution: { type: 'binary', ...distribution } });
        const manifestFile = path.join(pluginPath, 'native', platform, 'binary-manifest.json');
        for (const collect of collectors) assert.throws(() => collect(pluginPath), /缺少二进制文件记录/);

        const files = Object.fromEntries([runtime, artifact].map(file => [file, support.hashFile(put(path.join(pluginPath, file), file))]));
        put(manifestFile, { files });
        for (const collect of collectors) assert.doesNotThrow(() => collect(pluginPath));
        for (const file of [runtime, artifact]) {
            const source = path.join(pluginPath, file);
            fs.appendFileSync(source, 'changed');
            for (const collect of collectors) assert.throws(() => collect(pluginPath), /SHA-256 不匹配/);
            fs.unlinkSync(source);
            for (const collect of collectors) assert.throws(() => collect(pluginPath), /二进制文件不存在/);
            fs.mkdirSync(source);
            for (const collect of collectors) assert.throws(() => collect(pluginPath), /普通文件/);
            fs.rmdirSync(source);
            put(source, file);
        }
        put(manifestFile, { files: { [artifact.replace(/\//g, '\\')]: files[artifact] } });
        for (const collect of collectors) assert.throws(() => collect(pluginPath), /二进制文件记录无效/);
        fs.unlinkSync(manifestFile);
    }
});

test('Android 在 onBeforeMake 部署内嵌和独立插件，切换 ABI 后清理受管库', t => {
    const f = fixture(t).host('host');
    const embedded = f.plugin('embedded-plugin');
    const linked = f.plugin('linked-plugin', true);
    const hooks = useHooks(t, f.project, linked.extensionPath);
    const sourceFiles = [
        [embedded, 'native/android/libs/arm64-v8a/libembedded.so', 'arm64-v8a/libembedded.so'],
        [linked, 'native/third_party/android/armeabi-v7a/dependencies/liblinked.so', 'armeabi-v7a/dependencies/liblinked.so'],
        [embedded, 'native/android/libs/embedded.jar', 'embedded.jar'],
        [linked, 'native/third_party/android/linked.aar', 'linked.aar'],
    ];
    for (const [plugin, source] of sourceFiles) put(path.join(plugin.pluginPath, source), source);
    for (const source of ['native/third_party/bin/helper.dll', 'native/windows/bin/win.dll', 'native/windows/lib/runtime/old.dll',
        'resources/windows.dll', 'resources/embedded.json', 'resources/android.json']) put(path.join(embedded.pluginPath, source), source);
    descriptor(embedded, [
        { source: 'resources/embedded.json', target: 'config/embedded.json', platform: 'all' },
        { source: 'resources/android.json', target: 'config/android.json', platform: 'android' },
        { source: 'resources/windows.dll', platform: 'windows' },
        'native/windows/lib/runtime/old.dll',
    ]);
    put(path.join(linked.pluginPath, 'resources/linked.json'), { source: 'linked' });
    descriptor(linked, [{ source: 'resources', target: 'linked' }]);
    const windowsFiles = support.collectRuntimeFiles(embedded.pluginPath).map(item => item.target);
    assert.equal(windowsFiles.includes('config/android.json'), false);
    assert.equal(windowsFiles.includes('windows.dll'), true);

    const options = { platform: 'android', debug: true };
    assert.equal(hooks.onAfterBuild(options), undefined);
    assert.equal(hooks.onAfterCompressSettings({}, options), undefined);
    assert.equal(hooks.onAfterMake(f.buildRoot, options), undefined);
    assert.equal(fs.existsSync(f.libs), false);
    const first = hooks.onBeforeMake(f.buildRoot, options);
    assert.deepEqual(first.libs, { deployed: 4, removed: 0,
        files: ['arm64-v8a/libembedded.so', 'embedded.jar', 'armeabi-v7a/dependencies/liblinked.so', 'linked.aar'], directory: f.libs });
    assert.equal(first.assets.deployed, 3);
    assert.deepEqual(f.manifest().outputs[outputKey(f.libs)].createdDirectories.sort(),
        ['arm64-v8a', 'armeabi-v7a', 'armeabi-v7a/dependencies']);
    for (const [, source, target] of sourceFiles) assert.equal(fs.readFileSync(path.join(f.libs, target), 'utf8'), source);
    assert.deepEqual(support.walk(f.assetsDataDir).sort(), ['config/android.json', 'config/embedded.json', 'linked/linked.json']);
    assert.equal(fs.readFileSync(f.cmake, 'utf8'), 'cmake_minimum_required(VERSION 3.22)\n');
    assert.equal(fs.existsSync(path.join(f.project, '.plugin-dev/runtime-binaries.json')), false);

    const arm64Only = { ...options, packages: { android: { appABIs: ['arm64-v8a'] } } };
    const filtered = hooks.onBeforeMake(f.buildRoot, arm64Only);
    assert.equal(filtered.libs.deployed, 0);
    assert.equal(filtered.libs.removed, 1);
    assert.equal(fs.existsSync(path.join(f.libs, 'armeabi-v7a')), false);
    const record = f.manifest();
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.managedBy, support.OWNER);
    assert.equal(record.projectPath, f.project);
    const libs = record.outputs[outputKey(f.libs)];
    assert.equal(libs.kind, 'libs');
    assert.deepEqual(libs.createdDirectories, ['arm64-v8a']);
    assert.deepEqual(Object.keys(libs.files).sort(), ['arm64-v8a/libembedded.so', 'embedded.jar', 'linked.aar']);
    assert.equal(record.outputs[outputKey(f.assetsDataDir)].kind, 'assets');
    assert.throws(() => f.deploy({ abis: ['armeabi'] }), /不支持的 Android ABI/);
    assert.throws(() => hooks.onBeforeMake(f.buildRoot, { ...options, packages: { android: { appABIs: 'arm64-v8a' } } }), /ABI 名称数组/);
    assert.deepEqual(f.manifest(), record);
});

test('禁用插件后保留宿主预先创建的空 ABI 目录', t => {
    const f = fixture(t).host('host');
    const plugin = f.plugin('host-directory');
    const abiDirectory = path.join(f.libs, 'arm64-v8a');
    fs.mkdirSync(abiDirectory, { recursive: true });
    assert.deepEqual(fs.readdirSync(abiDirectory), []);
    put(path.join(plugin.pluginPath, 'native/android/libs/arm64-v8a/libplugin.so'), 'plugin library');
    put(path.join(plugin.pluginPath, 'native/third_party/android/arm64-v8a/dependencies/libdep.so'), 'dependency library');
    assert.equal(f.deploy().libs.deployed, 2);
    const key = outputKey(f.libs);
    const record = f.manifest();
    assert.deepEqual(record.outputs[key].createdDirectories, ['arm64-v8a/dependencies']);

    const manifestPath = path.join(f.project, '.plugin-dev/android-runtime-binaries.json');
    put(manifestPath, { ...record, outputs: { ...record.outputs, [key]: { ...record.outputs[key], createdDirectories: ['../arm64-v8a'] } } });
    assert.throws(() => f.deploy(), /无效的运行时目标路径/);
    put(manifestPath, record);

    core.setEnabled({ projectPath: f.project, name: plugin.name, enabled: false });
    assert.equal(f.deploy().libs.removed, 2);
    assert.deepEqual(fs.readdirSync(abiDirectory), []);
    assert.equal(Object.hasOwn(f.manifest().outputs[key], 'createdDirectories'), false);
});

test('共享文件记录全部所有者，解除引用和禁用后保留宿主文件并清理各次构建的受管文件', t => {
    const f = fixture(t).host('host');
    const first = f.plugin('first-plugin', true);
    const second = f.plugin('second-plugin');
    for (const plugin of [first, second]) {
        put(path.join(plugin.pluginPath, 'native/android/libs/arm64-v8a/libshared.so'), 'shared library');
        put(path.join(plugin.pluginPath, 'native/android/libs/host.jar'), 'host library');
        put(path.join(plugin.pluginPath, 'resources/settings.json'), { quality: 'high' });
        descriptor(plugin, [{ source: 'resources/settings.json', target: 'settings.json' }]);
    }
    const hostJar = put(path.join(f.libs, 'host.jar'), 'different host library');
    assert.throws(() => f.deploy(), /拒绝覆盖宿主已有文件/);
    assert.equal(fs.existsSync(path.join(f.libs, 'arm64-v8a')), false);
    assert.deepEqual(fs.readdirSync(f.assetsDataDir), []);
    put(hostJar, 'host library');
    f.deploy();
    const secondDataDir = path.join(f.project, 'build/second/data');
    fs.mkdirSync(secondDataDir, { recursive: true });
    f.deploy({ assetsDataDir: secondDataDir });
    const libFiles = () => f.manifest().outputs[outputKey(f.libs)].files;
    const assetFiles = () => f.manifest().outputs[outputKey(f.assetsDataDir)].files;
    assert.deepEqual(libFiles()['arm64-v8a/libshared.so'].owners, ['first-plugin', 'second-plugin']);
    assert.deepEqual(assetFiles()['settings.json'].owners, ['first-plugin', 'second-plugin']);
    assert.equal(libFiles()['host.jar'].managed, false);

    core.unlinkPlugin({ projectPath: f.project, name: first.name });
    f.deploy();
    assert.deepEqual(libFiles()['arm64-v8a/libshared.so'].owners, ['second-plugin']);
    assert.deepEqual(f.manifest().outputs[outputKey(secondDataDir)].files['settings.json'].owners, ['second-plugin']);
    core.setEnabled({ projectPath: f.project, name: second.name, enabled: false });
    const cleaned = f.deploy();
    assert.equal(cleaned.libs.removed, 1);
    assert.equal(cleaned.assets.removed, 2);
    assert.deepEqual(libFiles(), {});
    assert.deepEqual(assetFiles(), {});
    assert.deepEqual(fs.readdirSync(f.libs), ['host.jar']);
    assert.equal(fs.readFileSync(hostJar, 'utf8'), 'host library');
    assert.deepEqual(fs.readdirSync(secondDataDir), []);
});

test('冲突和手工修改会在写入库、资源和清单之前终止部署', t => {
    const f = fixture(t).host('host');
    const first = f.plugin('first-plugin');
    const second = f.plugin('second-plugin');
    const firstLib = put(path.join(first.pluginPath, 'native/android/libs/arm64-v8a/libshared.so'), 'first library');
    const secondLib = put(path.join(second.pluginPath, 'native/android/libs/arm64-v8a/libshared.so'), 'second library');
    const firstAsset = put(path.join(first.pluginPath, 'settings.json'), { value: 1 });
    const secondAsset = put(path.join(second.pluginPath, 'settings.json'), { value: 2 });
    descriptor(first, ['settings.json']);
    descriptor(second, ['settings.json']);
    assert.throws(() => f.deploy(), /冲突: arm64-v8a\/libshared\.so/);
    fs.copyFileSync(firstLib, secondLib);
    assert.throws(() => f.deploy(), /冲突: settings\.json/);
    assert.equal(fs.existsSync(f.libs), false);
    assert.deepEqual(fs.readdirSync(f.assetsDataDir), []);
    fs.copyFileSync(firstAsset, secondAsset);
    f.deploy();
    const previous = f.manifest();

    put(firstLib, 'updated library');
    put(secondLib, 'updated library');
    const asset = put(path.join(f.assetsDataDir, 'settings.json'), { value: 3 });
    assert.throws(() => f.deploy(), /受管运行时文件包含手工修改/);
    assert.equal(fs.readFileSync(path.join(f.libs, 'arm64-v8a/libshared.so'), 'utf8'), 'first library');
    core.setEnabled({ projectPath: f.project, name: first.name, enabled: false });
    core.setEnabled({ projectPath: f.project, name: second.name, enabled: false });
    assert.throws(() => f.deploy(), /受管运行时文件包含手工修改/);
    assert.deepEqual(f.manifest(), previous);
    fs.copyFileSync(firstAsset, asset);
    assert.equal(f.deploy().libs.removed, 1);
});

test('Android 部署拒绝路径越界、目录联接、缺失文件和重复输出路径', t => {
    const context = fixture(t);
    const f = context.host('host');
    const plugin = f.plugin('protected-plugin');
    put(path.join(plugin.pluginPath, 'native/android/libs/arm64-v8a/libprotected.so'), 'library');
    put(path.join(plugin.pluginPath, 'settings.json'), { value: 1 });
    for (const target of ['../settings.json', 'aux.json']) {
        descriptor(plugin, [{ source: 'settings.json', target }]);
        assert.throws(() => f.deploy(), /无效的运行时目标路径/);
    }
    descriptor(plugin, [{ source: 'settings.json', platform: 'linux' }]);
    assert.throws(() => f.deploy(), /platform 无效/);
    descriptor(plugin, ['missing.json']);
    assert.throws(() => f.deploy(), /声明的运行时文件不存在/);
    descriptor(plugin, [{ source: 'settings.json', target: 'config/settings.json' }]);
    const outside = path.join(context.root, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(f.assetsDataDir, 'config');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.deploy(), /符号链接|目录联接/);
    fs.unlinkSync(link);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.existsSync(f.libs), false);
    const sourceLink = path.join(plugin.pluginPath, 'native/third_party/android/arm64-v8a');
    fs.mkdirSync(path.dirname(sourceLink), { recursive: true });
    fs.symlinkSync(outside, sourceLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.deploy(), /符号链接|目录联接/);
    fs.unlinkSync(sourceLink);

    const hooks = useHooks(t, f.project, plugin.extensionPath);
    assert.throws(() => hooks.onBeforeMake(path.dirname(f.buildRoot), { platform: 'android' }), /data 目录不存在/);
    fs.unlinkSync(f.cmake);
    assert.throws(() => hooks.onBeforeMake(f.buildRoot, { platform: 'android' }), /缺少 CMakeLists.txt/);
    put(f.cmake, 'cmake_minimum_required(VERSION 3.22)\n');
    f.deploy();
    const previous = f.manifest();
    descriptor(plugin, [{ source: 'settings.json', target: 'arm64-v8a/libprotected.so' }]);
    assert.throws(() => f.deploy({ assetsDataDir: f.libs }), /输出目录重叠/);
    descriptor(plugin, [{ source: 'settings.json', target: 'libprotected.so' }]);
    assert.throws(() => f.deploy({ assetsDataDir: path.join(f.libs, 'arm64-v8a') }), /文件路径重叠/);
    descriptor(plugin, [{ source: 'settings.json', target: 'config' }]);
    assert.throws(() => f.deploy(), /文件与目录冲突/);
    descriptor(plugin, [{ source: 'settings.json', target: 'android-runtime-binaries.json' }]);
    assert.throws(() => f.deploy({ assetsDataDir: path.join(f.project, '.plugin-dev') }), /不能覆盖部署记录/);
    assert.deepEqual(f.manifest(), previous);
});

test('Android 二进制依赖按 ABI 和配置选择，并校验已声明的动态库', t => {
    const f = fixture(t).host('host');
    const plugin = f.plugin('binary-config');
    const debug = 'native/android/arm64-v8a/Debug/lib/dependencies/1/libchoice.so';
    const release = 'native/android/arm64-v8a/Release/lib/dependencies/2/libchoice.so';
    const relWithDebInfo = 'native/android/arm64-v8a/RelWithDebInfo/lib/dependencies/3/libchoice.so';
    const unscoped = 'native/android/arm64-v8a/lib/dependencies/4/libcommon.so';
    const excluded = 'native/android/x86/lib/dependencies/5/libexcluded.so';
    const manifestPath = path.join(plugin.pluginPath, 'native/android/binary-manifest.json');
    const files = {};
    for (const file of [debug, release, relWithDebInfo, unscoped, excluded]) {
        files[file] = support.hashFile(put(path.join(plugin.pluginPath, file), file));
    }
    const runtimeLibs = [debug, release, unscoped];
    delete files[relWithDebInfo];
    put(manifestPath, { files, runtimeLibs });
    assert.deepEqual(support.collectAndroidNativeLibs(plugin.pluginPath, undefined, { abis: ['arm64-v8a'], buildType: 'dEbUg' })
        .map(item => item.source), [path.join(plugin.pluginPath, debug), path.join(plugin.pluginPath, unscoped)]);
    assert.equal(f.deploy({ buildType: 'RelWithDebInfo' }).libs.deployed, 2);
    const choice = path.join(f.libs, 'arm64-v8a/libchoice.so');
    assert.equal(fs.readFileSync(choice, 'utf8'), release);
    files[relWithDebInfo] = support.hashFile(path.join(plugin.pluginPath, relWithDebInfo));
    put(manifestPath, { files, runtimeLibs: [...runtimeLibs, relWithDebInfo] });
    assert.equal(f.deploy({ buildType: 'RelWithDebInfo' }).libs.deployed, 1);
    assert.equal(fs.readFileSync(choice, 'utf8'), relWithDebInfo);

    put(manifestPath, { files });
    assert.throws(() => f.deploy(), /插件内部 Android 动态库目标冲突/);
    fs.unlinkSync(path.join(plugin.pluginPath, excluded));
    assert.throws(() => f.deploy({ abis: ['arm64-v8a'], buildType: 'Release' }), /动态库不存在/);
    assert.equal(fs.readFileSync(choice, 'utf8'), relWithDebInfo);
});

test('Android 二进制清单限制 onBeforeMake 使用的构建配置', t => {
    const f = fixture(t).host('host');
    const plugin = f.plugin('single-binary-config');
    const hooks = useHooks(t, f.project, plugin.extensionPath);
    const library = 'native/android/arm64-v8a/lib/dependencies/libchoice.so';
    const files = { [library]: support.hashFile(put(path.join(plugin.pluginPath, library), 'plugin library')) };
    const manifestPath = path.join(plugin.pluginPath, 'native/android/binary-manifest.json');
    const options = { platform: 'android' };
    put(manifestPath, { files, buildType: 'dEbUg' });
    assert.throws(() => hooks.onBeforeMake(f.buildRoot, options), /Android 二进制插件不支持构建配置: Release/);
    assert.equal(fs.existsSync(f.libs), false);
    assert.equal(hooks.onBeforeMake(f.buildRoot, { ...options, debug: true }).libs.deployed, 1);

    put(manifestPath, { files, buildTypes: ['rElEaSe'] });
    assert.throws(() => hooks.onBeforeMake(f.buildRoot, { ...options, debug: true }), /Android 二进制插件不支持构建配置: Debug/);
    assert.equal(f.deploy({ buildType: 'RelWithDebInfo' }).libs.files.length, 1);
    assert.deepEqual(hooks.onBeforeMake(f.buildRoot, options).libs.files, ['arm64-v8a/libchoice.so']);
});

test('发布的 Android 二进制包在独立宿主部署真实 libchoice.so，并拒绝修改过的动态库', {
    skip: process.env.COCOS_PLUGIN_NATIVE_TESTS !== '1', timeout: 180000,
}, async t => {
    const context = fixture(t);
    const build = context.host('binary-host');
    const plugin = build.plugin('published-android', true);
    const tools = (await android.doctor({ projectPath: build.project, abi: 'arm64-v8a' })).tools;
    assert.ok(tools.ndk);
    const compiler = path.join(tools.ndk, 'toolchains/llvm/prebuilt/windows-x86_64/bin/clang++.exe');
    const source = put(path.join(context.root, 'choice.cpp'), 'extern "C" int cpd_choice_value() { return 7; }\n');
    const library = path.join(plugin.pluginPath, 'native/third_party/android/arm64-v8a/libchoice.so');
    fs.mkdirSync(path.dirname(library), { recursive: true });
    execFileSync(compiler, ['--target=aarch64-none-linux-android21', '-fPIC', '-shared', source, '-o', library], { windowsHide: true });
    const unlinked = [
        ['native/android/libs/arm64-v8a/libextra.so', 'native/third_party/android/arm64-v8a/libextra.so'],
        ['native/third_party/android/arm64-v8a/libother.so', 'native/third_party/android/arm64-v8a/libother.so'],
    ];
    for (const [file] of unlinked) {
        const destination = path.join(plugin.pluginPath, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(library, destination);
    }
    put(path.join(plugin.pluginPath, 'native/third_party/CMakeLists.txt'), [
        `target_link_libraries(${plugin.target} PRIVATE "\${CMAKE_CURRENT_LIST_DIR}/android/arm64-v8a/libchoice.so")`, '',
    ].join('\n'));
    put(path.join(plugin.pluginPath, 'resources/choice.json'), { choice: 7 });
    descriptor(plugin, [{ source: 'resources/choice.json', target: 'settings/choice.json', platform: 'android' }]);
    await android.build({ projectPath: build.project, abi: 'arm64-v8a', buildType: 'Debug' });
    const packaged = await core.packagePlugin({ projectPath: build.project, name: plugin.name, binary: true, platform: 'android', abi: 'arm64-v8a' });
    const consumer = context.host('consumer');
    const extension = path.join(consumer.project, 'extensions', plugin.name);
    fs.cpSync(packaged.packagePath, extension, { recursive: true });
    assert.equal(fs.existsSync(path.join(consumer.project, 'extensions/cocos-plugin-dev')), false);
    const hooks = useHooks(t, consumer.project, extension);
    const [relative] = packaged.binaryManifest.runtimeLibs;
    assert.match(relative, /^native\/android\/arm64-v8a\/lib\/dependencies\/[^/]+\/libchoice\.so$/);
    const runtimeLibs = [relative, ...unlinked.map(([, file]) => file)];
    assert.deepEqual(packaged.binaryManifest.runtimeLibs, runtimeLibs);
    assert.deepEqual(Object.keys(packaged.binaryManifest.files).filter(file => file.endsWith('.so')), runtimeLibs);
    const options = { platform: 'android', debug: true, packages: { android: { appABIs: ['arm64-v8a'] } } };
    const deployment = hooks.onBeforeMake(consumer.buildRoot, options);
    assert.equal(deployment.libs.deployed, runtimeLibs.length);
    assert.equal(deployment.assets.deployed, 1);
    assert.deepEqual(support.readJson(path.join(consumer.assetsDataDir, 'settings/choice.json')), { choice: 7 });
    const installedLibrary = path.join(consumer.libs, 'arm64-v8a/libchoice.so');
    assert.equal(support.hashFile(installedLibrary), support.hashFile(library));
    fs.appendFileSync(path.join(extension, relative), 'changed');
    assert.throws(() => hooks.onBeforeMake(consumer.buildRoot, options), /SHA-256 不匹配/);
    assert.equal(support.hashFile(installedLibrary), support.hashFile(library));
});
