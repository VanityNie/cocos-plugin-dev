'use strict';

// Android 原生插件交叉编译与预编译静态库验证。
// 复用 Windows 本机 CMake + Ninja + Android NDK 工具链，无需启动 Gradle 或编译完整引擎实现。
const fs = require('node:fs');
const path = require('node:path');
const support = require('../templates/common/editor/plugin-support.cjs');
const processes = require('./processes.cjs');
const windows = require('./windows.cjs');
const { throwIfAborted } = processes;
const {
    BUILD_TYPES,
    normalizeBuildType,
    discoverCreator,
    normalizeEngine,
    cmakeSet,
    execute,
    acknowledgePlugins,
} = windows._internal;

const STATE_VERSION = 1;
const ANDROID_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const ANDROID_STL_VALUES = ['c++_static', 'c++_shared'];
const DEFAULT_ABI = 'arm64-v8a';
const DEFAULT_ANDROID_PLATFORM = 'android-21';
const DEFAULT_ANDROID_STL = 'c++_static';

const exists = (p) => Boolean(p && fs.existsSync(p));
const slash = (p) => p.replace(/\\/g, '/');
const readJson = (p) => support.readJson(p);
const writeJson = (p, value) => support.writeJson(p, value);
const emit = (options, value) => { if (options.onOutput) options.onOutput(value); };
const samePath = (a, b) => Boolean(a && b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase());
const versionCompare = (a, b) => b.localeCompare(a, undefined, { numeric: true });

function projectRoot(value) {
    if (!value) throw new Error('projectPath is required: select a Creator game project.');
    const p = path.resolve(value);
    if (!exists(path.join(p, 'package.json')) || !exists(path.join(p, 'assets'))) {
        throw new Error(`Not a Creator game project (package.json and assets are required): ${p}`);
    }
    support.ensureLocalIgnore(p);
    return p;
}

function statePath(project) {
    return path.join(project, '.plugin-dev', 'android.json');
}

function readState(project) {
    return exists(statePath(project)) ? readJson(statePath(project)) : {};
}

function saveState(project, value) {
    support.noLinks(project, statePath(project));
    writeJson(statePath(project), { ...value, schemaVersion: STATE_VERSION });
}

function pluginRecords(project) {
    return support.readState(project).plugins;
}

function syncPlugins(project) {
    const core = require('./core.cjs');
    for (const plugin of core.listPlugins({ projectPath: project })) {
        core.syncPlugin({ projectPath: project, name: plugin.name });
    }
}

function normalizeAbi(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new Error(`abi must be a string (${ANDROID_ABIS.join(', ')}).`);
    const match = ANDROID_ABIS.find((item) => item.toLowerCase() === value.trim().toLowerCase());
    if (!match) throw new Error(`Unsupported Android ABI: ${value}. Use ${ANDROID_ABIS.join(', ')}.`);
    return match;
}

function normalizeAndroidPlatform(value) {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value).trim();
    const match = /^(?:android-)?(\d+)$/i.exec(text);
    const level = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(level) || level < 21) {
        throw new Error(`Unsupported Android platform level: ${value}. Use android-21 or higher.`);
    }
    return `android-${level}`;
}

function normalizeAndroidStl(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new Error(`androidStl must be a string (${ANDROID_STL_VALUES.join(', ')}).`);
    const match = ANDROID_STL_VALUES.find((item) => item.toLowerCase() === value.trim().toLowerCase());
    if (!match) throw new Error(`Unsupported Android STL: ${value}. Use ${ANDROID_STL_VALUES.join(' or ')}.`);
    return match;
}

function firstFile(paths) {
    return paths.filter(Boolean).find((p) => exists(p) && fs.statSync(p).isFile()) || null;
}

function envValue(env, key) {
    const name = Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase());
    return name ? env[name] : '';
}

function findOnPath(name, env = process.env) {
    return firstFile(
        envValue(env, 'PATH')
            .split(path.delimiter)
            .filter(Boolean)
            .map((p) => path.join(p.replace(/^"|"$/g, ''), name)),
    );
}

