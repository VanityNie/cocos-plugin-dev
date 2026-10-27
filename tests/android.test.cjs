'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../lib/core.cjs');
const windows = require('../lib/windows.cjs');
const android = require('../lib/android.cjs');
const binaryArtifacts = require('../lib/binary-artifacts.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');

const internal = android._internal;
const binaryInternal = binaryArtifacts._internal;

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-plugin-android-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    function project(name = 'game') {
        const dir = path.join(root, name);
        fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, creator: { version: '3.8.8' } }));
        return dir;
    }
    return { root, project, projectPath: project() };
}

function makeFakeNdk(dir, revision = '21.1.6352462') {
    const toolchain = path.join(dir, 'build/cmake/android.toolchain.cmake');
    fs.mkdirSync(path.dirname(toolchain), { recursive: true });
    fs.writeFileSync(toolchain, '# fake android toolchain\n');
    fs.writeFileSync(path.join(dir, 'source.properties'), `Pkg.Desc = Android NDK\nPkg.Revision = ${revision}\n`);
    return dir;
}

test('Android ABI, platform level, and STL normalization validate inputs', () => {
    assert.equal(internal.normalizeAbi(undefined), null);
    assert.equal(internal.normalizeAbi('ARM64-V8A'), 'arm64-v8a');
    assert.equal(internal.normalizeAbi('armeabi-v7a'), 'armeabi-v7a');
    assert.equal(internal.normalizeAbi('x86_64'), 'x86_64');
    assert.equal(internal.normalizeAbi('X86'), 'x86');
    assert.throws(() => internal.normalizeAbi('mips'), /Unsupported Android ABI/);
    assert.throws(() => internal.normalizeAbi(64), /abi must be a string/);

    assert.equal(internal.normalizeAndroidPlatform(undefined), null);
    assert.equal(internal.normalizeAndroidPlatform('android-21'), 'android-21');
    assert.equal(internal.normalizeAndroidPlatform('28'), 'android-28');
    assert.throws(() => internal.normalizeAndroidPlatform('android-19'), /Unsupported Android platform level/);

    assert.equal(internal.normalizeAndroidStl(undefined), null);
    assert.equal(internal.normalizeAndroidStl('C++_STATIC'), 'c++_static');
    assert.equal(internal.normalizeAndroidStl('c++_shared'), 'c++_shared');
    assert.throws(() => internal.normalizeAndroidStl('gnustl_static'), /Unsupported Android STL/);
});

test('discoverNdk prioritizes explicit path, env vars, Creator profile, and SDK ndk versions', t => {
    const { root } = fixture(t);
    const explicitNdk = makeFakeNdk(path.join(root, 'explicit-ndk'), '25.2.9519653');
    const envNdk = makeFakeNdk(path.join(root, 'env-ndk'), '23.1.7779620');
    const profileHome = path.join(root, 'user-home');
    const profileNdk = makeFakeNdk(path.join(root, 'profile-sdk/ndk/21.1.6352462'), '21.1.6352462');
    const localSdk = path.join(root, 'local-sdk');
    makeFakeNdk(path.join(localSdk, 'ndk/21.0.6113669'), '21.0.6113669');
    const latestSdkNdk = makeFakeNdk(path.join(localSdk, 'ndk/23.2.8568313'), '23.2.8568313');

    const profileFile = path.join(profileHome, '.CocosCreator/profiles/v2/packages/program.json');
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(profileFile, JSON.stringify({ android: { sdkPath: path.join(root, 'profile-sdk') } }));

    assert.equal(internal.discoverNdk(explicitNdk, {}), explicitNdk);
    assert.equal(internal.readNdkVersion(explicitNdk), '25.2.9519653');
    assert.throws(() => internal.discoverNdk(path.join(root, 'missing-ndk'), {}), /Android NDK not found/);

    assert.equal(internal.discoverNdk(null, { ANDROID_NDK_HOME: envNdk, USERPROFILE: profileHome }), envNdk);
    assert.equal(internal.discoverNdk(null, { USERPROFILE: profileHome }), profileNdk);
    assert.equal(internal.discoverNdk(null, { ANDROID_SDK_ROOT: localSdk }), latestSdkNdk);
});

