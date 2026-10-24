'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');
const windows = require('../lib/windows.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');
const { ensureWindowsBuildHook } = require('../templates/common/editor/windows-build.cjs');
const internal = windows._internal;

function directory(t) {
    const parent = path.resolve(__dirname, '../.local');
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'build-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('旧构建状态采用 Debug 默认值，并在配置切换时取消构建确认', () => {
    const previous = { builtAt: '2026-01-01', configuredAt: '2026-01-01' };
    assert.equal(internal.configuredState(previous, { buildType: 'Debug' }).builtAt, previous.builtAt);
    for (const buildType of ['RelWithDebInfo', 'Release']) {
        const state = internal.configuredState(previous, { buildType });
        assert.equal(state.builtAt, undefined);
        assert.equal(state.configuredAt, undefined);
        assert.equal(state.buildType, buildType);
    }
    const current = { buildType: 'RelWithDebInfo', builtBuildType: 'RelWithDebInfo', builtAt: '2026-01-01' };
    assert.equal(internal.configuredState(current, {}).builtAt, undefined);
    assert.equal(internal.configuredState({ ...current, inspectorEnabled: true }, {}).builtAt, current.builtAt);
    assert.equal(internal.configuredState({ ...current, inspectorEnabled: true }, { buildType: 'Release' }).builtBuildType, undefined);
});

test('CMake 参数与调试工作区使用相同的 Inspector 配置', t => {
    const project = directory(t);
    const base = { nativeSourceDir: project, buildDir: path.join(project, 'build'), resourceDir: project, enginePath: project, tools: { ninja: 'ninja', node: process.execPath } };
    for (const buildType of ['Debug', 'RelWithDebInfo', 'Release']) {
        const state = { ...base, buildType, configuredAt: 'now', builtAt: 'now', executable: path.join(project, 'Game.exe'), runningPid: 1234 };
        const enabled = buildType !== 'Release';
        const args = internal.cmakeArguments(state, 'cl.exe');
        assert.ok(args.includes(`-DUSE_V8_DEBUGGER:BOOL=${enabled ? 'ON' : 'OFF'}`));
        assert.ok(args.includes(`-DUSE_V8_DEBUGGER_FORCE:BOOL=${buildType === 'RelWithDebInfo' ? 'ON' : 'OFF'}`));
        const workspace = internal.workspaceData(state, project, 'cli.cjs', process.execPath, 6086);
        assert.equal(workspace.launch.configurations.some(config => config.type === 'pwa-node'), enabled);
        assert.equal(workspace.launch.compounds.length, enabled ? 1 : 0);
    }
});

test('CMake hook 保存归属并拒绝修改后的宿主文件', t => {
    const project = directory(t);
    const source = path.join(project, 'native/engine/win64');
    fs.mkdirSync(source, { recursive: true });
    const result = ensureWindowsBuildHook(project, source);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.equal(manifest.files[result.hookPath.toLowerCase()].sha256, support.hash(fs.readFileSync(result.hookPath)));
    assert.deepEqual(ensureWindowsBuildHook(project, source), result);
    fs.appendFileSync(result.hookPath, '\nset(USER_SETTING ON)\n');
    assert.throws(() => ensureWindowsBuildHook(project, source), /unmanaged or modified content/);
    assert.match(fs.readFileSync(result.hookPath, 'utf8'), /USER_SETTING/);
});

test('CMake hook 在已有用户文件发生冲突时保持全部文件内容', t => {
    const project = directory(t);
    const source = path.join(project, 'native/engine/win64');
    fs.mkdirSync(source, { recursive: true });
    const hookPath = path.join(source, 'Post-PluginDevWindows.cmake');
    const ignorePath = path.join(source, '.gitignore');
    const originalIgnore = '*.user\r\n';
    fs.writeFileSync(ignorePath, originalIgnore);
    fs.writeFileSync(hookPath, 'set(USER_SETTING ON)\n');
    assert.throws(() => ensureWindowsBuildHook(project, source), /unmanaged or modified content/);
    assert.equal(fs.existsSync(path.join(project, '.plugin-dev/native-build/windows-build.cmake')), false);
    assert.equal(fs.readFileSync(hookPath, 'utf8'), 'set(USER_SETTING ON)\n');
    assert.equal(fs.readFileSync(ignorePath, 'utf8'), originalIgnore);
});

