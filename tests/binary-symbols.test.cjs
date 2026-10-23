'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../lib/core.cjs');
const windows = require('../lib/windows.cjs');
const binary = require('../lib/binary-artifacts.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');

const fixtures = path.join(__dirname, 'fixtures/binary-symbols');
const slash = value => value.replace(/\\/g, '/');

for (const [buildType, symbolFormat] of [['Debug', 'Zi'], ['RelWithDebInfo', 'Zi'], ['Debug', 'ZI'], ['Debug', 'Z7']]) test(`真实 ${buildType} /${symbolFormat} 发布包在作者目录迁移后保留函数符号和源码行号`, {
    skip: process.env.COCOS_PLUGIN_NATIVE_TESTS !== '1', timeout: 120000,
}, async t => {
    const local = path.resolve(__dirname, '../.local');
    fs.mkdirSync(local, { recursive: true });
    const root = fs.mkdtempSync(path.join(local, 'binary-symbols-'));
    t.diagnostic(root);
    const project = path.join(root, 'producer');
    const plugin = path.join(project, 'extensions/binary-symbols');
    fs.mkdirSync(path.join(project, 'assets'), { recursive: true });
    support.writeJson(path.join(project, 'package.json'), { name: 'binary-symbols-host' });
    fs.cpSync(path.join(fixtures, 'plugin'), plugin, { recursive: true });
    for (const file of ['CMakeLists.txt', 'base.cpp']) fs.copyFileSync(path.join(fixtures, file), path.join(project, file));
    core.syncPlugin({ projectPath: project, name: 'binary-symbols' });
    const report = await windows.doctor({ projectPath: project });
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    const pdbutil = process.env.COCOS_PLUGIN_PDBUTIL || path.join(path.dirname(report.tools.clangCl), 'llvm-pdbutil.exe');
    assert.ok(fs.existsSync(pdbutil), '原生符号测试需要 llvm-pdbutil，可通过 COCOS_PLUGIN_PDBUTIL 指定路径。');
    const internal = windows._internal;
    const bootstrap = await internal.execute(process.env.ComSpec, ['/d', '/s', '/v:off', '/c', internal.vsBootstrapCommand(report.tools.vsDevCmd)], { windowsVerbatimArguments: true });
    const env = internal.parseEnvironment(bootstrap.output);
    env.VSLANG = '1033';
    const state = { projectPath: project, buildDir: path.join(project, '.plugin-dev/build'), buildType, tools: report.tools, enginePath: report.host.enginePath };
    fs.mkdirSync(path.join(state.buildDir, '.cmake/api/v1/query'), { recursive: true });
    fs.writeFileSync(path.join(state.buildDir, '.cmake/api/v1/query/codemodel-v2'), '');
    const cmakeArgs = ['-G', 'Ninja', `-DCMAKE_BUILD_TYPE=${buildType}`, `-DCMAKE_MAKE_PROGRAM=${slash(report.tools.ninja)}`, `-DCOCOS_X_PATH=${slash(path.join(report.host.enginePath, 'native'))}`];
    await internal.execute(report.tools.cmake, ['-S', project, '-B', state.buildDir, ...cmakeArgs,
        `-DPLUGIN_SOURCE=${slash(plugin)}`, `-DSYMBOL_FORMAT=${symbolFormat}`, `-DBINARY_METADATA_MODULE=${slash(path.resolve(__dirname, '../lib/cmake/binary-build.cmake'))}`], { env });
    await internal.execute(report.tools.cmake, ['--build', state.buildDir], { env });
    state.builtAt = new Date().toISOString();
    support.writeJson(path.join(project, '.plugin-dev/windows.json'), state);
    binary.recordBinaryBuild(state, support.readState(project).plugins);
    const result = await core.packagePlugin({ projectPath: project, name: 'binary-symbols', binary: true, outputDir: path.join(root, 'packages') });
    const libraryPath = 'native/windows/lib/binary_symbols.lib';
    const pdbPath = 'native/windows/lib/binary_symbols_compiler.pdb';
    const externalPdb = symbolFormat !== 'Z7';
    assert.ok(Object.hasOwn(result.binaryManifest.files, libraryPath));
    assert.equal(Object.hasOwn(result.binaryManifest.files, pdbPath), externalPdb);
    const dependencyLibrary = Object.keys(result.binaryManifest.files).find(file => file.endsWith('/binary_symbols_dependency.lib'));
    assert.ok(dependencyLibrary);
    const dependencyPdb = `${path.posix.dirname(dependencyLibrary)}/binary_symbols_dependency_compiler.pdb`;
    assert.equal(Object.hasOwn(result.binaryManifest.files, dependencyPdb), externalPdb);
    assert.equal(fs.existsSync(path.join(result.packagePath, 'native/src')), false);
    const extracted = path.join(root, 'installed');
    await internal.execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(__dirname, 'fixtures/package-archive/expand.ps1'), result.zipPath, extracted], { env });
    const installed = path.join(extracted, 'binary-symbols');
    const checkedFiles = [libraryPath, dependencyLibrary, ...(externalPdb ? [pdbPath, dependencyPdb] : [])];
    for (const file of checkedFiles) assert.equal(support.hashFile(path.join(installed, file)), result.binaryManifest.files[file]);
    const consumer = path.join(root, 'consumer');
    fs.mkdirSync(consumer);
    for (const file of ['CMakeLists.txt', 'base.cpp', 'main.cpp']) fs.copyFileSync(path.join(fixtures, file), path.join(consumer, file));
    // 完整迁移作者源码和编译目录，使消费过程只能使用 ZIP 内的产物。
    await internal.execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(fixtures, 'move-author.ps1'), root, project, path.join(root, 'producer-unavailable')], { env });
    assert.equal(fs.existsSync(project), false);
    const consumerBuild = path.join(root, 'consumer-build');
    await internal.execute(report.tools.cmake, ['-S', consumer, '-B', consumerBuild, ...cmakeArgs,
        `-DPACKAGE_CONFIG=${slash(path.join(installed, 'native/windows/binary_symbols-config.cmake'))}`], { env });
    const compiled = await internal.execute(report.tools.cmake, ['--build', consumerBuild], { env });
    assert.doesNotMatch(compiled.output, /LNK4099/);
    const execution = await internal.execute(path.join(consumerBuild, 'binary_symbols_consumer.exe'), [], { env });
    assert.match(execution.output, /Binary symbols value=42/);
    const inspected = await internal.execute(pdbutil, ['dump', '--symbols', '--files', '-l', path.join(consumerBuild, 'binary_symbols_consumer.pdb')], { env, captureBuffer: true });
    const symbols = inspected.buffer.toString('utf8');
    fs.writeFileSync(path.join(root, 'pdb-symbols.txt'), symbols);
    assert.match(symbols, /S_GPROC32[^\r\n]*binary_symbols_value/);
    assert.match(symbols, /S_GPROC32[^\r\n]*binary_symbols_dependency_value/);
    assert.match(symbols, /library\.cpp \([^\r\n]*\)\r?\n\s+[0-9A-F]+:[0-9A-F]+-[0-9A-F]+, line\/addr entries = [1-9]\d*/);
    assert.match(symbols, /dependency\.cpp \([^\r\n]*\)\r?\n\s+[0-9A-F]+:[0-9A-F]+-[0-9A-F]+, line\/addr entries = [1-9]\d*/);
    support.writeJson(path.join(root, 'results.json'), { buildType, symbolFormat, zipPath: result.zipPath, libraryPath, pdbPath: externalPdb ? pdbPath : null, dependencyLibrary, dependencyPdb: externalPdb ? dependencyPdb : null,
        warningLnk4099: false, execution: execution.output, functionDebugRecord: true, sourceLines: true });
});
