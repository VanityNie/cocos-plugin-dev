'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ide = require('../lib/ide.cjs');
const { parseArgs } = require('../cli.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpd-ide-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installationPath = path.join(root, 'Visual Studio', '18', 'Community');
    const bundled = path.join(installationPath, 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe');
    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    fs.writeFileSync(bundled, '');
    const oldCMake = path.join(root, 'Creator', 'cmake.exe');
    fs.mkdirSync(path.dirname(oldCMake), { recursive: true });
    fs.writeFileSync(oldCMake, '');
    const state = { projectPath: path.join(root, 'Game'), nativeSourceDir: path.join(root, 'Game/native/engine/win64'),
        resourceDir: path.join(root, 'Game/build/windows-plugin-dev'), enginePath: path.join(root, 'Engine'),
        buildDir: path.join(root, 'Game/.plugin-dev/build/windows'), buildType: 'RelWithDebInfo', compiler: 'msvc',
        tools: { cmake: oldCMake, node: process.execPath, vswhere: path.join(root, 'vswhere.exe'),
            vsDevCmd: path.join(installationPath, 'Common7/Tools/VsDevCmd.bat') } };
    return { root, state, installationPath, bundled, oldCMake };
}

test('CLI selects an IDE explicitly and rejects unsupported or irrelevant values', () => {
    assert.equal(parseArgs(['debug', '--project', '.', '--ide', 'visual-studio']).options.ide, 'visual-studio');
    assert.equal(ide.normalizeIDE(), 'vscode');
    assert.throws(() => parseArgs(['debug', '--ide', 'vs']), /Unsupported IDE/);
    assert.throws(() => parseArgs(['build', '--ide', 'vscode']), /only available for debug/);
});

test('CMake Tools and clangd share the Ninja cache and exact toolchain settings', (t) => {
    const { state } = fixture(t);
    const input = ['-S', state.nativeSourceDir, '-B', state.buildDir, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE:STRING=RelWithDebInfo', '-DUSE_PLUGINS:BOOL=ON'];
    const { settings, extensions } = ide.vscodeIntegration(state,
        { Path: 'C:/VC/bin;C:/Windows', INCLUDE: 'C:/VC/include', LIB: 'C:/VC/lib', VSLANG: '1033', PRIVATE_TOKEN: 'never-copy' }, input);
    assert.equal(settings['cmake.configureOnOpen'], false);
    assert.equal(settings['cmake.generator'], 'Ninja');
    assert.equal(settings['cmake.buildDirectory'], state.buildDir.replace(/\\/g, '/'));
    assert.match(settings['clangd.arguments'][0], /\/build\/windows$/);
    assert.deepEqual(settings['cmake.configureArgs'], input.slice(6));
    assert.equal(settings['cmake.configureEnvironment'].INCLUDE, 'C:/VC/include');
    assert.equal(settings['cmake.buildEnvironment'].PRIVATE_TOKEN, undefined);
    assert.equal(settings['cmake.cmakePath'], state.tools.cmake);
    assert.equal(settings['cmake.defaultVariants'].buildType.default, 'RelWithDebInfo');
    assert(extensions.recommendations.includes('ms-vscode.cmake-tools'));
});

test('unprepared VS Code workspaces expose the future compilation database without configuring', (t) => {
    const { state } = fixture(t);
    const result = ide.vscodeIntegration({ projectPath: state.projectPath });
    assert.equal(result.settings['cmake.configureOnOpen'], false);
    assert.equal(result.settings['cmake.sourceDirectory'], undefined);
    assert.equal(result.settings['cmake.configureEnvironment'], undefined);
    assert.match(result.settings['clangd.arguments'][0], /\/build\/windows$/);
});

for (const version of [{ major: 17, year: 2022, extension: '.sln' }, { major: 18, year: 2026, extension: '.slnx' }]) {
test(`Visual Studio ${version.year} generates ${version.extension} in a separate cache without rebuilding Ninja`, async (t) => {
    const { state, installationPath, bundled, oldCMake } = fixture(t);
    fs.mkdirSync(state.buildDir, { recursive: true });
    const ninjaCache = path.join(state.buildDir, 'CMakeCache.txt');
    fs.writeFileSync(ninjaCache, 'CMAKE_GENERATOR:INTERNAL=Ninja\n');
    const calls = [];
    const env = { Path: 'C:/VC/bin', INCLUDE: 'C:/VC/include' };
    const execute = async (command, args, options) => {
        calls.push({ command, args, options });
        if (command === state.tools.vswhere) return { output: JSON.stringify([{ installationPath, installationVersion: `${version.major}.1.0` }]) };
        if (args[0] === '-E') return { output: JSON.stringify({ version: { string: '4.2.0' }, generators: [{ name: `Visual Studio ${version.major} ${version.year}` }] }) };
        const buildDir = args[args.indexOf('-B') + 1];
        fs.writeFileSync(path.join(buildDir, `Game${version.extension}`), version.major === 18 ? '<Solution />\n' : 'Microsoft Visual Studio Solution File\n');
        return { output: '' };
    };
    const result = await ide.generateVisualStudioSolution(state, { execute, env });
    assert.equal(result.ide, 'visual-studio');
    assert.equal(result.generator, `Visual Studio ${version.major} ${version.year}`);
    assert.equal(result.cmakePath, bundled);
    assert(result.solutionPath.endsWith(path.join('visual-studio', `Game${version.extension}`)));
    assert.equal(result.solutionFormat, version.extension);
    assert.equal(result.workspacePath, result.solutionPath);
    assert.equal(fs.readFileSync(ninjaCache, 'utf8'), 'CMAKE_GENERATOR:INTERNAL=Ninja\n');
    assert.equal(calls.some((call) => call.command === oldCMake), false);
    const configure = calls.at(-1);
    assert.equal(configure.options.env, env);
    assert(configure.args.includes('-DCMAKE_CONFIGURATION_TYPES:STRING=RelWithDebInfo'));
    assert(configure.args.includes('-DUSE_V8_DEBUGGER_FORCE:BOOL=ON'));
    assert.equal(configure.args.some((value) => value.startsWith('-DCMAKE_MAKE_PROGRAM')), false);
    assert.equal(configure.args.some((value) => value.startsWith('-DCMAKE_C_COMPILER')), false);
    assert(fs.existsSync(path.join(result.buildDir, '.cmake/api/v1/query/codemodel-v2')));
});
}

test('Visual Studio generation reports unsupported CMake and missing solution failures', async (t) => {
    const { state, installationPath } = fixture(t);
    const execute = async (command, args) => command === state.tools.vswhere
        ? { output: JSON.stringify([{ installationPath, installationVersion: '18.1.0' }]) }
        : { output: JSON.stringify({ version: { string: '3.24.3' }, generators: [{ name: 'Visual Studio 17 2022' }] }) };
    await assert.rejects(ide.generateVisualStudioSolution(state, { execute }), /No installed CMake supports Visual Studio 18/);
    await assert.rejects(ide.generateVisualStudioSolution(state, {
        execute: async (command, args) => command === state.tools.vswhere ? execute(command, args)
            : args[0] === '-E' ? { output: JSON.stringify({ version: { string: '4.2.0' }, generators: [{ name: 'Visual Studio 18 2026' }] }) }
                : { output: '' },
    }), /Expected one Visual Studio solution/);
});

test('Visual Studio errors and cancellation are not converted to success or silently retried', async (t) => {
    const { state, installationPath } = fixture(t);
    const controller = new AbortController();
    const failure = new Error('Configure failed: invalid plugin CMake target');
    await assert.rejects(ide.generateVisualStudioSolution(state, {
        signal: controller.signal,
        execute: async (command, args, options) => {
            assert.equal(options.signal, controller.signal);
            if (command === state.tools.vswhere) return { output: JSON.stringify([{ installationPath, installationVersion: '18.1.0' }]) };
            if (args[0] === '-E') return { output: JSON.stringify({ version: { string: '4.2.0' }, generators: [{ name: 'Visual Studio 18 2026' }] }) };
            throw failure;
        },
    }), (error) => error === failure);
});

test('Visual Studio uses ClangCL only when explicitly selected and keeps Release Inspector disabled', () => {
    const state = { nativeSourceDir: 'source', resourceDir: 'resources', enginePath: 'engine', tools: { node: process.execPath }, buildType: 'Release', compiler: 'clang-cl' };
    const args = ide._internal.visualStudioArguments(state, { generator: 'Visual Studio 18 2026', installationPath: 'VS' }, 'build');
    assert.equal(args[args.indexOf('-T') + 1], 'ClangCL');
    assert(args.includes('-DUSE_V8_DEBUGGER:BOOL=OFF'));
    assert(args.includes('-DCMAKE_CONFIGURATION_TYPES:STRING=Release'));
});
