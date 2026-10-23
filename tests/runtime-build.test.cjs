'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../lib/core.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');
const windows = require('../lib/windows.cjs');
const { builtExecutable } = require('../templates/common/editor/build-hooks.cjs')._internal;

test('真实 CMake 编译验证部署顺序、增量更新、配置切换与禁用清理',
    { skip: process.env.COCOS_PLUGIN_NATIVE_TESTS !== '1', timeout: 120000 }, async t => {
        const local = path.resolve(__dirname, '../.local');
        fs.mkdirSync(local, { recursive: true });
        const project = fs.mkdtempSync(path.join(local, 'runtime-build-'));
        t.after(() => {
            support.inside(local, project);
            fs.rmSync(project, { recursive: true, force: true });
        });
        fs.mkdirSync(path.join(project, 'assets'));
        support.writeJson(path.join(project, 'package.json'), { name: 'runtime-deployment-test' });
        const plugin = core.createPlugin({ projectPath: project, name: 'build-resources' });
        const source = path.join(plugin.pluginPath, 'native/third_party/bin');
        support.writeJson(path.join(source, 'settings.json'), { version: 1 });
        support.writeJson(path.join(source, 'engine.json'), { owner: 'host' });
        const hostResource = path.join(project, 'engine.json');
        support.writeJson(hostResource, { owner: 'host' });
        const report = await windows.doctor({ projectPath: project });
        assert.equal(report.ok, true, JSON.stringify(report.checks));
        const internal = windows._internal;
        const bootstrap = await internal.execute(process.env.ComSpec,
            ['/d', '/s', '/v:off', '/c', internal.vsBootstrapCommand(report.tools.vsDevCmd)], { windowsVerbatimArguments: true });
        const env = internal.parseEnvironment(bootstrap.output);
        const resourceDir = path.join(project, 'build/windows');
        const buildDir = path.join(resourceDir, 'proj');
        const executable = path.join(buildDir, 'runtime_deployment_probe.exe');
        const currentFiles = () => support.readJson(path.join(project, '.plugin-dev/runtime-binaries.json'))
            .outputs[buildDir.replace(/\\/g, '/').toLowerCase()].files;
        for (const configuration of ['Debug', 'RelWithDebInfo', 'Release']) {
            await internal.execute(report.tools.cmake, ['-S', path.join(__dirname, 'fixtures/runtime-build'), '-B', buildDir,
                '-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${report.tools.ninja}`, `-DCMAKE_BUILD_TYPE=${configuration}`,
                `-DCPD_PROJECT_PATH=${project}`, `-DNODE_EXECUTABLE=${process.execPath}`, `-DCPD_HOST_RESOURCE=${hostResource}`,
                `-DCPD_RUNTIME_CMAKE=${path.resolve(__dirname, '../templates/common/editor/runtime-build.cmake')}`], { env });
            await internal.execute(report.tools.cmake, ['--build', buildDir], { env });
            const result = await internal.execute(executable, [], { env, cwd: buildDir });
            assert.equal(JSON.parse(result.output).version, 1);
            assert.equal(currentFiles()['engine.json'].managed, false);
            assert.equal(currentFiles()['settings.json'].managed, true);
            const metadataFiles = fs.readdirSync(path.join(project, '.plugin-dev/native-build/metadata'));
            const metadataFile = metadataFiles.find(file => file.endsWith(`-${configuration}.json`));
            assert.ok(metadataFile);
            const metadata = support.readJson(path.join(project, '.plugin-dev/native-build/metadata', metadataFile));
            assert.equal(path.resolve(metadata.executable), executable);
            assert.equal(metadata.configuration, configuration);
            if (configuration !== 'RelWithDebInfo') {
                assert.equal(builtExecutable(project, resourceDir, { debug: configuration === 'Debug' }), executable);
            }
        }
        const otherBuildDir = path.join(project, '.plugin-dev/build/windows');
        await internal.execute(report.tools.cmake, ['-S', path.join(__dirname, 'fixtures/runtime-build'), '-B', otherBuildDir,
            '-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${report.tools.ninja}`, '-DCMAKE_BUILD_TYPE=Release',
            `-DCPD_PROJECT_PATH=${project}`, `-DNODE_EXECUTABLE=${process.execPath}`, `-DCPD_HOST_RESOURCE=${hostResource}`,
            `-DCPD_RUNTIME_CMAKE=${path.resolve(__dirname, '../templates/common/editor/runtime-build.cmake')}`], { env });
        await internal.execute(report.tools.cmake, ['--build', otherBuildDir], { env });
        assert.equal(builtExecutable(project, resourceDir, { debug: false }), executable);
        const executableHash = support.hash(fs.readFileSync(executable));
        support.writeJson(path.join(source, 'settings.json'), { version: 2 });
        await internal.execute(report.tools.cmake, ['--build', buildDir], { env });
        assert.equal(support.hash(fs.readFileSync(executable)), executableHash);
        assert.equal(JSON.parse((await internal.execute(executable, [], { env, cwd: buildDir })).output).version, 2);
        fs.unlinkSync(path.join(buildDir, 'settings.json'));
        await internal.execute(report.tools.cmake, ['--build', buildDir, '--clean-first', '--target', 'runtime_deployment_probe'], { env });
        assert.equal(support.readJson(path.join(buildDir, 'settings.json')).version, 2);
        core.setEnabled({ projectPath: project, name: 'build-resources', enabled: false });
        await internal.execute(report.tools.cmake, ['--build', buildDir], { env });
        assert.equal(fs.existsSync(path.join(buildDir, 'settings.json')), false);
        assert.equal(support.readJson(path.join(buildDir, 'engine.json')).owner, 'host');
        assert.deepEqual(currentFiles(), {});
    });