test('ensureAndroidHostFiles places CMakeLists 3 levels below project root and inherits host flags', t => {
    const { projectPath, root } = fixture(t);
    const enginePath = path.join(root, 'engine');
    fs.mkdirSync(path.join(enginePath, 'native'), { recursive: true });
    fs.writeFileSync(path.join(enginePath, 'native/CMakeLists.txt'), '# engine\n');

    const winCfg = path.join(projectPath, 'build/windows-plugin-dev/proj/cfg.cmake');
    fs.mkdirSync(path.dirname(winCfg), { recursive: true });
    fs.writeFileSync(winCfg, 'set(CC_USE_VULKAN ON)\nset(USE_PHYSICS_PHYSX ON)\nset(CC_USE_METAL ON)\n');

    const host = internal.ensureAndroidHostFiles(projectPath, enginePath, 'RelWithDebInfo');
    // Cocos common.cmake resolves project_root_dir as ${CC_PROJECT_DIR}/../../..
    assert.equal(path.resolve(host.nativeSourceDir, '../../..'), path.resolve(projectPath));
    const cfg = fs.readFileSync(path.join(host.resourceDir, 'proj/cfg.cmake'), 'utf8');
    assert.match(cfg, /set\(CC_USE_VULKAN ON\)/);
    assert.match(cfg, /set\(USE_PHYSICS_PHYSX ON\)/);
    assert.match(cfg, /set\(CC_USE_METAL OFF\)/);
    assert.match(cfg, /set\(USE_V8_DEBUGGER ON\)/);
    assert.match(cfg, /set\(USE_V8_DEBUGGER_FORCE ON\)/);

    const args = internal.cmakeArguments({
        ...host,
        buildDir: path.join(projectPath, '.plugin-dev/build/android/arm64-v8a'),
        buildType: 'RelWithDebInfo',
        abi: 'arm64-v8a',
        androidPlatform: 'android-21',
        androidStl: 'c++_static',
        enginePath,
        tools: {
            ninja: 'C:/tools/ninja.exe',
            ndk: 'D:/Sdk/ndk/21.1.6352462',
            ndkToolchain: 'D:/Sdk/ndk/21.1.6352462/build/cmake/android.toolchain.cmake',
            node: process.execPath,
        },
    });
    assert.ok(args.includes('-DANDROID_ABI:STRING=arm64-v8a'));
    assert.ok(args.includes('-DANDROID_PLATFORM:STRING=android-21'));
    assert.ok(args.includes('-DANDROID_STL:STRING=c++_static'));
    assert.ok(args.some(arg => arg.startsWith('-DCMAKE_TOOLCHAIN_FILE:FILEPATH=')));
});

test('configuredAndroidState invalidates build timestamps when switching ABI or buildType', () => {
    const previous = {
        abi: 'arm64-v8a',
        buildType: 'Debug',
        configuredAt: '2026-10-27T00:00:00Z',
        builtAt: '2026-10-27T00:01:00Z',
        builtBuildType: 'Debug',
    };
    const same = internal.configuredAndroidState(previous, { abi: 'arm64-v8a', buildType: 'Debug' });
    assert.ok(same.builtAt);
    assert.ok(same.configuredAt);

    const switchedAbi = internal.configuredAndroidState(previous, { abi: 'x86_64' });
    assert.equal(switchedAbi.abi, 'x86_64');
    assert.equal(switchedAbi.builtAt, undefined);
    assert.equal(switchedAbi.configuredAt, undefined);

    const switchedType = internal.configuredAndroidState(previous, { buildType: 'Release' });
    assert.equal(switchedType.buildType, 'Release');
    assert.equal(switchedType.builtAt, undefined);
    assert.equal(switchedType.configuredAt, undefined);
});

