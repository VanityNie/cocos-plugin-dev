'use strict';

// Windows host adapter. All game compilation remains in the official Cocos
// generated project; this module owns only .plugin-dev, never .vscode/localCfg.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const support = require('../templates/common/editor/plugin-support.cjs');
const processes = require('./processes.cjs');
const { throwIfAborted } = processes;

const STATE_VERSION = 1;
const CREATOR_BUILD_SUCCESS = 36; // Official Creator CLI, not a generic process success code.
const exists = (p) => Boolean(p && fs.existsSync(p));
const slash = (p) => p.replace(/\\/g, '/');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (p, value) => support.writeJson(p, value);
const emit = (options, value) => { if (options.onOutput) options.onOutput(value); };

function projectRoot(value) {
    if (!value) throw new Error('projectPath is required: select a Creator game project.');
    const p = path.resolve(value);
    if (!exists(path.join(p, 'package.json')) || !exists(path.join(p, 'assets'))) {
        throw new Error(`Not a Creator game project (package.json and assets are required): ${p}`);
    }
    support.ensureLocalIgnore(p);
    return p;
}
function statePath(project) { return path.join(project, '.plugin-dev', 'windows.json'); }
function readState(project) { return exists(statePath(project)) ? readJson(statePath(project)) : {}; }
function saveState(project, value) { support.noLinks(project, statePath(project)); writeJson(statePath(project), { ...value, schemaVersion: STATE_VERSION }); }
function pluginRecords(project) {
    return support.readState(project).plugins;
}
function recordSignature(record, native = false) {
    // Ignore lastSync: a no-op editor sync must not invalidate a completed build.
    return JSON.stringify({ enabled: record.enabled, detached: record.detached, sourcePath: record.sourcePath,
        target: record.target, tracked: record.tracked, ...(native ? { nativeFingerprint: record.nativeFingerprint } : {}) });
}
function acknowledgePlugins(project, snapshot, field, native = false) {
    support.withProjectLock(project, () => {
        const file = path.join(project, '.plugin-dev/state.json');
        if (!exists(file)) return;
        support.noLinks(project, file);
        const state = readJson(file);
        for (const [name, record] of Object.entries(state.plugins || {})) {
            if (snapshot[name] && recordSignature(snapshot[name], native) === recordSignature(record, native)) record[field] = false;
        }
        writeJson(file, state);
    });
}
function syncPlugins(project) {
    const core = require('./core.cjs');
    for (const plugin of core.listPlugins({ projectPath: project })) core.syncPlugin({ projectPath: project, name: plugin.name });
}
function firstFile(paths) { return paths.filter(Boolean).find((p) => exists(p) && fs.statSync(p).isFile()) || null; }
function envValue(env, key) { const name = Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase()); return name ? env[name] : ''; }
function findOnPath(name, env = process.env) {
    return firstFile(envValue(env, 'PATH').split(path.delimiter).filter(Boolean).map((p) => path.join(p.replace(/^"|"$/g, ''), name)));
}
function versionCompare(a, b) { return b.localeCompare(a, undefined, { numeric: true }); }
function creatorExecutable(value) {
    if (!value) return null;
    const p = path.resolve(value);
    return firstFile([p, path.join(p, 'CocosCreator.exe')]);
}
function discoverCreator(value) {
    if (value) {
        const resolved = creatorExecutable(value);
        if (!resolved) throw new Error(`Creator executable does not exist: ${value}`);
        return resolved;
    }
    const envCreator = creatorExecutable(process.env.COCOS_CREATOR_PATH);
    if (envCreator) return envCreator;
    const direct = findOnPath('CocosCreator.exe');
    if (direct) return direct;
    for (const root of [path.join(process.env.ProgramData || 'C:/ProgramData', 'cocos/editors/Creator'), path.join(process.env.LOCALAPPDATA || 'C:/Users/Default/AppData/Local', 'CocosDashboard/resources/editors/Creator')]) {
        if (!exists(root)) continue;
        for (const version of fs.readdirSync(root).sort(versionCompare)) {
            const exe = creatorExecutable(path.join(root, version));
            if (exe) return exe;
        }
    }
    return null;
}
function bundledEngine(creator) {
    if (!creator) return null;
    const root = path.join(path.dirname(creator), 'resources/resources/3d/engine');
    return exists(path.join(root, 'native/CMakeLists.txt')) ? root : null;
}
function normalizeEngine(value) {
    if (!value) return null;
    const p = path.resolve(value);
    if (exists(path.join(p, 'native/CMakeLists.txt'))) return p;
    if (exists(path.join(p, 'CMakeLists.txt')) && path.basename(p).toLowerCase() === 'native') return path.dirname(p);
    throw new Error(`Engine path must contain native/CMakeLists.txt: ${p}`);
}
function samePath(a, b) { return Boolean(a && b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()); }
function cmakeSet(text, key) {
    // Read literal set values only. Never execute CMake to discover a path.
    const pattern = new RegExp(`set\\s*\\(\\s*${key}\\s+(?:"([^"\\r\\n]*)"|([^\\s)]+))`, 'ig');
    let match; let value;
    while ((match = pattern.exec(text))) value = match[1] === undefined ? match[2] : match[1];
    return value && !value.includes('${') ? value : null;
}
function discoverHost(project, options = {}, previous = {}) {
    const nativeSourceDir = [options.nativeSourceDir, previous.nativeSourceDir, path.join(project, 'native/engine/win64'), path.join(project, 'native/engine/windows')]
        .filter(Boolean).map((p) => path.resolve(p)).find((p) => exists(path.join(p, 'CMakeLists.txt'))) || null;
    const resourceDir = [options.resourceDir, previous.resourceDir, path.join(project, 'build/windows-plugin-dev'), path.join(project, 'build/windows')]
        .filter(Boolean).map((p) => path.resolve(p)).find((p) => exists(path.join(p, 'proj/cfg.cmake'))) || null;
    let configuredEngine = null;
    for (const file of [resourceDir && path.join(resourceDir, 'proj/cfg.cmake'), nativeSourceDir && path.resolve(nativeSourceDir, '../common/localCfg.cmake')]) {
        if (!exists(file)) continue;
        const p = cmakeSet(fs.readFileSync(file, 'utf8'), 'COCOS_X_PATH');
        if (p && path.isAbsolute(p)) configuredEngine = normalizeEngine(p);
    }
    return { nativeSourceDir, resourceDir, configuredEngine };
}