test('真实 Git 忽略生成的 CMake hook，并保留用户已有忽略规则', t => {
    const project = directory(t);
    execFileSync('git', ['init', '--quiet', project], { windowsHide: true });
    const source = path.join(project, 'native/engine/win64');
    fs.mkdirSync(source, { recursive: true });
    const ignorePath = path.join(source, '.gitignore');
    const userRules = Buffer.from('*.user\r\n!Post-PluginDevWindows.cmake');
    fs.writeFileSync(ignorePath, userRules);
    const result = ensureWindowsBuildHook(project, source);
    const ignore = fs.readFileSync(ignorePath);
    assert.deepEqual(ignore.subarray(0, userRules.length), userRules);
    const relativeHook = path.relative(project, result.hookPath).replace(/\\/g, '/');
    const check = execFileSync('git', ['-C', project, 'check-ignore', '--', relativeHook, 'native/engine/win64/custom.user'], { windowsHide: true, encoding: 'utf8' });
    assert.ok(check.includes(relativeHook));
    assert.ok(check.includes('native/engine/win64/custom.user'));
    ensureWindowsBuildHook(project, source);
    assert.deepEqual(fs.readFileSync(ignorePath), ignore);
    const tracked = execFileSync('git', ['-C', project, 'ls-files', '--others', '--exclude-standard'], { windowsHide: true, encoding: 'utf8' });
    assert.equal(tracked.includes('Post-PluginDevWindows.cmake'), false);
    assert.ok(tracked.includes('native/engine/win64/.gitignore'));
});

test('CMake hook 的忽略文件无效时在写入支持文件之前失败', t => {
    const project = directory(t);
    const source = path.join(project, 'native/engine/win64');
    fs.mkdirSync(path.join(source, '.gitignore'), { recursive: true });
    assert.throws(() => ensureWindowsBuildHook(project, source), /ignore target is not a file/);
    assert.equal(fs.existsSync(path.join(source, 'Post-PluginDevWindows.cmake')), false);
    assert.equal(fs.existsSync(path.join(project, '.plugin-dev/native-build')), false);
});

test('真实 V8 imported targets 在三个配置下编译、部署并启动', { skip: process.env.COCOS_PLUGIN_NATIVE_TESTS !== '1', timeout: 120000 }, async t => {
    const project = directory(t);
    fs.mkdirSync(path.join(project, 'assets'));
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'v8-configuration-probe' }));
    const report = await windows.doctor({ projectPath: project });
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    const environment = await internal.execute(process.env.ComSpec, ['/d', '/s', '/v:off', '/c', internal.vsBootstrapCommand(report.tools.vsDevCmd)], { windowsVerbatimArguments: true });
    const env = internal.parseEnvironment(environment.output);
    env.VSLANG = '1033';
    for (const buildType of ['Debug', 'RelWithDebInfo', 'Release', 'Debug']) {
        const buildDir = path.join(project, 'build');
        const cmake = report.tools.cmake;
        const source = path.join(__dirname, 'fixtures/windows-build');
        await internal.execute(cmake, ['-S', source, '-B', buildDir, '-G', 'Ninja',
            `-DCMAKE_BUILD_TYPE=${buildType}`, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
            `-DCMAKE_MAKE_PROGRAM=${report.tools.ninja}`, `-DENGINE_PATH=${report.host.enginePath}`,
            `-DCPD_PROJECT_PATH=${project}`, `-DRES_DIR=${project}`, `-DNODE_EXECUTABLE=${process.execPath}`,
            `-DPLUGIN_DEV_CMAKE=${path.resolve(__dirname, '../templates/common/editor/windows-build.cmake')}`,
            `-DUSE_V8_DEBUGGER=${buildType === 'Release' ? 'OFF' : 'ON'}`,
            `-DUSE_V8_DEBUGGER_FORCE=${buildType === 'RelWithDebInfo' ? 'ON' : 'OFF'}`], { env });
        await internal.execute(cmake, ['--build', buildDir], { env });
        const executable = path.join(buildDir, 'v8-configuration-probe.exe');
        const result = await internal.execute(executable, [], { env });
        assert.match(result.output, /V8=\d+\.\d+/);
        assert.match(result.output, new RegExp(`Inspector=${buildType === 'Release' ? '0' : '1'}`));
        const dependencyConfig = buildType === 'Debug' ? 'debug' : 'release';
        for (const name of ['v8', 'v8_libbase', 'v8_libplatform', 'third_party_zlib']) {
            const expected = path.join(report.host.enginePath, 'native/external/win64/libs/v8', dependencyConfig, `${name}.dll`);
            assert.equal(support.hash(fs.readFileSync(path.join(buildDir, `${name}.dll`))), support.hash(fs.readFileSync(expected)));
        }
    }
});
