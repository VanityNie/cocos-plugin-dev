'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const cli = require('../cli.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');
const windows = require('../lib/windows.cjs');

const packagePath = process.env.CPD_BINARY_RUNTIME_PACKAGE;

function fixture(t) {
    const parent = path.resolve(__dirname, '../.local');
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'package-binary-runtime-'));
    t.after(() => {
        support.inside(parent, root);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const creatorPath = windows._internal.discoverCreator();
    const enginePath = path.join(path.dirname(creatorPath), 'resources/resources/3d/engine');
    const consumer = path.join(root, 'consumer');
    cli.createSandbox({ projectPath: consumer, creatorPath, enginePath });
    const pkg = support.readJson(path.join(packagePath, 'package.json'));
    const extension = path.join(consumer, 'extensions', pkg.name);
    fs.cpSync(packagePath, extension, { recursive: true, errorOnExist: true, force: false });
    assert.equal(fs.existsSync(path.join(consumer, 'extensions/cocos-plugin-dev')), false);
    return { root, consumer, extension, enginePath, name: pkg.name };
}

test('真实二进制发布包具有完整资源指纹，并通过 Creator 官方插件发现',
    { skip: !packagePath }, t => {
        const f = fixture(t);
        const files = support.walk(f.extension);
        assert.equal(files.some(file => /\.(?:c|cc|cpp|cxx|c\+\+|m|mm|ixx|cppm)$/i.test(file)), false);
        assert.equal(files.some(file => file.startsWith('native/src/')), false);
        const manifest = support.readJson(path.join(f.extension, 'native/windows/binary-manifest.json'));
        for (const [relative, expected] of Object.entries(manifest.files)) {
            assert.equal(support.hashFile(path.join(f.extension, relative)), expected, relative);
        }
        assert.ok(files.some(file => file.endsWith('/cpd_runtime_math.h')));
        const runtime = support.collectRuntimeFiles(f.extension);
        assert.deepEqual(runtime.map(item => item.target).sort(), ['cpd_runtime_math.dll', 'models/options.json']);
        const searchPaths = path.join(f.root, 'search-paths.txt');
        fs.writeFileSync(searchPaths, `${path.join(f.consumer, 'extensions')}\n`);
        const discovered = path.join(f.root, 'Pre-AutoLoadPlugins.cmake');
        execFileSync(process.execPath, [path.join(f.enginePath, 'native/cmake/scripts/plugins_parser.js'),
            searchPaths, discovered, 'windows'], { encoding: 'utf8' });
        const native = support.readJson(path.join(f.extension, 'native/cc_plugin.json'));
        const content = fs.readFileSync(discovered, 'utf8');
        assert.ok(content.includes(`find_package(${native.modules[0].target}`));
        assert.ok(content.includes('/windows/x86_64'));
    });

test('真实二进制包安装后独立部署 DLL 与模型，禁用后清理全部受管文件',
    { skip: !packagePath }, t => {
        const f = fixture(t);
        const installedSupport = require(path.join(f.extension, 'editor/plugin-support.cjs'));
        installedSupport.syncPlugin({ projectPath: f.consumer, name: f.name });
        const executable = path.join(f.consumer, 'build/Game.exe');
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.copyFileSync(path.join(process.env.SystemRoot, 'System32/where.exe'), executable);
        const { deployRuntimeFiles } = require(path.join(f.extension, 'editor/runtime-deployment.cjs'));
        const result = deployRuntimeFiles(f.consumer, executable);
        assert.equal(result.deployed, 2);
        const items = installedSupport.collectRuntimeFiles(f.extension);
        for (const item of items) {
            assert.equal(support.hashFile(path.join(path.dirname(executable), item.target)), item.sha256);
        }
        assert.deepEqual(support.readJson(path.join(path.dirname(executable), 'models/options.json')),
            { operator: 'add', left: 19, right: 23 });
        installedSupport.setEnabled({ projectPath: f.consumer, name: f.name, enabled: false });
        assert.equal(deployRuntimeFiles(f.consumer, executable).removed, 2);
        for (const item of items) assert.equal(fs.existsSync(path.join(path.dirname(executable), item.target)), false);
        assert.equal(fs.existsSync(executable), true);
    });
