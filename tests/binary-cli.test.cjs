'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { parseArgs } = require('../cli.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');

const cliPath = path.resolve(__dirname, '../cli.cjs');

function run(...args) {
    const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    return result;
}

function packageRoot(loader, name) {
    let directory = path.dirname(loader.resolve(name));
    for (;;) {
        const file = path.join(directory, 'package.json');
        if (fs.existsSync(file) && support.readJson(file).name === name) return directory;
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error(`无法定位依赖包: ${name}`);
        directory = parent;
    }
}

function fixture(t) {
    const local = path.resolve(__dirname, '../.local');
    fs.mkdirSync(local, { recursive: true });
    const root = fs.mkdtempSync(path.join(local, 'binary-cli-'));
    t.after(() => {
        assert.ok(path.resolve(root).startsWith(`${local}${path.sep}`));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const project = path.join(root, 'host');
    fs.mkdirSync(path.join(project, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'binary-cli-host', creator: { version: '3.8.8' } }));
    return { root, project };
}

test('package 的 binary 布尔参数保留显式构建配置', () => {
    const parsed = parseArgs(['package', '--project', '.', '--name', 'sample', '--binary', '--build-type', 'RelWithDebInfo']);
    assert.equal(parsed.options.binary, true);
    assert.equal(parsed.options.buildType, 'RelWithDebInfo');
    assert.equal(parseArgs(['package', '--project', '.', '--name', 'sample']).options.binary, undefined);
});

test('真实 CLI 拒绝重复、带值和其他命令的 binary 参数', () => {
    for (const args of [
        ['package', '--binary', '--binary'],
        ['package', '--binary=true'],
        ['package', '--binary', 'false'],
        ['create', '--binary'],
        ['build', '--binary'],
        ['package', '--build-type', 'Release'],
    ]) {
        const result = run(...args);
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /binary|Unknown argument: false/);
    }
    const help = run('--help');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--binary/);
});

test('真实 CLI 创建后可以导出源码插件', t => {
    const { root, project } = fixture(t);
    const created = run('create', '--project', project, '--name', 'binary-source');
    assert.equal(created.status, 0, created.stderr);
    fs.writeFileSync(path.join(project, '.plugin-dev/ui-settings.json'), JSON.stringify({ buildType: 'RelWithDebInfo', binary: true }));
    const packaged = run('package', '--project', project, '--name', 'binary-source', '--output-dir', path.join(root, 'exports'));
    assert.equal(packaged.status, 0, packaged.stderr);
    const result = JSON.parse(packaged.stdout);
    assert.equal(result.binary, false);
    assert.equal(Object.hasOwn(result, 'buildType'), false);
    assert.equal(Object.hasOwn(result, 'binaryManifest'), false);
    assert.ok(fs.existsSync(result.zipPath));
    assert.ok(fs.existsSync(path.join(result.packagePath, 'native/src/PluginEntry.cpp')));
});

test('真实 CLI 拒绝为尚未构建的插件生成二进制发布包', t => {
    const { root, project } = fixture(t);
    const created = run('create', '--project', project, '--name', 'unbuilt-binary');
    assert.equal(created.status, 0, created.stderr);
    const output = path.join(root, 'binary-exports');
    const packaged = run('package', '--project', project, '--name', 'unbuilt-binary', '--binary', '--output-dir', output);
    assert.equal(packaged.status, 1, packaged.stdout);
    assert.equal(packaged.stdout, '');
    assert.match(packaged.stderr, /构建|配置|built|configured/i);
    assert.equal(fs.existsSync(output), false);
});