async function execute(command, args, options = {}) {
    throwIfAborted(options.signal);
    let cancellation;
    let rejectCancellation;
    const cancellationFailure = new Promise((_, reject) => { rejectCancellation = reject; });
    let abort;
    let raw = [];
    let child;
    let stream;
    const completed = new Promise((resolve, reject) => {
        let output = '';
        const log = options.logPath;
        if (log) fs.mkdirSync(path.dirname(log), { recursive: true });
        stream = log ? fs.createWriteStream(log, { flags: 'a' }) : null;
        child = cp.spawn(command, args, { cwd: options.cwd, env: options.env || process.env, shell: false, detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments: options.windowsVerbatimArguments || false });
        const childClosed = new Promise((resolveClosed) => child.once('close', resolveClosed));
        const identity = options.signal ? new Promise((resolveIdentity, rejectIdentity) => {
            child.once('spawn', () => processes.inspect(child.pid).then(resolveIdentity, rejectIdentity));
            child.once('error', () => resolveIdentity(null));
        }) : Promise.resolve(null);
        // An identity-query error matters only when cleanup is needed.
        identity.catch(() => {});
        abort = () => {
            if (cancellation) return;
            cancellation = processes.stopChild(child, identity, childClosed);
            cancellation.catch(rejectCancellation);
        };
        if (options.signal) { options.signal.addEventListener('abort', abort, { once: true }); if (options.signal.aborted) abort(); }
        const onData = (data) => {
            const text = data.toString();
            if (options.captureBuffer) raw.push(data);
            output = (output + text).slice(-128 * 1024);
            if (stream) stream.write(text);
            if (options.onOutput) options.onOutput(text);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (error) => { if (stream) stream.end(); reject(new Error(`Cannot launch ${command}: ${error.message}`)); });
        child.on('close', (code, signal) => {
            if (stream) stream.end();
            if (!(options.successCodes || [0]).includes(code)) {
                const error = new Error(`${path.basename(command)} failed (exit ${code}${signal ? `, ${signal}` : ''}).${log ? ` Log: ${log}` : ''}\n${output.slice(-6000)}`);
                error.exitCode = code;
                reject(error);
            } else resolve({ code, output });
        });
    });
    // close can reject because we terminated the child; cancellation takes
    // precedence only after verified process-tree cleanup has completed.
    let result; let failure;
    try { result = await Promise.race([completed, cancellationFailure]); }
    catch (error) { failure = error; }
    try {
        if (cancellation) await cancellation;
        throwIfAborted(options.signal);
        if (failure) throw failure;
        return { ...result, ...(options.captureBuffer ? { buffer: Buffer.concat(raw) } : {}) };
    } finally {
        if (options.signal && abort) options.signal.removeEventListener('abort', abort);
        if (stream && !stream.writableEnded) stream.end();
    }
}
function vsBootstrapCommand(vsDevCmd) {
    // This is the sole shell invocation. Do not interpolate project paths or
    // options into it. Reject cmd expansion/metacharacters even inside quotes.
    if (!vsDevCmd || /["%!&|<>^\r\n]/.test(vsDevCmd) || path.basename(vsDevCmd).toLowerCase() !== 'vsdevcmd.bat') {
        throw new Error('Unsafe or invalid VsDevCmd.bat path. Install Visual Studio in a path without shell metacharacters.');
    }
    return `"call "${vsDevCmd}" -no_logo -arch=x64 -host_arch=x64 >nul && set"`;
}
function parseEnvironment(text) {
    const env = {};
    for (const line of text.split(/\r?\n/)) {
        const separator = line.indexOf('=');
        if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return env;
}
async function vsEnvironment(tools, signal) {
    throwIfAborted(signal);
    if (!tools.vsDevCmd) throw new Error('Visual Studio C++ x64 tools not found. Install Desktop development with C++, including a Windows SDK.');
    const result = await execute(process.env.ComSpec || 'C:/Windows/System32/cmd.exe', ['/d', '/s', '/v:off', '/c', vsBootstrapCommand(tools.vsDevCmd)], { windowsVerbatimArguments: true, signal });
    const env = parseEnvironment(result.output);
    // Ninja must compare the exact /showIncludes prefix emitted by cl.exe.
    // Fix the locale before both configure and build to avoid ACP/UTF-8 mismatch.
    env.VSLANG = '1033';
    if (!findOnPath('cl.exe', env) || !envValue(env, 'WindowsSdkDir')) throw new Error('VsDevCmd did not provide cl.exe and a Windows SDK. Repair the Visual Studio C++ workload.');
    return env;
}
async function discoverTools(creatorPath, signal) {
    throwIfAborted(signal);
    const creator = discoverCreator(creatorPath);
    const vswhere = firstFile([process.env.VSWHERE_PATH, path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe'), findOnPath('vswhere.exe')]);
    let vsRoot = null;
    if (vswhere) {
        try {
            const result = await execute(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { signal });
            vsRoot = result.output.trim().split(/\r?\n/)[0] || null;
        } catch (error) { if (error.code === 'ABORT_ERR' || error.code === 'PROCESS_CLEANUP_FAILED') throw error; throwIfAborted(signal); /* Report missing tools through doctor checks. */ }
    }
    const vsDevCmd = firstFile([vsRoot && path.join(vsRoot, 'Common7/Tools/VsDevCmd.bat')]);
    const cmake = firstFile([process.env.COCOS_PLUGIN_CMAKE, creator && path.join(path.dirname(creator), 'resources/tools/cmake/bin/cmake.exe'), vsRoot && path.join(vsRoot, 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'), findOnPath('cmake.exe')]);
    const ninja = firstFile([process.env.COCOS_PLUGIN_NINJA, vsRoot && path.join(vsRoot, 'Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja/ninja.exe'), findOnPath('ninja.exe')]);
    // In an editor extension process.execPath is CocosCreator.exe, not Node.
    const node = firstFile([process.env.COCOS_PLUGIN_NODE, findOnPath('node.exe'), !process.versions.electron && process.execPath]);
    const clangd = firstFile([process.env.COCOS_PLUGIN_CLANGD, vsRoot && path.join(vsRoot, 'VC/Tools/Llvm/x64/bin/clangd.exe'), findOnPath('clangd.exe')]);
    const clangCl = firstFile([process.env.COCOS_PLUGIN_CLANG_CL, vsRoot && path.join(vsRoot, 'VC/Tools/Llvm/x64/bin/clang-cl.exe'), findOnPath('clang-cl.exe')]);
    return { creator, cmake, ninja, vswhere, vsDevCmd, clangd, clangCl, node };
}

function detectOutputEncoding(raw, prefix) {
    for (const encoding of ['utf-8', 'gbk', 'shift_jis', 'euc-kr', 'big5', 'windows-1252', 'windows-1251']) {
        try { if (new TextDecoder(encoding, { fatal: true }).decode(raw).includes(prefix)) return encoding; } catch (_) { /* Try the next Windows compiler locale. */ }
    }
    throw new Error('Cannot match MSVC /showIncludes output to the CMake dependency prefix. Install the Visual Studio English language pack, then reconfigure a fresh build directory.');
}
function compilerLauncherSource() {
    return `'use strict';\nconst cp = require('child_process');\nconst [encoding, compiler, ...args] = process.argv.slice(2);\nconst child = cp.spawn(compiler, args, { shell: false, windowsHide: true, stdio: ['inherit', 'pipe', 'pipe'] });\nfor (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {\n  const decoder = new TextDecoder(encoding);\n  input.on('data', chunk => output.write(decoder.decode(chunk, { stream: true })));\n  input.on('end', () => output.write(decoder.decode()));\n}\nchild.on('error', error => { console.error(error.message); process.exitCode = 1; });\nchild.on('close', code => { process.exitCode = code === null ? 1 : code; });\n`;
}
async function compilerOutputAdapter(state, compilerPath, env, signal) {
    throwIfAborted(signal);
    if (state.compiler !== 'msvc') return [];
    const rules = fs.readFileSync(path.join(state.buildDir, 'CMakeFiles/rules.ninja'), 'utf8');
    const prefixMatch = /^msvc_deps_prefix = (.+)$/m.exec(rules);
    if (!prefixMatch) return [];
    const prefix = prefixMatch[1].trimEnd();
    const probeDir = path.join(state.buildDir, '.plugin-dev-encoding');
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, 'probe.h'), '#define CPD_PROBE 1\n');
    fs.writeFileSync(path.join(probeDir, 'probe.c'), '#include "probe.h"\nint cpd_probe = CPD_PROBE;\n');
    const probe = await execute(compilerPath, ['/nologo', '/showIncludes', '/c', 'probe.c', '/Foprobe.obj'], { cwd: probeDir, env, captureBuffer: true, signal });
    const encoding = detectOutputEncoding(probe.buffer, prefix);
    if (encoding === 'utf-8') return [];
    const launcher = path.join(state.projectPath, '.plugin-dev/msvc-output.cjs');
    fs.writeFileSync(launcher, compilerLauncherSource());
    const value = [state.tools.node, launcher, encoding].map(slash).join(';');
    return [`-DCMAKE_C_COMPILER_LAUNCHER:STRING=${value}`, `-DCMAKE_CXX_COMPILER_LAUNCHER:STRING=${value}`];
}

async function doctor(options) {
    throwIfAborted(options.signal);
    const projectPath = projectRoot(options.projectPath);
    const previous = readState(projectPath);
    const tools = await discoverTools(options.creatorPath || previous.creatorPath, options.signal);
    const host = discoverHost(projectPath, options, previous);
    host.enginePath = normalizeEngine(options.enginePath || previous.enginePath || host.configuredEngine || bundledEngine(tools.creator));
    const checks = [
        { name: 'Windows', ok: process.platform === 'win32', required: true, message: process.platform === 'win32' ? 'Windows x64' : 'Native build requires Windows.' },
        ...['cmake', 'ninja', 'vsDevCmd', 'node'].map((name) => ({ name, ok: Boolean(tools[name]), required: true, message: tools[name] || (name === 'node' ? 'Install standalone Node.js 18+ (or set COCOS_PLUGIN_NODE).' : `Missing ${name}. Install Visual Studio C++ x64 tools and Windows SDK.`) })),
        { name: 'creator', ok: Boolean(tools.creator), required: !host.resourceDir, message: tools.creator || 'Creator is needed to prepare or refresh game assets.' },
        { name: 'clangd', ok: Boolean(tools.clangd), required: false, message: tools.clangd || 'Optional: install LLVM clangd for C++ navigation.' },
        { name: 'host', ok: Boolean(host.nativeSourceDir && host.resourceDir), required: false, message: host.nativeSourceDir && host.resourceDir ? host.nativeSourceDir : 'Use Prepare Host once to generate Windows native sources and Debug resources.' },
        { name: 'engine', ok: Boolean(host.enginePath), required: true, message: host.enginePath || 'Select an engine root containing native/CMakeLists.txt.' },
    ];
    const warnings = [];
    if (tools.creator && host.enginePath && !samePath(host.enginePath, bundledEngine(tools.creator))) warnings.push('Custom engine selected. Prepare Host passes --engine so the JS assets and C++ use the same engine; Creator/engine API compatibility must also hold.');
    if (host.configuredEngine && !samePath(host.configuredEngine, host.enginePath)) warnings.push('Host localCfg/cfg sets a different COCOS_X_PATH; configure will reject an engine override.');
    return { ok: checks.every((c) => !c.required || c.ok), projectPath, tools, host, checks, warnings };
}

async function prepareHostImpl(options) {
    throwIfAborted(options.signal);
    const report = await doctor(options);
    const { projectPath, tools } = report;
    if (!tools.creator && !options.prepareAssets) throw new Error('Creator not found. Set creatorPath to CocosCreator.exe.');
    const previous = readState(projectPath);
    syncPlugins(projectPath);
    const assetsSnapshot = pluginRecords(projectPath);
    const enginePath = report.host.enginePath;
    if (!enginePath) throw new Error('Select the engine before preparing the host.');
    let resourceDir = path.join(projectPath, 'build/windows-plugin-dev');
    const configPath = path.join(projectPath, '.plugin-dev/creator-windows-build.json');
    if (/[;\r\n]/.test(configPath)) throw new Error('Creator CLI configPath cannot contain semicolons or newlines.');
    // A separate asset output keeps an existing release build intact. stage=build
    // generates native sources/resources; CMake compilation is done below by us.
    const buildConfig = { platform: 'windows', buildPath: slash(path.join(projectPath, 'build')), outputName: 'windows-plugin-dev', debug: true, sourceMaps: true, md5Cache: false, stage: 'build', packages: { windows: { targetPlatform: 'win64' } } };
    writeJson(configPath, buildConfig);
    const logPath = path.join(projectPath, '.plugin-dev/logs/prepare-host.log');
    const args = ['--project', projectPath, '--engine', enginePath, '--build', `configPath=${slash(configPath)}`];
    emit(options, `Preparing official Windows host with ${tools.creator}\nEngine: ${enginePath}\nLog: ${logPath}\n`);
    let prepared = {};
    if (options.prepareAssets) {
        // The editor must validate its active JS engine before calling builder.
        // Reuse the current editor; opening a second process on the same project
        // would race its asset database. CLI callers use the branch below.
        prepared = await waitForAssets(options.prepareAssets, { projectPath, enginePath, buildConfig, configPath }, options.signal);
        if (!prepared.enginePath || !samePath(normalizeEngine(prepared.enginePath), enginePath)) throw new Error('Editor asset preparation did not confirm the selected engine. Check the active custom engine in Creator.');
        if (prepared.resourceDir) resourceDir = path.resolve(prepared.resourceDir);
    } else {
        await execute(tools.creator, args, { cwd: projectPath, onOutput: options.onOutput, logPath, successCodes: [CREATOR_BUILD_SUCCESS], signal: options.signal });
    }
    const host = discoverHost(projectPath, { resourceDir, nativeSourceDir: prepared.nativeSourceDir }, {});
    if (!host.nativeSourceDir || !host.resourceDir || !exists(path.join(resourceDir, 'data/main.js'))) throw new Error(`Creator reported success but the Windows host/resources are incomplete. Inspect ${logPath}.`);
    if (host.configuredEngine && !samePath(host.configuredEngine, enginePath)) throw new Error('Creator generated the host with a different engine than requested. Align the active editor engine before building.');
    const next = { ...previous, ...host, projectPath, resourceDir, enginePath, assetsEnginePath: enginePath, creatorPath: tools.creator, assetsPreparedAt: new Date().toISOString() };
    throwIfAborted(options.signal);
    saveState(projectPath, next);
    acknowledgePlugins(projectPath, assetsSnapshot, 'assetsDirty');
    return next;
}

async function waitForAssets(prepareAssets, request, signal) {
    throwIfAborted(signal);
    // Builder belongs to the user's editor. Its operation must settle before
    // cancellation can release our lock; do not race it against an AbortSignal.
    const result = await prepareAssets({ ...request, signal }) || {};
    throwIfAborted(signal);
    return result;
}

function cmakeArguments(state, compilerPath) {
    return ['-S', state.nativeSourceDir, '-B', state.buildDir, '-G', 'Ninja',
        '-DCMAKE_BUILD_TYPE:STRING=Debug', '-DCMAKE_EXPORT_COMPILE_COMMANDS:BOOL=ON',
        `-DCMAKE_MAKE_PROGRAM:FILEPATH=${slash(state.tools.ninja)}`,
        `-DCMAKE_C_COMPILER:FILEPATH=${slash(compilerPath)}`, `-DCMAKE_CXX_COMPILER:FILEPATH=${slash(compilerPath)}`,
        `-DRES_DIR:PATH=${slash(state.resourceDir)}`, `-DCOCOS_X_PATH:PATH=${slash(path.join(state.enginePath, 'native'))}`,
        `-DNODE_EXECUTABLE:FILEPATH=${slash(state.tools.node)}`, '-DUSE_PLUGINS:BOOL=ON', '-DUSE_V8_DEBUGGER:BOOL=ON'];
}
function fileApiExecutable(buildDir) {
    const reply = path.join(buildDir, '.cmake/api/v1/reply');
    if (!exists(reply)) return null;
    const indexFiles = fs.readdirSync(reply).filter((f) => /^index-.*\.json$/.test(f)).sort().reverse();
    if (!indexFiles.length) return null;
    const index = readJson(path.join(reply, indexFiles[0]));
    const codemodel = index.reply && index.reply['codemodel-v2'];
    if (!codemodel || !codemodel.jsonFile) return null;
    const model = readJson(path.join(reply, codemodel.jsonFile));
    const candidates = [];
    for (const config of model.configurations || []) for (const target of config.targets || []) {
        const data = readJson(path.join(reply, target.jsonFile));
        if (data.type === 'EXECUTABLE' && data.paths && data.paths.source === '.') {
            for (const artifact of data.artifacts || []) if (/\.exe$/i.test(artifact.path)) candidates.push(path.resolve(buildDir, artifact.path));
        }
    }
    if (candidates.length > 1) throw new Error('Host has several top-level executables. Select a single official game executable target.');
    return candidates[0] || null;
}
async function configureImpl(options) {
    throwIfAborted(options.signal);
    syncPlugins(projectRoot(options.projectPath));
    const report = await doctor(options);
    if (!report.ok) throw new Error(report.checks.filter((c) => c.required && !c.ok).map((c) => c.message).join('\n'));
    const { projectPath, tools, host } = report;
    const previous = readState(projectPath);
    if (!host.nativeSourceDir || !host.resourceDir) throw new Error('Windows host is not prepared. Run prepare-host (or build once for Windows in Creator), then configure.');
    if (!exists(path.join(host.resourceDir, 'data/main.js'))) throw new Error(`Missing ${host.resourceDir}/data/main.js. Prepare or refresh the game assets first.`);
    if (host.configuredEngine && !samePath(host.configuredEngine, host.enginePath)) throw new Error('The official host cfg/localCfg selects another engine. Align that project setting with enginePath before configuring; user configuration will not be overwritten.');
    if (previous.assetsEnginePath && !samePath(previous.assetsEnginePath, host.enginePath)) throw new Error('JS assets were prepared with another engine. Use Prepare Host / build --refresh-assets with the selected engine before compiling C++.');
    if (!previous.assetsEnginePath && !host.configuredEngine) throw new Error('Cannot verify which engine produced these JS resources. Use Prepare Host once with the selected engine; then C++ and JS share recorded provenance.');
    const compiler = options.compiler || previous.compiler || 'msvc';
    if (!['msvc', 'clang-cl'].includes(compiler)) throw new Error(`Unsupported compiler: ${compiler}`);
    const buildDir = path.join(projectPath, '.plugin-dev/build/windows');
    if (previous.compiler && previous.compiler !== compiler && exists(path.join(buildDir, 'CMakeCache.txt'))) throw new Error(`Build cache uses ${previous.compiler}. Move .plugin-dev/build/windows aside before switching compiler.`);
    if ((previous.configuredEnginePath || previous.enginePath) && !samePath(previous.configuredEnginePath || previous.enginePath, host.enginePath) && exists(path.join(buildDir, 'CMakeCache.txt'))) throw new Error('Build cache belongs to a different engine. Move .plugin-dev/build/windows aside before switching engine.');
    const env = await vsEnvironment(tools, options.signal);
    const compilerPath = compiler === 'clang-cl' ? tools.clangCl : findOnPath('cl.exe', env);
    if (!compilerPath) throw new Error(`Compiler ${compiler} not found. Install its x64 Windows toolchain.`);
    const state = { ...previous, projectPath, ...host, compiler, buildDir, tools, creatorPath: tools.creator };
    const query = path.join(buildDir, '.cmake/api/v1/query/codemodel-v2');
    fs.mkdirSync(path.dirname(query), { recursive: true }); fs.writeFileSync(query, '');
    const logPath = path.join(projectPath, '.plugin-dev/logs/configure.log');
    emit(options, `Configuring Windows Debug (${compiler}, Ninja).\nBuild: ${buildDir}\nLog: ${logPath}\n`);
    await execute(tools.cmake, cmakeArguments(state, compilerPath), { cwd: projectPath, env, logPath, onOutput: options.onOutput, signal: options.signal });
    // CMake stores its dependency prefix as UTF-8, while a Chinese-only MSVC
    // installation can emit CP936 despite VSLANG. Normalize compiler output,
    // otherwise Ninja silently records zero header dependencies.
    const adapter = await compilerOutputAdapter(state, compilerPath, env, options.signal);
    if (adapter.length) {
        emit(options, 'Normalizing localized MSVC output for reliable Ninja header dependencies.\n');
        await execute(tools.cmake, [...cmakeArguments(state, compilerPath), ...adapter], { cwd: projectPath, env, logPath, onOutput: options.onOutput, signal: options.signal });
    }
    if (!exists(path.join(buildDir, 'compile_commands.json'))) throw new Error('CMake succeeded without compile_commands.json; verify the Ninja generator.');
    const commands = readJson(path.join(buildDir, 'compile_commands.json'));
    const nativeRoot = slash(path.join(host.enginePath, 'native')).toLowerCase() + '/';
    if (!commands.some((command) => slash(path.resolve(command.directory, command.file)).toLowerCase().startsWith(nativeRoot))) throw new Error('Generated compilation database does not contain the selected engine. Check cfg.cmake/localCfg engine overrides.');
    state.executable = fileApiExecutable(buildDir);
    if (!state.executable) throw new Error('Cannot identify the Windows game executable from CMake File API.');
    state.configuredAt = new Date().toISOString();
    state.configuredEnginePath = state.enginePath;
    throwIfAborted(options.signal);
    saveState(projectPath, state);
    return state;
}
async function buildImpl(options) {
    throwIfAborted(options.signal);
    const projectPath = projectRoot(options.projectPath);
    syncPlugins(projectPath);
    const previous = readState(projectPath);
    const host = discoverHost(projectPath, options, previous);
    const assetsDirty = Object.values(pluginRecords(projectPath)).some((plugin) => plugin.assetsDirty);
    if (options.refreshAssets || assetsDirty || !host.nativeSourceDir || !host.resourceDir) await prepareHostImpl(options);
    if (Object.values(pluginRecords(projectPath)).some((plugin) => plugin.assetsDirty)) throw new Error('Plugin runtime sources changed while Creator was preparing assets. Build again to include those edits.');
    const buildSnapshot = pluginRecords(projectPath);
    const state = await configureImpl(options);
    const env = await vsEnvironment(state.tools, options.signal);
    throwIfAborted(options.signal);
    // The operation lock spans the whole build, preventing another CLI from
    // starting this project's executable between stopping it and relinking.
    const stopped = await processes.stopUnlocked(projectPath);
    if (stopped.stopped) emit(options, `Stopped the project's game (PID ${stopped.pid}) before rebuilding.\n`);
    throwIfAborted(options.signal);
    const logPath = path.join(projectPath, '.plugin-dev/logs/build.log');
    emit(options, `Building ${state.executable}\nLog: ${logPath}\n`);
    delete state.builtAt;
    saveState(projectPath, state);
    await execute(state.tools.cmake, ['--build', state.buildDir, '--config', 'Debug'], { cwd: projectPath, env, logPath, onOutput: options.onOutput, signal: options.signal });
    if (!exists(state.executable)) throw new Error('Build completed but the game executable is missing.');
    throwIfAborted(options.signal);
    state.builtAt = new Date().toISOString(); saveState(projectPath, state);
    syncPlugins(projectPath);
    acknowledgePlugins(projectPath, buildSnapshot, 'needsRebuild', true);
    await debugWorkspace({ ...options, projectPath });
    return state;
}
function runnableState(projectPath) {
    const state = readState(projectPath);
    if (!state.executable || !exists(state.executable) || !state.builtAt) throw new Error('Build the Windows host successfully before running.');
    const records = pluginRecords(projectPath);
    const dirty = new Set(require('./core.cjs').listPlugins({ projectPath })
        .filter((plugin) => plugin.needsRebuild || records[plugin.name]?.assetsDirty).map((plugin) => plugin.name));
    for (const [name, record] of Object.entries(records)) {
        if (record.detached && (record.needsRebuild || record.assetsDirty)) dirty.add(name);
    }
    if (dirty.size) throw new Error(`Plugins changed since the last successful build: ${[...dirty].join(', ')}. Build before running.`);
    return state;
}
async function runImpl(options) {
    throwIfAborted(options.signal);
    const projectPath = projectRoot(options.projectPath);
    const state = runnableState(projectPath);
    const result = await processes.startUnlocked(projectPath, state.executable, { signal: options.signal });
    emit(options, `${result.alreadyRunning ? 'Already running' : 'Started'} PID ${result.pid}. Native application logs: ${result.logPath}. Inspector normally listens on 127.0.0.1:6086.\n`);
    return result;
}

function locked(options, operation) {
    throwIfAborted(options.signal);
    const project = projectRoot(options.projectPath);
    return processes.withLock(project, () => operation({ ...options, projectPath: project }), options);
}
async function prepareHost(options) { return locked(options, prepareHostImpl); }
async function configure(options) { return locked(options, configureImpl); }
async function build(options) { return locked(options, buildImpl); }
async function run(options) { return locked(options, runImpl); }
async function stop(options) {
    return locked(options, async (input) => {
        const result = await processes.stopUnlocked(input.projectPath);
        emit(input, result.stopped ? `Stopped game PID ${result.pid}.\n` : 'No game started by this project is running.\n');
        return result;
    });
}
async function restart(options) {
    return locked(options, async (input) => {
        runnableState(input.projectPath);
        await processes.stopUnlocked(input.projectPath);
        throwIfAborted(input.signal);
        return { ...await runImpl(input), restarted: true };
    });
}

function workspaceData(state, projectPath, cliPath, nodePath, inspectorPort, plugins = []) {
    const folders = [{ name: 'Game', path: projectPath }];
    if (state.enginePath) folders.push({ name: 'Engine', path: state.enginePath });
    const sourceMapPathOverrides = {};
    for (const plugin of plugins.filter((item) => item.sourceType === 'local')) {
        folders.push({ name: `Plugin: ${plugin.name}`, path: plugin.sourcePath });
        for (const rel of support.walk(path.join(plugin.sourcePath, 'runtime'))) {
            if (!/\.[cm]?[jt]sx?$/.test(rel)) continue;
            // Creator 3.8 can prefix a source with duplicated file: URLs. Match
            // the final absolute asset path so both forms open the real source.
            const mirror = slash(path.join(projectPath, 'assets', '__plugin_dev', plugin.name, rel));
            sourceMapPathOverrides[`*${mirror}`] = slash(path.join(plugin.sourcePath, 'runtime', rel));
        }
    }
    const buildDir = state.buildDir || path.join(projectPath, '.plugin-dev/build/windows');
    const buildArgs = [cliPath, 'build', '--project', projectPath];
    if (state.enginePath) buildArgs.push('--engine-path', state.enginePath);
    if (state.creatorPath) buildArgs.push('--creator-path', state.creatorPath);
    return {
        folders,
        settings: { 'clangd.arguments': [`--compile-commands-dir=${slash(buildDir)}`, '--background-index'], ...(state.tools && state.tools.clangd ? { 'clangd.path': state.tools.clangd } : {}), 'C_Cpp.intelliSenseEngine': 'disabled' },
        extensions: { recommendations: ['llvm-vs-code-extensions.vscode-clangd', 'ms-vscode.cpptools'] },
        tasks: { version: '2.0.0', tasks: [{ label: 'Plugin Dev: Build Windows', type: 'process', command: nodePath, args: buildArgs, options: { cwd: projectPath }, problemMatcher: '$msCompile', group: { kind: 'build', isDefault: true } }] },
        launch: { version: '0.2.0', configurations: [
            { name: 'Plugin Dev: C++ launch', type: 'cppvsdbg', request: 'launch', program: state.executable || path.join(buildDir, 'CocosGame.exe'), cwd: state.executable ? path.dirname(state.executable) : buildDir, args: [], stopAtEntry: false, preLaunchTask: 'Plugin Dev: Build Windows' },
            { name: 'Plugin Dev: TS attach (running game)', type: 'pwa-node', request: 'attach', address: '127.0.0.1', port: inspectorPort, restart: false, sourceMaps: true, sourceMapPathOverrides, localRoot: projectPath, outFiles: [slash(path.join(buildDir, 'Resources/**/*.js'))], resolveSourceMapLocations: [slash(path.join(buildDir, 'Resources/**')), '!**/node_modules/**'], skipFiles: ['<node_internals>/**'] },
        ], compounds: [{ name: 'Plugin Dev: C++ + TS', configurations: ['Plugin Dev: C++ launch', 'Plugin Dev: TS attach (running game)'], stopAll: true }] },
    };
}
async function debugWorkspace(options) {
    throwIfAborted(options.signal);
    const projectPath = projectRoot(options.projectPath);
    const state = readState(projectPath);
    if (!state.configuredAt || !state.executable) throw new Error('Configure the Windows host first so the debugger can use the actual executable.');
    const inspectorPort = options.inspectorPort === undefined ? 6086 : Number(options.inspectorPort);
    if (!Number.isInteger(inspectorPort) || inspectorPort < 1 || inspectorPort > 65535) throw new Error('inspectorPort must be between 1 and 65535.');
    const workspacePath = path.join(projectPath, '.plugin-dev/plugin-dev.code-workspace');
    const cliPath = path.resolve(__dirname, '../cli.cjs');
    const plugins = require('./core.cjs').listPlugins({ projectPath });
    writeJson(workspacePath, workspaceData(state, projectPath, cliPath, state.tools && state.tools.node || process.execPath, inspectorPort, plugins));
    const warnings = ['TS uses the native V8 Inspector, separately from cppvsdbg. Attach after the game starts; compound launch can require retrying TS attach.', 'TS breakpoints need Creator-generated source maps. If a breakpoint stays unbound, inspect the built bundle/source map and attach to emitted JavaScript first.', `Port ${inspectorPort} is the stock Game.cpp default; Cocos can increment it if occupied. Check the game log for the actual port.`, `Official Chrome DevTools fallback: devtools://devtools/bundled/js_app.html?v8only=true&ws=127.0.0.1:${inspectorPort}/00010002-0003-4004-8005-000600070008`, 'A native breakpoint pauses V8 too. The TS debugger may temporarily disconnect while C++ is paused.'];
    emit(options, `Debug workspace: ${workspacePath}\n${warnings.join('\n')}\n`);
    return { workspacePath, warnings };
}

module.exports = { doctor, prepareHost, configure, build, run, stop, restart, debugWorkspace,
    _internal: { CREATOR_BUILD_SUCCESS, discoverCreator, cmakeSet, discoverHost, normalizeEngine, cmakeArguments, vsBootstrapCommand, parseEnvironment, workspaceData, fileApiExecutable, execute, acknowledgePlugins, detectOutputEncoding, compilerLauncherSource, waitForAssets } };