test('Android operations reject an already cancelled signal before touching project state', async t => {
    const { projectPath } = fixture(t);
    const controller = new AbortController();
    controller.abort();
    for (const op of ['doctor', 'configure', 'build']) {
        await assert.rejects(
            () => android[op]({ projectPath, signal: controller.signal }),
            { name: 'AbortError', code: 'ABORT_ERR' },
        );
    }
    assert.equal(fs.existsSync(path.join(projectPath, '.plugin-dev/android.json')), false);
});

test('parseAndroidLibraryTokens and resolveLibrary handle -Xlinker WHOLE_ARCHIVE and .so/.a priority for -lfoo', t => {
    const { root } = fixture(t);
    const tokens = [
        '-Xlinker', '--push-state',
        '-Xlinker', '--whole-archive',
        'plugins/demo/libwhole_dep.a',
        '-Xlinker', '--pop-state',
        '-Wl,--push-state,--whole-archive',
        'plugins/demo/libwhole_two.a',
        '-Wl,--pop-state',
        '-lchoice',
        '-Wl,-Bstatic',
        '-lstatic_choice',
        '-Wl,-Bdynamic',
        '-llog',
    ];
    const parsed = binaryInternal.parseAndroidLibraryTokens(tokens);
    assert.deepEqual(parsed, [
        'WHOLE_ARCHIVE:plugins/demo/libwhole_dep.a',
        'WHOLE_ARCHIVE:plugins/demo/libwhole_two.a',
        '-lchoice',
        'BSTATIC:-lstatic_choice',
        '-llog',
    ]);

    const libDir = path.join(root, 'third_party/lib/arm64-v8a');
    const sysrootDir = path.join(root, 'ndk/sysroot/usr/lib/aarch64-linux-android/21');
    fs.mkdirSync(libDir, { recursive: true });
    fs.mkdirSync(sysrootDir, { recursive: true });
    const soFile = path.join(libDir, 'libchoice.so');
    const aFile = path.join(libDir, 'libchoice.a');
    fs.writeFileSync(soFile, 'shared-library-bytes');
    fs.writeFileSync(aFile, 'static-library-bytes');
    fs.writeFileSync(path.join(sysrootDir, 'liblog.so'), 'ndk-sysroot-log');

    const state = { buildDir: path.join(root, 'build') };
    fs.mkdirSync(state.buildDir, { recursive: true });

    // Default dynamic mode must prefer libchoice.so over libchoice.a in the same directory
    const dynamicResolved = binaryInternal.resolveLibrary('-lchoice', [libDir, sysrootDir], state, [sysrootDir], true, false);
    assert.equal(dynamicResolved.source, soFile);

    // Explicit -Bstatic mode must select libchoice.a
    const staticResolved = binaryInternal.resolveLibrary('-lchoice', [libDir, sysrootDir], state, [sysrootDir], true, true);
    assert.equal(staticResolved.source, aFile);

    // System library inside sysroot resolves to system name
    const sysResolved = binaryInternal.resolveLibrary('-llog', [libDir, sysrootDir], state, [sysrootDir], true, false);
    assert.deepEqual(sysResolved, { system: 'log' });

    // Missing -lfoo reports an error instead of silently assuming a system library
    const missingResolved = binaryInternal.resolveLibrary('-lmissing_lib', [libDir, sysrootDir], state, [sysrootDir], true, false);
    assert.match(missingResolved.error, /无法定位链接库 -lmissing_lib/);
});