test('安装后的工作台包含完整生产依赖并在独立进程创建和打包插件', t => {
    const { root, project } = fixture(t);
    const installed = run('install', '--project', project);
    assert.equal(installed.status, 0, installed.stderr);
    const installation = JSON.parse(installed.stdout).path;
    const installedRequire = createRequire(path.join(installation, 'package.json'));
    for (const dependency of ['yazl', 'buffer-crc32', 'typescript']) {
        const source = packageRoot(require, dependency);
        const destination = packageRoot(installedRequire, dependency);
        assert.ok(destination.startsWith(`${installation}${path.sep}`));
        const relativeFiles = support.walk(source);
        assert.deepEqual(support.walk(destination), relativeFiles);
        for (const file of relativeFiles) assert.deepEqual(fs.readFileSync(path.join(destination, file)), fs.readFileSync(path.join(source, file)), `${dependency}/${file}`);
    }
    const installedCli = path.join(installation, 'cli.cjs');
    const created = spawnSync(process.execPath, [installedCli, 'create', '--project', project, '--name', 'installed-package'], { encoding: 'utf8', windowsHide: true });
    assert.equal(created.status, 0, created.stderr);
    const packaged = spawnSync(process.execPath, [installedCli, 'package', '--project', project, '--name', 'installed-package', '--output-dir', path.join(root, 'installed-exports')], { encoding: 'utf8', windowsHide: true });
    assert.equal(packaged.status, 0, packaged.stderr);
    const result = JSON.parse(packaged.stdout);
    assert.equal(result.binary, false);
    assert.ok(fs.statSync(result.zipPath).size > 0);
    assert.equal(support.readJson(path.join(result.packagePath, 'package.json')).name, 'installed-package');
});

test('真实 Windows 宿主的 CLI 二进制发布包含可解压归档和对应配置', {
    skip: process.env.COCOS_BINARY_CLI_PROJECT ? false : '设置 COCOS_BINARY_CLI_PROJECT 和 COCOS_BINARY_CLI_PLUGIN 以检查已完成构建的真实宿主。',
}, t => {
    const { root } = fixture(t);
    const project = path.resolve(process.env.COCOS_BINARY_CLI_PROJECT);
    const name = process.env.COCOS_BINARY_CLI_PLUGIN;
    assert.ok(name, 'COCOS_BINARY_CLI_PLUGIN 必须指定宿主中的插件。');
    const state = support.readJson(path.join(project, '.plugin-dev/windows.json'));
    assert.ok(state.builtAt, '真实宿主需要成功构建记录。');
    const output = path.join(root, 'real-binary');
    const packaged = run('package', '--project', project, '--name', name, '--binary', '--output-dir', output);
    assert.equal(packaged.status, 0, packaged.stderr);
    const result = JSON.parse(packaged.stdout);
    assert.equal(result.binary, true);
    assert.equal(result.buildType, state.builtBuildType);
    assert.equal(path.basename(result.zipPath), `${name}-${result.version}-windows-x64-${result.buildType}.zip`);
    assert.equal(fs.existsSync(path.join(result.packagePath, 'native/src')), false);
    assert.ok(fs.existsSync(path.join(result.packagePath, 'BINARY.md')));
    const manifest = support.readJson(path.join(result.packagePath, 'native/windows/binary-manifest.json'));
    assert.deepEqual(manifest, result.binaryManifest);
    assert.ok(Object.keys(manifest.files).some(file => /^native\/windows\/lib\/[^/]+\.lib$/i.test(file)));
    for (const [file, checksum] of Object.entries(manifest.files)) {
        assert.equal(support.hashFile(path.join(result.packagePath, file)), checksum, file);
    }
    const unpacked = path.join(root, 'unpacked');
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    const expanded = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quote(result.zipPath)} -DestinationPath ${quote(unpacked)} -ErrorAction Stop`], { encoding: 'utf8', windowsHide: true });
    if (expanded.error) throw expanded.error;
    assert.equal(expanded.status, 0, expanded.stderr);
    const archiveRoot = path.join(unpacked, name);
    assert.deepEqual(support.walk(archiveRoot), support.walk(result.packagePath));
    for (const file of support.walk(result.packagePath)) {
        assert.equal(support.hashFile(path.join(archiveRoot, file)), support.hashFile(path.join(result.packagePath, file)), file);
    }
    const otherBuildType = result.buildType === 'Release' ? 'Debug' : 'Release';
    const mismatchedOutput = path.join(root, 'mismatched-binary');
    const mismatched = run('package', '--project', project, '--name', name, '--binary', '--build-type', otherBuildType, '--output-dir', mismatchedOutput);
    assert.equal(mismatched.status, 1, mismatched.stdout);
    assert.equal(mismatched.stdout, '');
    assert.match(mismatched.stderr, new RegExp(otherBuildType));
    assert.equal(fs.existsSync(mismatchedOutput), false);
});