function bundledEngine(creator) {
    if (!creator) return null;
    const root = path.join(path.dirname(creator), 'resources/resources/3d/engine');
    return exists(path.join(root, 'native/CMakeLists.txt')) ? root : null;
}

function toolchainFileForNdk(ndkRoot) {
    if (!ndkRoot) return null;
    const file = path.join(ndkRoot, 'build/cmake/android.toolchain.cmake');
    return exists(file) && fs.statSync(file).isFile() ? file : null;
}

function readNdkVersion(ndkRoot) {
    if (!ndkRoot) return null;
    const props = path.join(ndkRoot, 'source.properties');
    if (exists(props)) {
        const match = /^Pkg\.Revision\s*=\s*([^\r\n#]+)/m.exec(fs.readFileSync(props, 'utf8'));
        if (match) return match[1].trim();
    }
    return path.basename(ndkRoot);
}

function resolveNdkCandidate(candidate) {
    if (!candidate || typeof candidate !== 'string' || !candidate.trim()) return null;
    const resolved = path.resolve(candidate.trim().replace(/^"|"$/g, ''));
    if (toolchainFileForNdk(resolved)) return resolved;
    const ndkSubdir = path.join(resolved, 'ndk');
    if (exists(ndkSubdir) && fs.statSync(ndkSubdir).isDirectory()) {
        for (const version of fs.readdirSync(ndkSubdir).sort(versionCompare)) {
            const versionRoot = path.join(ndkSubdir, version);
            if (toolchainFileForNdk(versionRoot)) return versionRoot;
        }
    }
    if (exists(resolved) && fs.statSync(resolved).isDirectory()) {
        for (const version of fs.readdirSync(resolved).sort(versionCompare)) {
            const versionRoot = path.join(resolved, version);
            if (toolchainFileForNdk(versionRoot)) return versionRoot;
        }
    }
    return null;
}

function creatorProfileAndroidPaths(env = process.env) {
    const home = envValue(env, 'USERPROFILE') || envValue(env, 'HOME');
    if (!home) return [];
    const file = path.join(home, '.CocosCreator/profiles/v2/packages/program.json');
    if (!exists(file)) return [];
    try {
        const data = readJson(file);
        if (!data || typeof data !== 'object') return [];
        const android = data.android && typeof data.android === 'object' ? data.android : {};
        return [
            data.androidNDK && data.androidNDK.path,
            data.android_ndk,
            android.ndkPath,
            data.androidSDK && data.androidSDK.path,
            data.android_sdk,
            android.sdkPath,
        ].filter((item) => typeof item === 'string' && item.trim());
    } catch (_) {
        return [];
    }
}

function discoverNdk(explicitNdkPath, env = process.env) {
    if (explicitNdkPath) {
        const resolved = resolveNdkCandidate(explicitNdkPath);
        if (!resolved) {
            throw new Error(`Android NDK not found (missing build/cmake/android.toolchain.cmake): ${explicitNdkPath}`);
        }
        return resolved;
    }
    for (const key of ['COCOS_PLUGIN_NDK', 'ANDROID_NDK_HOME', 'ANDROID_NDK_ROOT', 'ANDROID_NDK', 'NDK_ROOT']) {
        const resolved = resolveNdkCandidate(envValue(env, key));
        if (resolved) return resolved;
    }
    for (const candidate of creatorProfileAndroidPaths(env)) {
        const resolved = resolveNdkCandidate(candidate);
        if (resolved) return resolved;
    }
    const sdkRoots = [
        envValue(env, 'ANDROID_HOME'),
        envValue(env, 'ANDROID_SDK_ROOT'),
        path.join(envValue(env, 'LOCALAPPDATA') || 'C:/Users/Default/AppData/Local', 'Android/Sdk'),
    ].filter(Boolean);
    for (const sdkRoot of sdkRoots) {
        const resolved = resolveNdkCandidate(sdkRoot) || resolveNdkCandidate(path.join(sdkRoot, 'ndk-bundle'));
        if (resolved) return resolved;
    }
    return null;
}

async function discoverTools(options = {}, previous = {}, signal) {
    throwIfAborted(signal);
    const creator = discoverCreator(options.creatorPath || previous.creatorPath);
    const vswhere = firstFile([
        process.env.VSWHERE_PATH,
        path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe'),
        findOnPath('vswhere.exe'),
    ]);
    let vsRoot = null;
    if (vswhere) {
        try {
            const result = await execute(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { signal });
            vsRoot = result.output.trim().split(/\r?\n/)[0] || null;
        } catch (error) {
            if (error.code === 'ABORT_ERR' || error.code === 'PROCESS_CLEANUP_FAILED') throw error;
            throwIfAborted(signal);
        }
    }
    const cmake = firstFile([
        process.env.COCOS_PLUGIN_CMAKE,
        creator && path.join(path.dirname(creator), 'resources/tools/cmake/bin/cmake.exe'),
        vsRoot && path.join(vsRoot, 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'),
        findOnPath('cmake.exe'),
    ]);
    const ninja = firstFile([
        process.env.COCOS_PLUGIN_NINJA,
        creator && path.join(path.dirname(creator), 'resources/tools/cmake/bin/ninja.exe'),
        vsRoot && path.join(vsRoot, 'Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja/ninja.exe'),
        findOnPath('ninja.exe'),
    ]);
    const node = firstFile([
        process.env.COCOS_PLUGIN_NODE,
        findOnPath('node.exe'),
        !process.versions.electron && process.execPath,
    ]);
    const ndk = discoverNdk(options.ndkPath || previous.ndkPath);
    const ndkToolchain = toolchainFileForNdk(ndk);
    const ndkVersion = readNdkVersion(ndk);
    return { creator, cmake, ninja, node, ndk, ndkToolchain, ndkVersion };
}

function discoverConfiguredEngine(project) {
    const windowsStateFile = path.join(project, '.plugin-dev/windows.json');
    if (exists(windowsStateFile)) {
        const winState = readJson(windowsStateFile);
        if (winState.enginePath && exists(path.join(winState.enginePath, 'native/CMakeLists.txt'))) {
            return normalizeEngine(winState.enginePath);
        }
    }
    for (const rel of [
        'build/android/proj/cfg.cmake',
        'build/windows-plugin-dev/proj/cfg.cmake',
        'build/windows/proj/cfg.cmake',
        'native/engine/common/localCfg.cmake',
    ]) {
        const file = path.join(project, rel);
        if (!exists(file)) continue;
        const p = cmakeSet(fs.readFileSync(file, 'utf8'), 'COCOS_X_PATH');
        if (p && path.isAbsolute(p)) {
            try { return normalizeEngine(p); } catch (_) { /* ignore invalid path in external cfg */ }
        }
    }
    return null;
}

const DEFAULT_CFG_FLAGS = [
    ['CC_USE_GLES3', 'ON'],
    ['CC_USE_GLES2', 'OFF'],
    ['CC_USE_VULKAN', 'OFF'],
    ['USE_JOB_SYSTEM_TASKFLOW', 'ON'],
    ['USE_JOB_SYSTEM_TBB', 'OFF'],
    ['USE_PHYSICS_PHYSX', 'OFF'],
    ['USE_AUDIO', 'ON'],
    ['USE_VIDEO', 'ON'],
    ['USE_WEBVIEW', 'ON'],
    ['USE_SOCKET', 'ON'],
    ['USE_WEBSOCKET_SERVER', 'OFF'],
    ['USE_VENDOR', 'ON'],
    ['USE_SPINE', 'ON'],
    ['USE_DRAGONBONES', 'ON'],
    ['USE_XR', 'OFF'],
    ['USE_AR_CORE', 'OFF'],
    ['USE_AR_ENGINE', 'OFF'],
    ['USE_DEBUG_RENDERER', 'ON'],
    ['USE_OCCLUSION_QUERY', 'OFF'],
    ['USE_GEOMETRY_RENDERER', 'ON'],
];

function extractHostBooleanFlags(project) {
    const flags = new Map(DEFAULT_CFG_FLAGS);
    for (const rel of [
        'build/android/proj/cfg.cmake',
        'build/windows-plugin-dev/proj/cfg.cmake',
        'build/windows/proj/cfg.cmake',
    ]) {
        const file = path.join(project, rel);
        if (!exists(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        const pattern = /^\s*set\s*\(\s*((?:CC_USE|USE)_[A-Za-z0-9_]+)\s+(ON|OFF)\s*\)/gm;
        let match;
        while ((match = pattern.exec(text))) {
            const [, key, val] = match;
            if (key === 'CC_USE_METAL' || key === 'USE_V8_DEBUGGER' || key === 'USE_V8_DEBUGGER_FORCE') continue;
            flags.set(key, val);
        }
        break;
    }
    flags.set('CC_USE_METAL', 'OFF');
    if (flags.get('CC_USE_GLES3') !== 'ON' && flags.get('CC_USE_GLES2') !== 'ON' && flags.get('CC_USE_VULKAN') !== 'ON') {
        flags.set('CC_USE_GLES3', 'ON');
    }
    return flags;
}

function androidHostCmakeSource() {
    return [
        'cmake_minimum_required(VERSION 3.8)',
        'set(APP_NAME "cocos_android_plugin_host" CACHE STRING "Project Name")',
        'project(${APP_NAME} CXX C)',
        'set(CC_PROJECT_DIR "${CMAKE_CURRENT_LIST_DIR}")',
        'set(CC_UI_RESOURCES)',
        'set(CC_PROJ_SOURCES)',
        'set(CC_COMMON_SOURCES)',
        'set(CC_ALL_SOURCES)',
        'include("${RES_DIR}/proj/cfg.cmake")',
        'include("${COCOS_X_PATH}/../templates/cmake/common.cmake")',
        'if(NOT ANDROID_PLATFORM)',
        `    set(ANDROID_PLATFORM ${DEFAULT_ANDROID_PLATFORM})`,
        'endif()',
        'include("${COCOS_X_PATH}/CMakeLists.txt")',
        '# 插件静态库编译检查只需引擎头文件、宏、SWIG 生成头与传递依赖，无需编译 600+ 引擎实现文件。',
        'set_target_properties(${ENGINE_NAME} PROPERTIES SOURCES "${CMAKE_CURRENT_LIST_DIR}/engine-stub.cpp")',
        'if(TARGET genbindings)',
        '    add_dependencies(${ENGINE_NAME} genbindings)',
        'endif()',
        'foreach(cpd_stub_target IN ITEMS pvmp3dec vorbisidec paddleboat_static android_platform)',
        '    if(TARGET ${cpd_stub_target})',
        '        set_target_properties(${cpd_stub_target} PROPERTIES SOURCES "${CMAKE_CURRENT_LIST_DIR}/engine-stub.cpp")',
        '    endif()',
        'endforeach()',
        'cc_common_before_target(${APP_NAME})',
        'if(CPD_BINARY_METADATA_MODULE)',
        '    include("${CPD_BINARY_METADATA_MODULE}")',
        'endif()',
        '',
    ].join('\n');
}

function ensureAndroidHostFiles(projectPath, enginePath, buildType) {
    // Keep host CMakeLists.txt exactly 3 levels under projectPath (.plugin-dev/android/host)
    // because Cocos common.cmake resolves project_root_dir as ${CC_PROJECT_DIR}/../../..
    const hostDir = path.join(projectPath, '.plugin-dev/android/host');
    const resourceDir = path.join(projectPath, '.plugin-dev/android/res');
    const cfgFile = path.join(resourceDir, 'proj/cfg.cmake');
    const hostCmakeFile = path.join(hostDir, 'CMakeLists.txt');
    const stubFile = path.join(hostDir, 'engine-stub.cpp');
    support.noLinks(projectPath, cfgFile);
    support.noLinks(projectPath, hostCmakeFile);
    support.noLinks(projectPath, stubFile);

    const inspector = (normalizeBuildType(buildType) || 'Debug') !== 'Release';
    const flags = extractHostBooleanFlags(projectPath);
    const nativeEnginePath = slash(path.join(enginePath, 'native'));
    const cfgLines = [
        '# Generated by cocos-plugin-dev for standalone Android plugin cross-compilation.',
        'set(CC_TARGET_PLATFORM "android")',
        ...[...flags.entries()].map(([key, val]) => `set(${key} ${val})`),
        'set(USE_PLUGINS ON)',
        `set(USE_V8_DEBUGGER ${inspector ? 'ON' : 'OFF'})`,
        `set(USE_V8_DEBUGGER_FORCE ${buildType === 'RelWithDebInfo' ? 'ON' : 'OFF'})`,
        `set(COCOS_X_PATH "${nativeEnginePath}")`,
        `set(BUILTIN_COCOS_X_PATH "${nativeEnginePath}")`,
        '',
    ];
    support.write(cfgFile, cfgLines.join('\n'));
    support.write(stubFile, 'extern "C" void cpd_android_engine_stub() {}\n');
    support.write(hostCmakeFile, androidHostCmakeSource());
    return { nativeSourceDir: hostDir, resourceDir };
}

function cmakeArguments(state) {
    const buildType = state.buildType || 'Debug';
    const abi = state.abi || DEFAULT_ABI;
    const androidPlatform = state.androidPlatform || DEFAULT_ANDROID_PLATFORM;
    const androidStl = state.androidStl || DEFAULT_ANDROID_STL;
    return [
        '-S', state.nativeSourceDir,
        '-B', state.buildDir,
        '-G', 'Ninja',
        `-DCMAKE_BUILD_TYPE:STRING=${buildType}`,
        '-DCMAKE_EXPORT_COMPILE_COMMANDS:BOOL=ON',
        `-DCMAKE_MAKE_PROGRAM:FILEPATH=${slash(state.tools.ninja)}`,
        `-DCMAKE_TOOLCHAIN_FILE:FILEPATH=${slash(state.tools.ndkToolchain)}`,
        `-DANDROID_NDK:PATH=${slash(state.tools.ndk)}`,
        `-DANDROID_ABI:STRING=${abi}`,
        `-DANDROID_PLATFORM:STRING=${androidPlatform}`,
        `-DANDROID_STL:STRING=${androidStl}`,
        `-DRES_DIR:PATH=${slash(state.resourceDir)}`,
        `-DCOCOS_X_PATH:PATH=${slash(path.join(state.enginePath, 'native'))}`,
        `-DCPD_BINARY_METADATA_MODULE:FILEPATH=${slash(path.join(__dirname, 'cmake/binary-build.cmake'))}`,
        `-DNODE_EXECUTABLE:FILEPATH=${slash(state.tools.node)}`,
        '-DUSE_PLUGINS:BOOL=ON',
    ];
}

function enabledAndroidPluginTargets(projectPath) {
    const core = require('./core.cjs');
    const targets = [];
    for (const plugin of core.listPlugins({ projectPath })) {
        if (!plugin.enabled) continue;
        const manifestFile = path.join(plugin.pluginPath, 'native/cc_plugin.json');
        support.noLinks(plugin.pluginPath, manifestFile);
        if (!exists(manifestFile)) continue;
        const manifest = readJson(manifestFile);
        const platforms = Array.isArray(manifest.platforms) ? manifest.platforms : [];
        if (platforms.includes('android')) {
            const binary = plugin.distribution?.type === 'binary'
                || exists(path.join(plugin.pluginPath, 'native/android/binary-manifest.json'));
            targets.push({ name: plugin.name, target: plugin.target, pluginPath: plugin.pluginPath, binary });
        }
    }
    return targets;
}

async function doctor(options = {}) {
    throwIfAborted(options.signal);
    const projectPath = projectRoot(options.projectPath);
    const previous = readState(projectPath);
    const abi = normalizeAbi(options.abi) || normalizeAbi(previous.abi) || DEFAULT_ABI;
    const androidPlatform = normalizeAndroidPlatform(options.androidPlatform) || normalizeAndroidPlatform(previous.androidPlatform) || DEFAULT_ANDROID_PLATFORM;
    const androidStl = normalizeAndroidStl(options.androidStl) || normalizeAndroidStl(previous.androidStl) || DEFAULT_ANDROID_STL;
    const tools = await discoverTools(options, previous, options.signal);
    const configuredEngine = discoverConfiguredEngine(projectPath);
    const enginePath = normalizeEngine(options.enginePath || previous.enginePath || configuredEngine || bundledEngine(tools.creator));
    const checks = [
        { name: 'Windows', ok: process.platform === 'win32', required: true, message: process.platform === 'win32' ? 'Windows x64 host' : 'Native cross-build requires Windows.' },
        ...['cmake', 'ninja', 'node'].map((name) => ({
            name,
            ok: Boolean(tools[name]),
            required: true,
            message: tools[name] || (name === 'node' ? 'Install standalone Node.js 18+ (or set COCOS_PLUGIN_NODE).' : `Missing ${name}. Install CMake and Ninja.`),
        })),
        {
            name: 'ndk',
            ok: Boolean(tools.ndk && tools.ndkToolchain),
            required: true,
            message: tools.ndk ? `${tools.ndk} (r${tools.ndkVersion})` : 'Install Android NDK (containing build/cmake/android.toolchain.cmake) or pass --ndk-path / set ANDROID_NDK_HOME.',
        },
        {
            name: 'engine',
            ok: Boolean(enginePath),
            required: true,
            message: enginePath || 'Select an engine root containing native/CMakeLists.txt.',
        },
    ];
    const warnings = [];
    const androidPlugins = enabledAndroidPluginTargets(projectPath);
    if (!androidPlugins.length) {
        warnings.push('No enabled plugins declare "android" in native/cc_plugin.json#platforms.');
    }
    return {
        ok: checks.every((c) => !c.required || c.ok),
        platform: 'android',
        abi,
        androidPlatform,
        androidStl,
        projectPath,
        tools,
        enginePath,
        checks,
        warnings,
    };
}

function configuredAndroidState(previous, updates) {
    const previousBuildType = normalizeBuildType(previous.buildType) || 'Debug';
    const buildType = normalizeBuildType(updates.buildType) || previousBuildType;
    const previousAbi = normalizeAbi(previous.abi) || DEFAULT_ABI;
    const abi = normalizeAbi(updates.abi) || previousAbi;
    const state = { ...previous, ...updates, platform: 'android', abi, buildType };
    if (previousBuildType !== buildType || previousAbi !== abi) {
        delete state.builtAt;
        delete state.builtBuildType;
        delete state.configuredAt;
    }
    return state;
}

async function configureImpl(options) {
    throwIfAborted(options.signal);
    const projectPath = projectRoot(options.projectPath);
    syncPlugins(projectPath);
    const report = await doctor(options);
    if (!report.ok) {
        throw new Error(report.checks.filter((c) => c.required && !c.ok).map((c) => c.message).join('\n'));
    }
    const { tools, enginePath, abi, androidPlatform, androidStl } = report;
    const previous = readState(projectPath);
    const buildType = normalizeBuildType(options.buildType) || normalizeBuildType(previous.buildType) || 'Debug';
    const buildDir = path.join(projectPath, '.plugin-dev/build/android', abi);
    const previousAbiState = (previous.abis && previous.abis[abi]) || {};
    if ((previousAbiState.configuredEnginePath || previousAbiState.enginePath)
        && !samePath(previousAbiState.configuredEnginePath || previousAbiState.enginePath, enginePath)
        && exists(path.join(buildDir, 'CMakeCache.txt'))) {
        throw new Error(`Android (${abi}) build cache belongs to a different engine. Move ${buildDir} aside before switching engine.`);
    }
    if (previousAbiState.ndkPath
        && !samePath(previousAbiState.ndkPath, tools.ndk)
        && exists(path.join(buildDir, 'CMakeCache.txt'))) {
        throw new Error(`Android (${abi}) build cache was configured with a different NDK. Move ${buildDir} aside before switching NDK.`);
    }

    const host = ensureAndroidHostFiles(projectPath, enginePath, buildType);
    const state = configuredAndroidState(previous, {
        projectPath,
        ...host,
        enginePath,
        abi,
        androidPlatform,
        androidStl,
        buildType,
        buildDir,
        ndkPath: tools.ndk,
        ndkVersion: tools.ndkVersion,
        tools,
        creatorPath: tools.creator,
    });
    saveState(projectPath, state);

    const query = path.join(buildDir, '.cmake/api/v1/query/codemodel-v2');
    fs.mkdirSync(path.dirname(query), { recursive: true });
    fs.writeFileSync(query, '');

    const logPath = path.join(projectPath, `.plugin-dev/logs/configure-android-${abi}.log`);
    emit(options, `Configuring Android ${abi} ${buildType} (NDK r${tools.ndkVersion}, Ninja).\nBuild: ${buildDir}\nLog: ${logPath}\n`);
    await execute(tools.cmake, cmakeArguments(state), {
        cwd: projectPath,
        logPath,
        onOutput: options.onOutput,
        signal: options.signal,
    });

    if (!exists(path.join(buildDir, 'compile_commands.json'))) {
        throw new Error('CMake succeeded without compile_commands.json; verify the Ninja generator and Android NDK toolchain.');
    }
    state.configuredAt = new Date().toISOString();
    state.configuredEnginePath = enginePath;
    state.abis = {
        ...(previous.abis || {}),
        [abi]: {
            abi,
            buildType,
            buildDir,
            enginePath,
            configuredEnginePath: enginePath,
            ndkPath: tools.ndk,
            ndkVersion: tools.ndkVersion,
            androidPlatform,
            androidStl,
            configuredAt: state.configuredAt,
        },
    };
    throwIfAborted(options.signal);
    saveState(projectPath, state);
    for (const plugin of require('./core.cjs').listPlugins({ projectPath })) {
        support.syncTypeDeclarations(projectPath, plugin.pluginPath, state.enginePath);
    }
    return state;
}

function buildsystemTargetNames(buildDir, buildType) {
    const reply = path.join(buildDir, '.cmake/api/v1/reply');
    if (!exists(reply)) return new Set();
    const indexFiles = fs.readdirSync(reply).filter((f) => /^index-.*\.json$/.test(f)).sort().reverse();
    if (!indexFiles.length) return new Set();
    const index = readJson(path.join(reply, indexFiles[0]));
    const codemodel = index.reply && index.reply['codemodel-v2'];
    if (!codemodel || !codemodel.jsonFile) return new Set();
    const model = readJson(path.join(reply, codemodel.jsonFile));
    const configuration = (model.configurations || []).find((item) => item.name === buildType) || (model.configurations || [])[0];
    if (!configuration) return new Set();
    return new Set((configuration.targets || []).map((item) => item.name));
}

async function buildImpl(options) {
    throwIfAborted(options.signal);
    const projectPath = projectRoot(options.projectPath);
    syncPlugins(projectPath);
    const buildSnapshot = pluginRecords(projectPath);
    const state = await configureImpl(options);
    throwIfAborted(options.signal);

    const buildType = state.buildType || 'Debug';
    const abi = state.abi || DEFAULT_ABI;
    const pluginTargets = enabledAndroidPluginTargets(projectPath);
    const knownBuildTargets = buildsystemTargetNames(state.buildDir, buildType);
    const sourcePlugins = [];
    const cmakeTargetNames = [];
    for (const plugin of pluginTargets) {
        const metadataFile = path.join(state.buildDir, '.plugin-dev/binary-metadata', buildType, `${plugin.target}.json`);
        if (!exists(metadataFile)) {
            throw new Error(`CMake did not generate binary metadata for Android plugin target ${plugin.target}. Check native/android/${plugin.target}-config.cmake.`);
        }
        const metadata = readJson(metadataFile);
        if (metadata.imported || plugin.binary) {
            const checkTarget = `${plugin.target}_binary_check`;
            if (knownBuildTargets.has(checkTarget)) cmakeTargetNames.push(checkTarget);
            continue;
        }
        if (metadata.error) {
            throw new Error(`Android plugin target ${plugin.target} failed validation: ${metadata.error}`);
        }
        sourcePlugins.push({ ...plugin, metadata });
        cmakeTargetNames.push(plugin.target);
    }
    const logPath = path.join(projectPath, `.plugin-dev/logs/build-android-${abi}.log`);
    delete state.builtAt;
    saveState(projectPath, state);

    if (cmakeTargetNames.length) {
        emit(options, `Building Android (${abi}, ${buildType}) targets: ${cmakeTargetNames.join(', ')}\nLog: ${logPath}\n`);
        await execute(state.tools.cmake, ['--build', state.buildDir, '--config', buildType, '--target', ...cmakeTargetNames], {
            cwd: projectPath,
            logPath,
            onOutput: options.onOutput,
            signal: options.signal,
        });
    } else {
        emit(options, `No source plugin targets to build for Android (${abi}, ${buildType}).\n`);
    }

    const artifacts = {};
    for (const plugin of sourcePlugins) {
        const artifactPath = plugin.metadata.artifact;
        if (!artifactPath || !exists(artifactPath)) {
            throw new Error(`Android build completed but static library is missing for ${plugin.target}: ${artifactPath || 'unknown'}`);
        }
        artifacts[plugin.name] = artifactPath;
    }

    throwIfAborted(options.signal);
    state.builtAt = new Date().toISOString();
    state.builtBuildType = buildType;
    state.artifacts = artifacts;
    state.abis = {
        ...(state.abis || {}),
        [abi]: {
            ...((state.abis && state.abis[abi]) || {}),
            builtAt: state.builtAt,
            builtBuildType: buildType,
            artifacts,
        },
    };
    require('./binary-artifacts.cjs').recordAndroidBinaryBuild(state, buildSnapshot);
    saveState(projectPath, state);
    syncPlugins(projectPath);
    return state;
}

function locked(options, operation) {
    throwIfAborted(options.signal);
    const project = projectRoot(options.projectPath);
    return processes.withLock(project, () => operation({ ...options, projectPath: project }), options);
}

async function configure(options) { return locked(options, configureImpl); }
async function build(options) { return locked(options, buildImpl); }

module.exports = {
    ANDROID_ABIS,
    ANDROID_STL_VALUES,
    DEFAULT_ABI,
    DEFAULT_ANDROID_PLATFORM,
    DEFAULT_ANDROID_STL,
    doctor,
    configure,
    build,
    _internal: {
        BUILD_TYPES,
        ANDROID_ABIS,
        ANDROID_STL_VALUES,
        DEFAULT_ABI,
        DEFAULT_ANDROID_PLATFORM,
        DEFAULT_ANDROID_STL,
        normalizeAbi,
        normalizeAndroidPlatform,
        normalizeAndroidStl,
        normalizeBuildType,
        discoverNdk,
        readNdkVersion,
        discoverTools,
        ensureAndroidHostFiles,
        cmakeArguments,
        enabledAndroidPluginTargets,
        configuredAndroidState,
        acknowledgePlugins,
    },
};
