#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HELP = `Cocos Plugin Dev — Windows

node cli.cjs <command> --project <Creator project> [options]

  install     Install this developer extension into the project
  create      Create a TS + C++ plugin (--name, --template native|render)
  link        Attach existing plugin source to this host (--source-path)
  unlink      Detach local plugin source; keep source and asset UUIDs (--name)
  list        Show project plugins
  enable      Enable a plugin (--name)
  disable     Disable a plugin (--name); native changes require rebuilding
  sync        Synchronize runtime sources (--name)
  package     Export an installable plugin (--name, --output-dir, --binary)
  doctor      Inspect Windows tools and the native host
  prepare     Build project assets and generate the official Windows host
  configure   Configure an independent native development build
  build       Incrementally build; --refresh-assets rebuilds project assets first
  run         Run the built Windows game
  stop        Stop the game started by this workbench
  restart     Restart the built game without rebuilding
  debug       Generate a VS Code workspace or a Visual Studio solution (--ide)
  sandbox     Create an independent project from the installed Creator 3D template

Options:
  --plugin-path <directory>         Create independent source here; --project optionally attaches a host
  --source-path <directory>         Existing independent plugin source for link
  --creator-path <CocosCreator.exe>  Select Creator
  --engine-path <engine root>       Select native engine (must match built JS assets)
  --compiler msvc|clang-cl          Windows compiler
  --platform windows|android        Target native platform for doctor/configure/build/package (default: windows)
  --abi arm64-v8a|armeabi-v7a|x86_64|x86  Android ABI for --platform android (default: arm64-v8a)
  --ndk-path <NDK root>             Android NDK root directory (containing build/cmake/android.toolchain.cmake)
  --ide vscode|visual-studio        IDE project format for debug (default: vscode)
  --build-type Debug|RelWithDebInfo|Release  构建配置；package --binary 缺省使用最近成功构建的配置
  --binary                         导出已构建的 Windows (.lib) 或 Android (.a) 原生静态库，仅用于 package
  --display-name <label>            Plugin display name
  --native-source-dir <directory>   Explicit generated Windows CMake source
  --resource-dir <directory>        Explicit Creator Windows build resources

JSON results go to stdout; progress goes to stderr. Existing project content is
never replaced by sandbox creation. Use Creator's plugin panel for the GUI flow.
`;

function parseArgs(argv) {
    const [command, ...rest] = argv;
    const options = {};
    const keys = {
        project: 'projectPath', name: 'name', template: 'template',
        'display-name': 'displayName', 'output-dir': 'outputDir',
        'creator-path': 'creatorPath', 'engine-path': 'enginePath',
        compiler: 'compiler', platform: 'platform', abi: 'abi', 'ndk-path': 'ndkPath',
        'android-platform': 'androidPlatform', 'android-stl': 'androidStl',
        ide: 'ide', 'build-type': 'buildType', 'native-source-dir': 'nativeSourceDir',
        'resource-dir': 'resourceDir',
        'plugin-path': 'pluginPath', 'source-path': 'sourcePath',
    };
    for (let i = 0; i < rest.length; ++i) {
        const flag = rest[i];
        if (flag === '--refresh-assets') { options.refreshAssets = true; continue; }
        if (flag === '--binary') {
            if (command !== 'package') throw new Error('--binary 仅用于 package。');
            if (options.binary !== undefined) throw new Error('参数重复: --binary');
            options.binary = true;
            continue;
        }
        const key = keys[flag.replace(/^--/, '')];
        if (!flag.startsWith('--') || !key) throw new Error(`Unknown argument: ${flag}`);
        if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`);
        if (options[key] !== undefined) throw new Error(`Duplicate argument: ${flag}`);
        options[key] = rest[++i];
    }
    for (const key of ['projectPath', 'pluginPath', 'sourcePath', 'ndkPath']) {
        if (options[key]) options[key] = path.resolve(options[key]);
    }
    if (options.platform !== undefined) {
        if (!['doctor', 'configure', 'build', 'package'].includes(command)) {
            throw new Error('--platform is only available for doctor, configure, build, and package.');
        }
        const normalizedPlatform = String(options.platform).trim().toLowerCase();
        if (!['windows', 'android'].includes(normalizedPlatform)) {
            throw new Error(`Unsupported platform: ${options.platform}. Use windows or android.`);
        }
        options.platform = normalizedPlatform;
    }
    if (options.abi !== undefined) {
        if (!['doctor', 'configure', 'build', 'package'].includes(command)) {
            throw new Error('--abi is only available for doctor, configure, build, and package.');
        }
        if (options.platform !== 'android') {
            throw new Error('--abi requires --platform android.');
        }
        options.abi = require(path.join(__dirname, 'lib/android.cjs'))._internal.normalizeAbi(options.abi);
    }
    if (options.ndkPath !== undefined || options.androidPlatform !== undefined || options.androidStl !== undefined) {
        if (!['doctor', 'configure', 'build'].includes(command) || options.platform !== 'android') {
            throw new Error('--ndk-path, --android-platform, and --android-stl require doctor/configure/build with --platform android.');
        }
    }
    if (command === 'package' && options.buildType !== undefined && options.binary !== true) {
        throw new Error('package 使用 --build-type 时必须同时指定 --binary。');
    }
    if (command === 'package' && options.platform !== undefined && options.binary !== true && options.platform !== 'windows') {
        throw new Error('package 使用 --platform android 时必须同时指定 --binary。');
    }
    if (options.ide !== undefined) {
        if (command !== 'debug') throw new Error('--ide is only available for debug.');
        options.ide = require('./lib/ide.cjs').normalizeIDE(options.ide);
    }
    return { command, options };
}

