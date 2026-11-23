'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const binary = require('../lib/binary-artifacts.cjs');
const core = require('../lib/core.cjs');
const windows = require('../lib/windows.cjs');
const android = require('../lib/android.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');

const name = 'slot-plugin';
const arm = 'arm64-v8a';
const x64 = 'x86_64';
const metadata = path.resolve(__dirname, '../lib/cmake/binary-build.cmake');

function fixture(t) {
    const local = path.resolve(__dirname, '../.local');
    fs.mkdirSync(local, { recursive: true });
    const root = fs.mkdtempSync(path.join(local, 'binary-slots-'));
    t.after(() => {
        support.noLinks(local, root);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const projectPath = path.join(root, 'producer');
    const enginePath = path.join(root, 'engine');
    fs.cpSync(path.join(__dirname, 'fixtures/binary-slots'), projectPath, { recursive: true });
    fs.mkdirSync(path.join(projectPath, 'assets'));
    fs.mkdirSync(path.join(enginePath, 'native'), { recursive: true });
    support.writeJson(path.join(projectPath, 'package.json'), { name: 'binary-slots' });
    support.writeJson(path.join(enginePath, 'package.json'), { version: '3.8.8' });
    const plugin = core.createPlugin({ projectPath, name });
    const includePath = path.join(plugin.pluginPath, 'native/include');
    fs.cpSync(path.join(projectPath, 'native/include'), includePath, { recursive: true });
    const stateFile = path.join(projectPath, '.plugin-dev/state.json');
    const records = {};
    const sync = () => {
        core.syncPlugin({ projectPath, name });
        records[name] = support.readJson(stateFile).plugins[name];
    };
    sync();
    const read = options => binary.readMultiBinaryArtifacts({ projectPath, name, platforms: 'all', buildTypes: 'all', abis: 'all', ...options });
    const proofPath = (buildType, abi) => path.join(projectPath, '.plugin-dev/binary-slots', abi ? `android/${abi}` : 'windows', buildType, 'proof.json');
    return { root, projectPath, enginePath, records, stateFile, read, proofPath, plugin, includePath, sync };
}

function run(command, args, env, expectedError) {
    const result = spawnSync(command, args, { env, encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (expectedError) {
        assert.notEqual(result.status, 0, output);
        assert.match(output, expectedError);
    } else {
        assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${output}`);
    }
}

test('多配置读取检查插件状态、缺失记录和构建错误', t => {
    const f = fixture(t);
    assert.throws(() => f.read(), /缺少构建记录/);
    assert.throws(() => f.read({ platforms: ['windows'], buildTypes: ['Debug'] }), /windows Debug.*缺少 proof.json/);
    const state = { projectPath: f.projectPath, buildDir: path.join(f.root, 'empty'), buildType: 'Debug', builtAt: new Date().toISOString() };
    binary.recordBinaryBuild(state, f.records);
    assert.deepEqual(support.readJson(f.proofPath('Debug')), support.readJson(path.join(f.projectPath, '.plugin-dev/binary-build.json')));
    assert.throws(() => f.read(), /windows Debug.*CMake/);
    binary.recordAndroidBinaryBuild({ ...state, abi: arm }, f.records);
    assert.deepEqual(support.readJson(f.proofPath('Debug', arm)), support.readJson(path.join(f.projectPath, `.plugin-dev/binary-build-android-${arm}.json`)));
    assert.throws(() => f.read({ platforms: ['android'] }), /android arm64-v8a Debug.*CMake/);
    support.writeJson(f.stateFile, { schemaVersion: 1, plugins: { [name]: { ...f.records[name], detached: true } } });
    assert.throws(() => f.read(), /需要启用/);
});

test('真实 Ninja 构建跨配置保留制品，生成的 CMake 能链接并检查配置与 ABI', {
    skip: process.env.COCOS_PLUGIN_NATIVE_TESTS !== '1', timeout: 180000,
}, async t => {
    const f = fixture(t);
    const windowsTools = (await windows.doctor({ projectPath: f.projectPath })).tools;
    const androidTools = (await android.doctor({ projectPath: f.projectPath })).tools;
    assert.ok(windowsTools.cmake && windowsTools.ninja && windowsTools.vsDevCmd);
    assert.ok(androidTools.cmake && androidTools.ninja && androidTools.ndkToolchain);
    const { execute, parseEnvironment, vsBootstrapCommand } = windows._internal;
    const environment = await execute(process.env.ComSpec, ['/d', '/u', '/s', '/v:off', '/c', vsBootstrapCommand(windowsTools.vsDevCmd)],
        { windowsVerbatimArguments: true, outputEncoding: 'utf-16le' });
    const env = { ...parseEnvironment(environment.output), VSLANG: '1033' };
    const cmake = (abi, args, expectedError) => run(abi ? androidTools.cmake : windowsTools.cmake, args, abi ? process.env : env, expectedError);
    const configure = (source, build, abi, buildType, args = [], expectedError, generator = 'Ninja') => cmake(abi, [
        '-S', source, '-B', build, '-G', generator, `-DCMAKE_BUILD_TYPE=${buildType}`,
        `-DCMAKE_MAKE_PROGRAM=${abi ? androidTools.ninja : windowsTools.ninja}`,
        `-DCOCOS_X_PATH=${path.join(f.enginePath, 'native')}`,
        `-DSLOT_PLUGIN_TARGET=${f.plugin.target}`, `-DSLOT_PLUGIN_INCLUDE=${f.includePath}`,
        ...(abi ? [`-DCMAKE_TOOLCHAIN_FILE=${androidTools.ndkToolchain}`, `-DANDROID_ABI=${abi}`, '-DANDROID_PLATFORM=android-21', '-DANDROID_STL=c++_static'] : []),
        ...args,
    ], expectedError);
    const runtime = path.join(f.root, 'runtime');
    configure(f.projectPath, runtime, undefined, 'Debug', ['-DSLOT_RUNTIME_ONLY=ON']);
    cmake(undefined, ['--build', runtime]);
    const extraRuntime = path.join(f.root, 'extra-runtime');
    configure(f.projectPath, extraRuntime, arm, 'Release', ['-DSLOT_RUNTIME_ONLY=ON', '-DSLOT_RUNTIME_NAME=slot_extra']);
    cmake(arm, ['--build', extraRuntime]);
    const thirdParty = `native/third_party/android/${arm}/libslot_extra.so`;
    fs.mkdirSync(path.dirname(path.join(f.plugin.pluginPath, thirdParty)), { recursive: true });
    fs.copyFileSync(path.join(extraRuntime, 'libslot_extra.so'), path.join(f.plugin.pluginPath, thirdParty));
    const descriptor = path.join(f.plugin.pluginPath, 'plugin-dev.json');
    const runtimeAssets = [
        { source: 'resources/shared.json', target: 'settings/shared.json', platform: 'all' },
        { source: 'resources/windows.json', target: 'settings/platform.json', platform: 'windows' },
        { source: 'resources/android.json', target: 'settings/platform.json', platform: 'android' },
    ];
    for (const { source } of runtimeAssets) support.writeJson(path.join(f.plugin.pluginPath, source), { source });
    support.writeJson(descriptor, { ...support.readJson(descriptor), runtimeFiles: runtimeAssets });
    f.sync();

    const build = (buildType, abi, runtimeDir = runtime) => {
        const buildDir = path.join(f.projectPath, '.plugin-dev/build', abi ? `android/${abi}` : 'windows');
        const query = path.join(buildDir, '.cmake/api/v1/query');
        fs.mkdirSync(query, { recursive: true });
        fs.writeFileSync(path.join(query, 'codemodel-v2'), '');
        configure(f.projectPath, buildDir, abi, buildType, [`-DSLOT_METADATA=${metadata}`, `-DSLOT_RUNTIME_DIR=${runtimeDir.replace(/\\/g, '/')}`]);
        cmake(abi, ['--build', buildDir]);
        const state = { projectPath: f.projectPath, enginePath: f.enginePath, tools: abi ? androidTools : windowsTools,
            buildDir, buildType, builtAt: new Date().toISOString(), ...(abi ? { abi, ndkVersion: androidTools.ndkVersion, androidPlatform: 'android-21', androidStl: 'c++_static' } : {}) };
        if (abi) binary.recordAndroidBinaryBuild(state, f.records);
        else binary.recordBinaryBuild(state, f.records);
        return support.readJson(abi ? path.join(f.projectPath, `.plugin-dev/binary-build-android-${abi}.json`) : path.join(f.projectPath, '.plugin-dev/binary-build.json'));
    };

    const windowsDebug = build('Debug').plugins[name].artifact;
    const androidDebug = build('Debug', arm).plugins[name].artifact;
    assert.equal(build('Release').plugins[name].artifact.source, windowsDebug.source);
    assert.equal(build('Release', arm).plugins[name].artifact.source, androidDebug.source);
    build('Release', x64);
    for (const [abi, original] of [[undefined, windowsDebug], [arm, androidDebug]]) {
        assert.notEqual(support.hashFile(original.source), original.sha256);
        const staged = support.readJson(f.proofPath('Debug', abi)).plugins[name].artifact;
        assert.equal(support.hashFile(staged.source), original.sha256);
        assert.equal(path.basename(staged.source), path.basename(original.source));
    }

    const result = f.read({ includeDirectoriesByPlatform: { windows: ['lib/include/plugin'] } });
    assert.deepEqual(result.platforms, ['windows', 'android']);
    assert.equal(result.engineVersion, '3.8.8');
    assert.deepEqual(result.android.abis, [arm, x64]);
    assert.equal(result.runtimeFiles.length, 1);
    assert.equal(result.runtimeFiles[0].packagePath, 'native/windows/lib/runtime/slot_shared.dll');
    assert.ok(result.windows.files.some(file => file.packagePath === 'native/windows/lib/Debug/slot_plugin.pdb'));
    assert.ok(result.windows.files.some(file => /lib\/Debug\/dependencies\/[a-f0-9]{16}\/slot_dependency\.pdb$/.test(file.packagePath)));
    for (const entry of [result.windows, result.android]) {
        assert.match(entry.cmake, /IMPORTED_CONFIGURATIONS "DEBUG;RELEASE"/);
        assert.match(entry.cmake, /IMPORTED_LOCATION_DEBUG/);
        assert.match(entry.cmake, /IMPORTED_LOCATION_RELEASE/);
        assert.match(entry.cmake, /MAP_IMPORTED_CONFIG_RELWITHDEBINFO Release/);
        assert.doesNotMatch(entry.cmake, /MAP_IMPORTED_CONFIG_DEBUG Release|MAP_IMPORTED_CONFIG_RELEASE Debug/);
        assert.match(entry.cmake, /target_link_libraries.*\$<OR:\$<CONFIG:Release>,\$<CONFIG:RelWithDebInfo>>/);
        assert.match(entry.cmake, /target_compile_definitions.*\$<OR:\$<CONFIG:Release>,\$<CONFIG:RelWithDebInfo>>:SLOT_VALUE=22/);
    }
    assert.match(result.windows.cmake, /target_link_options.*WHOLEARCHIVE:/);
    assert.match(result.windows.cmake, /VERSION_EQUAL/);
    assert.match(result.windows.cmake, /VERSION_LESS/);
    assert.match(result.android.cmake, /if\(ANDROID_ABI STREQUAL "x86_64"\)/);
    assert.match(result.android.cmake, /target_link_libraries.*:-Wl,--whole-archive>" "\$<[^"]+:\$\{CMAKE_CURRENT_LIST_DIR\}\/[^"]+\.a>" "\$<[^"]+:-Wl,--no-whole-archive>"/);
    assert.doesNotMatch(result.android.cmake, /LINK_LIBRARY:WHOLE_ARCHIVE/);
    assert.throws(() => f.read({ platforms: ['android'], abis: [arm, x64], buildTypes: ['Debug', 'Release'] }), /android x86_64 Debug/);

    const packaged = await core.packagePlugin({ projectPath: f.projectPath, name, binary: true, platform: 'all', buildType: 'all', abi: 'all' });
    assert.equal(path.basename(packaged.zipPath), `${name}-${packaged.version}-universal-binary.zip`);
    const windowsPackage = await core.packagePlugin({ projectPath: f.projectPath, name, binary: true, buildType: ['Debug', 'Release'] });
    assert.match(windowsPackage.zipPath, /-windows-x64-Debug\+Release\.zip$/);
    const androidPackage = await core.packagePlugin({ projectPath: f.projectPath, name, binary: true, platform: ['android'], abi: `${arm},${x64}` });
    assert.match(androidPackage.zipPath, /-android-arm64-v8a\+x86_64-Debug\+Release\.zip$/);
    const consumerProject = path.join(f.root, 'creator-consumer');
    const extensions = path.join(consumerProject, 'extensions');
    fs.mkdirSync(extensions, { recursive: true });
    run('tar.exe', ['-xf', packaged.zipPath, '-C', extensions], process.env);
    const publication = path.join(extensions, name);
    const publishedDescriptor = support.readJson(path.join(publication, 'plugin-dev.json'));
    assert.deepEqual(publishedDescriptor.distribution, {
        type: 'binary', platforms: ['windows', 'android'],
        windows: { buildTypes: ['Debug', 'Release'] },
        android: { abis: [arm, x64], buildTypes: ['Debug', 'Release'] },
    });
    const bySource = (a, b) => a.source.localeCompare(b.source);
    assert.deepEqual(publishedDescriptor.runtimeFiles.toSorted(bySource), [
        { source: 'native/runtime/settings/shared.json', target: 'settings/shared.json' },
        { source: 'native/windows/lib/runtime/settings/platform.json', target: 'settings/platform.json', platform: 'windows' },
        { source: 'native/runtime/settings/platform.json', target: 'settings/platform.json', platform: 'android' },
        { source: 'native/windows/lib/runtime/slot_shared.dll', target: 'slot_shared.dll', platform: 'windows' },
    ].sort(bySource));
    assert.equal(fs.existsSync(path.join(publication, 'resources')), false);
    for (const platform of ['windows', 'android']) {
        const manifest = support.readJson(path.join(publication, `native/${platform}/binary-manifest.json`));
        assert.deepEqual(manifest, packaged.binaryManifests[platform]);
        for (const [file, sha256] of Object.entries(manifest.files)) assert.equal(support.hashFile(path.join(publication, file)), sha256, file);
        assert.ok(fs.existsSync(path.join(publication, result[platform].configPath)));
        assert.ok(fs.existsSync(path.join(publication, `native/${platform}/lib/include/plugin/slot.h`)));
    }
    const parserEngine = process.env.COCOS_PLUGIN_TEST_ENGINE
        || path.join(path.dirname(windowsTools.creator), 'resources/resources/3d/engine');
    const parser = path.join(parserEngine, 'native/cmake/scripts/plugins_parser.js');
    const searchPaths = path.join(consumerProject, 'search-paths.txt');
    fs.writeFileSync(searchPaths, `${extensions}\n`);
    for (const [platform, pattern] of [['windows', /\/windows\/x86_64/], ['android', /\/android\/\$\{ANDROID_ABI\}/]]) {
        const discovered = path.join(consumerProject, `${platform}-plugins.cmake`);
        run(process.execPath, [parser, searchPaths, discovered, platform], process.env);
        const cmake = fs.readFileSync(discovered, 'utf8');
        assert.ok(cmake.includes(`find_package(${f.plugin.target}`));
        assert.match(cmake, pattern);
    }

    support.writeJson(path.join(consumerProject, 'package.json'), { name: 'binary-consumer' });
    fs.mkdirSync(path.join(consumerProject, 'assets'));
    const nativeAndroid = path.join(consumerProject, 'native/engine/android');
    fs.mkdirSync(nativeAndroid, { recursive: true });
    fs.writeFileSync(path.join(nativeAndroid, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.24)\n');
    const creatorBuild = path.join(consumerProject, 'build/android');
    fs.mkdirSync(path.join(creatorBuild, 'data'), { recursive: true });
    const previousEditor = global.Editor;
    global.Editor = { Project: { path: consumerProject } };
    t.after(() => {
        if (previousEditor === undefined) delete global.Editor;
        else global.Editor = previousEditor;
    });
    const { configs } = require(path.join(publication, 'editor/builder.js'));
    const hooks = require(path.join(publication, 'editor', configs.android.hooks));
    const options = { platform: 'android', packages: { android: { appABIs: [arm, x64] } } };
    const deployment = hooks.onBeforeMake(creatorBuild, options);
    assert.equal(deployment.libs.deployed, 3);
    assert.equal(deployment.assets.deployed, 2);
    for (const item of support.collectAndroidNativeLibs(publication, undefined, { abis: [arm, x64], buildType: 'Release' })) {
        assert.equal(support.hashFile(path.join(nativeAndroid, 'libs', item.target)), item.sha256);
    }
    for (const asset of [runtimeAssets[0], runtimeAssets[2]]) {
        assert.deepEqual(support.readJson(path.join(creatorBuild, 'data', asset.target)), { source: asset.source });
    }
    assert.equal(fs.existsSync(path.join(creatorBuild, 'data/slot_shared.dll')), false);
    assert.equal(hooks.onBeforeMake(creatorBuild, options).libs.deployed, 0);

    const armRelease = result.android.manifest.runtimeLibs.find(file => file.startsWith(`native/android/${arm}/Release/`));
    const collect = () => support.collectAndroidNativeLibs(publication, undefined, { abis: [arm], buildType: 'RelWithDebInfo' });
    assert.deepEqual(collect().map(item => path.relative(publication, item.source).replace(/\\/g, '/')).sort(), [armRelease, thirdParty].sort());

    const consumer = path.join(f.root, 'consumer');
    fs.cpSync(path.join(__dirname, 'fixtures/binary-slots'), consumer, { recursive: true });
    const consume = (abi, buildType, value, extra = [], buildError, configureError) => {
        const buildDir = path.join(f.root, 'consumer-build', `${abi || 'windows'}-${buildType}-${extra.length}`);
        const entry = abi ? result.android : result.windows;
        configure(consumer, buildDir, abi, buildType,
            [`-DSLOT_PACKAGE_CONFIG=${path.join(publication, entry.configPath)}`, `-DSLOT_EXPECTED=${value}`, ...extra], configureError);
        if (!configureError) cmake(abi, ['--build', buildDir], buildError);
        return buildDir;
    };
    for (const [abi, buildType, value] of [[undefined, 'Debug', 11], [undefined, 'RelWithDebInfo', 22], [arm, 'Debug', 11], [arm, 'RelWithDebInfo', 22], [x64, 'Release', 22]]) {
        const buildDir = consume(abi, buildType, value);
        if (!abi) {
            fs.copyFileSync(path.join(publication, result.runtimeFiles[0].packagePath), path.join(buildDir, 'slot_shared.dll'));
            run(path.join(buildDir, 'slot_consumer.exe'), [], env);
        }
    }
    consume(undefined, 'Debug', 11, ['-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL'], /MSVC runtime/);
    consume(x64, 'Debug', 11, [], /不支持构建配置 Debug/);
    consume('x86', 'Release', 22, [], undefined, /Android ABI/);
    const multiBuild = path.join(f.root, 'consumer-build/windows-multi');
    configure(consumer, multiBuild, undefined, '', [
        `-DSLOT_PACKAGE_CONFIG=${path.join(publication, result.windows.configPath)}`,
        '-DSLOT_EXPECTED=$<IF:$<CONFIG:Debug>,11,22>',
        '-DCMAKE_CONFIGURATION_TYPES=Debug;Release;RelWithDebInfo;MinSizeRel',
        '-DCMAKE_MAP_IMPORTED_CONFIG_DEBUG=Release',
    ], undefined, 'Ninja Multi-Config');
    for (const buildType of ['Debug', 'Release', 'RelWithDebInfo']) {
        cmake(undefined, ['--build', multiBuild, '--config', buildType]);
        const output = path.join(multiBuild, buildType);
        fs.copyFileSync(path.join(publication, result.runtimeFiles[0].packagePath), path.join(output, 'slot_shared.dll'));
        run(path.join(output, 'slot_consumer.exe'), [], env);
    }
    cmake(undefined, ['--build', multiBuild, '--config', 'MinSizeRel'], /不支持构建配置 MinSizeRel/);

    fs.appendFileSync(path.join(publication, thirdParty), '\n');
    assert.throws(collect, /SHA-256 不匹配.*libslot_extra\.so/);
    fs.copyFileSync(path.join(extraRuntime, 'libslot_extra.so'), path.join(publication, thirdParty));
    const excludedArchive = result.android.files.find(file => file.packagePath.startsWith(`native/android/${x64}/`) && /\.a$/.test(file.packagePath));
    fs.unlinkSync(path.join(publication, excludedArchive.packagePath));
    assert.throws(collect, /二进制文件不存在.*x86_64/);

    const releaseProof = f.proofPath('Release');
    const windowsRelease = support.readJson(releaseProof);
    const snapshot = windowsRelease.plugins[name];
    support.writeJson(releaseProof, { ...windowsRelease, plugins: { [name]: { ...snapshot, nativeFingerprint: 'stale' } } });
    assert.throws(() => f.read(), /windows Release.*已过期/);
    assert.throws(() => f.read({ platforms: ['windows'], buildTypes: ['Debug', 'Release'] }), /windows Release.*已过期/);
    support.writeJson(releaseProof, { ...windowsRelease, plugins: { [name]: { ...snapshot, error: '无效构建产物' } } });
    assert.throws(() => f.read(), /windows Release.*无效构建产物/);
    support.writeJson(releaseProof, windowsRelease);
    const versionProof = f.proofPath('Release', x64);
    const androidRelease = support.readJson(versionProof);
    support.writeJson(versionProof, { ...androidRelease, engineVersion: '3.8.9' });
    assert.throws(() => f.read(), /engineVersion 不一致.*android x86_64 Release/);
    support.writeJson(versionProof, androidRelease);
    for (const [abi, buildType] of [[undefined, 'Release'], [arm, 'Debug']]) {
        const staged = support.readJson(f.proofPath(buildType, abi)).plugins[name].artifact.source;
        const bytes = fs.readFileSync(staged);
        fs.appendFileSync(staged, '\n');
        assert.throws(() => f.read(), /暂存产物 SHA-256 不匹配/);
        fs.writeFileSync(staged, bytes);
    }
    build('RelWithDebInfo');
    assert.doesNotMatch(f.read().windows.cmake, /MAP_IMPORTED_CONFIG_RELWITHDEBINFO Release/);
    const changedRuntime = path.join(f.root, 'changed-runtime');
    configure(f.projectPath, changedRuntime, undefined, 'Release', ['-DSLOT_RUNTIME_ONLY=ON']);
    cmake(undefined, ['--build', changedRuntime]);
    build('Release', undefined, changedRuntime);
    assert.throws(() => f.read(), /同名运行时 DLL 内容不一致.*slot_shared\.dll/);
    const replacedArtifact = support.readJson(releaseProof).plugins[name].artifact.source;
    binary.recordBinaryBuild({ projectPath: f.projectPath, buildDir: path.join(f.root, 'empty'), buildType: 'Release', builtAt: new Date().toISOString() }, f.records);
    assert.equal(fs.existsSync(replacedArtifact), false);
    assert.throws(() => f.read(), /windows Release.*CMake/);
    assert.deepEqual(f.read({ platforms: ['windows'], buildTypes: ['Debug'] }).windows.buildTypes, ['Debug']);
});