test('真实 Android NDK 交叉编译插件静态库 (.a) 并导出预编译二进制包', {
    skip: process.env.COCOS_PLUGIN_NATIVE_TESTS !== '1',
    timeout: 180000,
}, async t => {
    const parent = path.resolve(__dirname, '../.local');
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'android-ndk-build-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const projectPath = path.join(root, 'game');
    fs.mkdirSync(path.join(projectPath, 'assets'), { recursive: true });
    support.writeJson(path.join(projectPath, 'package.json'), { name: 'android-test-game', creator: { version: '3.8.8' } });

    const pluginSource = path.join(root, 'neural-android-plugin');
    const created = core.createPlugin({
        projectPath,
        pluginPath: pluginSource,
        name: 'neural-android',
        template: 'render',
    });
    fs.mkdirSync(path.join(pluginSource, 'native/include'), { recursive: true });
    fs.writeFileSync(path.join(pluginSource, 'native/include/NeuralAndroidPublic.h'), '#pragma once\n#define CPD_ANDROID_PUBLIC_HEADER 1\n');

    const report = await android.doctor({ projectPath, abi: 'arm64-v8a' });
    assert.equal(report.ok, true, JSON.stringify(report.checks));

    // Create a third_party CMakeLists.txt that:
    // 1. Builds a static library linked via $<LINK_LIBRARY:WHOLE_ARCHIVE,...> (emits -Xlinker --push-state -Xlinker --whole-archive in CMake 3.24.3)
    // 2. Places both libchoice.so and libchoice.a in the same search directory and links -lchoice
    const thirdPartyDir = path.join(pluginSource, 'native/third_party');
    const choiceDir = path.join(thirdPartyDir, 'choice-lib');
    fs.mkdirSync(choiceDir, { recursive: true });
    const clangxx = path.join(report.tools.ndk, 'toolchains/llvm/prebuilt/windows-x86_64/bin/clang++.exe');
    const llvmAr = path.join(report.tools.ndk, 'toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-ar.exe');
    const choiceSrc = path.join(choiceDir, 'choice.cpp');
    const choiceObj = path.join(choiceDir, 'choice.o');
    fs.writeFileSync(choiceSrc, 'extern "C" int cpd_choice_value() { return 7; }\n');
    await windows._internal.execute(clangxx, ['--target=aarch64-none-linux-android21', '-fPIC', '-c', choiceSrc, '-o', choiceObj], {});
    await windows._internal.execute(clangxx, ['--target=aarch64-none-linux-android21', '-shared', choiceObj, '-o', path.join(choiceDir, 'libchoice.so')], {});
    await windows._internal.execute(llvmAr, ['rcs', path.join(choiceDir, 'libchoice.a'), choiceObj], {});
    fs.unlinkSync(choiceSrc);
    fs.unlinkSync(choiceObj);

    fs.writeFileSync(path.join(thirdPartyDir, 'whole_dep.cpp'), 'extern "C" int cpd_whole_dep_symbol() { return 42; }\n');
    fs.writeFileSync(path.join(thirdPartyDir, 'CMakeLists.txt'), [
        'add_library(cpd_whole_dep STATIC "${CMAKE_CURRENT_LIST_DIR}/whole_dep.cpp")',
        `target_link_libraries(${created.target} PRIVATE "$<LINK_LIBRARY:WHOLE_ARCHIVE,cpd_whole_dep>")`,
        `target_link_directories(${created.target} PRIVATE "\${CMAKE_CURRENT_LIST_DIR}/choice-lib")`,
        `target_link_libraries(${created.target} PRIVATE -lchoice)`,
        '',
    ].join('\n'));

    const built = await android.build({ projectPath, abi: 'arm64-v8a', buildType: 'Debug' });
    assert.equal(built.abi, 'arm64-v8a');
    assert.equal(built.builtBuildType, 'Debug');
    const staticLib = built.artifacts['neural-android'];
    assert.ok(staticLib && fs.existsSync(staticLib), `Expected static library at ${staticLib}`);
    assert.match(path.basename(staticLib), new RegExp(`^lib${created.target}\\.a$`));
    assert.ok(fs.existsSync(path.join(built.buildDir, 'compile_commands.json')));

    const packaged = await core.packagePlugin({
        projectPath,
        name: 'neural-android',
        binary: true,
        platform: 'android',
        abi: 'arm64-v8a',
    });
    assert.equal(packaged.binary, true);
    assert.equal(packaged.platform, 'android');
    assert.equal(packaged.abi, 'arm64-v8a');
    assert.equal(packaged.buildType, 'Debug');
    assert.ok(fs.existsSync(packaged.zipPath));
    assert.ok(fs.existsSync(path.join(packaged.packagePath, `native/android/arm64-v8a/lib/lib${created.target}.a`)));
    assert.ok(fs.existsSync(path.join(packaged.packagePath, 'native/android/lib/include/plugin/NeuralAndroidPublic.h')));
    assert.ok(fs.existsSync(path.join(packaged.packagePath, 'native/android/binary-manifest.json')));
    assert.equal(fs.existsSync(path.join(packaged.packagePath, 'native/src')), false);

    // Verify WHOLE_ARCHIVE and .so (not .a) selection for -lchoice
    const manifestFiles = Object.keys(packaged.binaryManifest.files);
    assert.ok(manifestFiles.some(f => f.endsWith('/libcpd_whole_dep.a')), `Expected libcpd_whole_dep.a in ${JSON.stringify(manifestFiles)}`);
    assert.ok(manifestFiles.some(f => f.endsWith('/libchoice.so')), `Expected libchoice.so in ${JSON.stringify(manifestFiles)}`);
    assert.equal(manifestFiles.some(f => f.endsWith('/libchoice.a')), false, `Did not expect libchoice.a in ${JSON.stringify(manifestFiles)}`);

    const exportedConfig = fs.readFileSync(path.join(packaged.packagePath, `native/android/${created.target}-config.cmake`), 'utf8');
    assert.match(exportedConfig, /if\(NOT ANDROID\)/);
    assert.match(exportedConfig, /if\(NOT ANDROID_ABI STREQUAL "arm64-v8a"\)/);
    assert.match(exportedConfig, new RegExp(`add_library\\(${created.target} STATIC IMPORTED GLOBAL\\)`));
    assert.match(exportedConfig, /\$<LINK_LIBRARY:WHOLE_ARCHIVE,[^"]*libcpd_whole_dep\.a>/);

    // Install the exported Android binary package into an independent consumer project
    // AND create a new source plugin in the same project to verify mixed binary + source build!
    const consumerGame = path.join(root, 'consumer-game');
    fs.mkdirSync(path.join(consumerGame, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(consumerGame, 'extensions'), { recursive: true });
    support.writeJson(path.join(consumerGame, 'package.json'), { name: 'consumer-game', creator: { version: '3.8.8' } });
    fs.cpSync(packaged.packagePath, path.join(consumerGame, 'extensions/neural-android'), { recursive: true });

    const consumerSourcePlugin = core.createPlugin({
        projectPath: consumerGame,
        pluginPath: path.join(root, 'consumer-source-plugin'),
        name: 'consumer-src',
        template: 'native',
    });

    const consumerBuilt = await android.build({ projectPath: consumerGame, abi: 'arm64-v8a', buildType: 'Debug' });
    assert.ok(consumerBuilt.artifacts['consumer-src'] && fs.existsSync(consumerBuilt.artifacts['consumer-src']));
    assert.equal(consumerBuilt.artifacts['neural-android'], undefined);

    const consumerPackaged = await core.packagePlugin({
        projectPath: consumerGame,
        name: 'consumer-src',
        binary: true,
        platform: 'android',
        abi: 'arm64-v8a',
    });
    assert.ok(fs.existsSync(path.join(consumerPackaged.packagePath, `native/android/arm64-v8a/lib/lib${consumerSourcePlugin.target}.a`)));

    // Re-exporting an already-binary plugin must be rejected
    await assert.rejects(
        () => core.packagePlugin({ projectPath: consumerGame, name: 'neural-android', binary: true, platform: 'android', abi: 'arm64-v8a' }),
        /STATIC_LIBRARY/,
    );

    // Mismatched buildType on installed binary plugin must be caught during build
    await assert.rejects(
        () => android.build({ projectPath: consumerGame, abi: 'arm64-v8a', buildType: 'Release' }),
        /二进制插件要求 Debug 构建配置/,
    );

    // Mismatched ABI on installed binary plugin must be caught during configure
    await assert.rejects(
        () => android.configure({ projectPath: consumerGame, abi: 'x86_64', buildType: 'Debug' }),
        /二进制插件要求 Android ABI arm64-v8a/,
    );
});