function createSandbox(options) {
    const target = options.projectPath;
    if (fs.existsSync(target)) throw new Error(`Sandbox path already exists: ${target}`);
    const creatorPath = require('./lib/windows.cjs')._internal.discoverCreator(options.creatorPath);
    if (!creatorPath) throw new Error('Creator not found. Pass --creator-path to its installation directory or CocosCreator.exe.');
    const creatorDir = path.extname(creatorPath).toLowerCase() === '.exe' ? path.dirname(creatorPath) : creatorPath;
    const templatePath = path.join(creatorDir, 'resources', 'templates', 'hello-3d-world');
    if (!fs.existsSync(path.join(templatePath, 'package.json'))) {
        throw new Error(`Creator 3D template not found: ${templatePath}. Pass --creator-path.`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(templatePath, target, { recursive: true, errorOnExist: true, force: false });
    const packagePath = path.join(target, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    manifest.name = 'plugin-development-sandbox';
    manifest.uuid = crypto.randomUUID();
    fs.writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n');
    const settingsDir = path.join(target, '.plugin-dev');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'ui-settings.json'), JSON.stringify({
        creatorPath: path.join(creatorDir, 'CocosCreator.exe'),
        enginePath: options.enginePath || path.join(creatorDir, 'resources', 'resources', '3d', 'engine'),
    }, null, 2) + '\n');
    return { projectPath: target, templatePath, message: 'Independent sandbox created. Install the tools, create a plugin, then use Build & Run to prepare and build automatically.' };
}

function checkCancelled(signal) {
    if (!signal || !signal.aborted) return;
    const error = new Error('Operation cancelled.');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
}

async function main(argv, { signal } = {}) {
    checkCancelled(signal);
    if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) return process.stdout.write(HELP);
    const { command, options } = parseArgs(argv);
    if (!options.projectPath && !(command === 'create' && options.pluginPath)) {
        throw new Error('--project is required; standalone create uses --plugin-path');
    }
    const settingsPath = options.projectPath && path.join(options.projectPath, '.plugin-dev', 'ui-settings.json');
    let settings = {};
    if (command !== 'sandbox' && settingsPath && fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    const input = { ...settings, ...options, signal, onOutput: (message) => process.stderr.write(String(message)) };
    if (command === 'package') {
        input.binary = options.binary === true;
        delete input.buildType;
        delete input.platform;
        delete input.abi;
        if (options.buildType !== undefined) input.buildType = options.buildType;
        if (options.platform !== undefined) input.platform = options.platform;
        if (options.abi !== undefined) input.abi = options.abi;
    }
    let result;
    if (command === 'sandbox') result = createSandbox(input);
    else if (['install', 'create', 'link', 'unlink', 'list', 'enable', 'disable', 'sync', 'package'].includes(command)) {
        const core = require('./lib/core.cjs');
        if (command === 'install') result = await core.installTools({ ...input, sourcePath: __dirname });
        else if (command === 'create') result = await core.createPlugin({ ...input, template: input.template || 'native' });
        else if (command === 'link') result = await core.linkPlugin(input);
        else if (command === 'unlink') result = await core.unlinkPlugin(input);
        else if (command === 'list') result = await core.listPlugins(input);
        else if (command === 'enable' || command === 'disable') result = await core.setEnabled({ ...input, enabled: command === 'enable' });
        else if (command === 'sync') result = await core.syncPlugin(input);
        else result = await core.packagePlugin(input);
    } else if (options.platform === 'android') {
        const android = require('./lib/android.cjs');
        const method = { doctor: 'doctor', configure: 'configure', build: 'build' }[command];
        if (!method) throw new Error(`Command ${command} is not supported for --platform android.`);
        result = await android[method]({ ...input, abi: options.abi || settings.androidAbi });
    } else {
        const windows = require('./lib/windows.cjs');
        const method = { doctor: 'doctor', prepare: 'prepareHost', configure: 'configure', build: 'build', run: 'run', stop: 'stop', restart: 'restart', debug: 'debugWorkspace' }[command];
        if (!method) throw new Error(`Unknown command: ${command}`);
        result = await windows[method](input);
    }
    checkCancelled(signal);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function runCLI(argv) {
    const controller = new AbortController();
    const cancel = () => {
        if (controller.signal.aborted) return;
        process.stderr.write('Cancelling; waiting for active work to stop...\n');
        controller.abort();
    };
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
        await main(argv, { signal: controller.signal });
    } catch (error) {
        const cancelled = error.name === 'AbortError' || error.code === 'ABORT_ERR';
        process.stderr.write(`Plugin development: ${cancelled ? 'Operation cancelled.' : error.message}\n`);
        process.exitCode = cancelled ? 130 : 1;
    } finally {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
    }
}

if (require.main === module) runCLI(process.argv.slice(2));

module.exports = { parseArgs, createSandbox, main, runCLI };
