'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const core = require('../lib/core.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');

function fixture(t) {
    const local = path.resolve(__dirname, '../.local');
    fs.mkdirSync(local, { recursive: true });
    const root = fs.mkdtempSync(path.join(local, 'type-projects-'));
    t.after(() => {
        assert.ok(path.resolve(root).startsWith(`${local}${path.sep}`));
        fs.rmSync(root, { recursive: true, force: true });
    });
    function host(name) {
        const project = path.join(root, name);
        fs.mkdirSync(path.join(project, 'assets'), { recursive: true });
        support.writeJson(path.join(project, 'package.json'), { name, creator: { version: '3.8.8' } });
        return project;
    }
    return { root, host };
}

function compile(configFile) {
    const config = ts.readConfigFile(configFile, ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile));
    assert.deepEqual(parsed.errors, []);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getCanonicalFileName: name => name,
        getNewLine: () => '\n',
    }));
    return program;
}

test('独立源码的默认类型检查与生成目录的 Git 忽略规则有效', async t => {
    const { root, host } = fixture(t);
    execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
    const standalone = core.createPlugin({ pluginPath: path.join(root, 'standalone'), name: 'standalone' });
    const embedded = core.createPlugin({ projectPath: host('embedded-host'), name: 'embedded' });
    for (const plugin of [standalone, embedded]) {
        compile(path.join(plugin.pluginPath, 'tsconfig.json'));
        const file = path.join(plugin.pluginPath, '.local', 'cc-default.d.ts');
        execFileSync('git', ['check-ignore', '--quiet', file], { cwd: root, windowsHide: true });
        assert.equal(fs.existsSync(path.join(plugin.pluginPath, '.local/cc-host.d.ts')), false);
    }
    const ignoreFile = path.join(embedded.pluginPath, '.local/.gitignore');
    support.write(ignoreFile, '! *\n!*\n');
    support.syncTypeDeclarations(undefined, embedded.pluginPath);
    execFileSync('git', ['check-ignore', '--quiet', path.join(embedded.pluginPath, '.local/cc-default.d.ts')], { cwd: root, windowsHide: true });
    const exported = await core.packagePlugin({ projectPath: path.dirname(path.dirname(embedded.pluginPath)), name: 'embedded' });
    assert.equal(fs.existsSync(path.join(exported.packagePath, '.local')), false);
    const installedHost = host('installed-host');
    const installed = path.join(installedHost, 'extensions', 'embedded');
    fs.cpSync(exported.packagePath, installed, { recursive: true });
    const installedSupport = require(path.join(installed, 'editor/plugin-support.cjs'));
    installedSupport.syncPlugin({ projectPath: installedHost, name: 'embedded' });
    compile(path.join(installed, 'tsconfig.json'));
    execFileSync('git', ['check-ignore', '--quiet', path.join(installed, '.local/cc-default.d.ts')], { cwd: root, windowsHide: true });
});

test('两个真实引擎的宿主项目和 tsserver 使用各自声明并保持原始源码路径', t => {
    const engineA = process.env.COCOS_TYPES_ENGINE_A || 'C:/ProgramData/cocos/editors/Creator/3.8.8/resources/resources/3d/engine';
    const engineB = process.env.COCOS_TYPES_ENGINE_B || 'D:/code/cocos/own_cocos';
    if (![engineA, engineB].every(engine => fs.existsSync(path.join(engine, 'bin/.declarations/cc.d.ts')))) {
        t.skip('需要设置 COCOS_TYPES_ENGINE_A 和 COCOS_TYPES_ENGINE_B，指向含有 bin/.declarations/cc.d.ts 的真实引擎。');
        return;
    }
    const { root, host } = fixture(t);
    const plugin = core.createPlugin({ pluginPath: path.join(root, 'shared'), name: 'shared' });
    const projectA = host('host-a');
    const projectB = host('host-b');
    const creatorDeclarations = process.env.COCOS_TYPES_HOST_DECLARATIONS || 'D:/code/cocos/meimei-morph-demo/temp/declarations';
    if (fs.existsSync(creatorDeclarations)) fs.cpSync(creatorDeclarations, path.join(projectA, 'temp/declarations'), { recursive: true });
    const baselineFile = path.join(plugin.pluginPath, '.local', 'cc-default.d.ts');
    const baseline = fs.readFileSync(baselineFile, 'utf8');
    const typesA = support.syncTypeDeclarations(projectA, plugin.pluginPath, engineA);
    const contentA = fs.readFileSync(typesA.targetFile, 'utf8');
    const typesB = support.syncTypeDeclarations(projectB, plugin.pluginPath, engineB);
    support.syncTypeDeclarations(projectA, plugin.pluginPath, engineA);
    assert.equal(fs.readFileSync(typesA.targetFile, 'utf8'), contentA);
    assert.equal(fs.readFileSync(baselineFile, 'utf8'), baseline);
    assert.notEqual(typesA.targetFile, typesB.targetFile);
    const sourceFile = path.join(plugin.pluginPath, 'runtime', 'PluginProbe.ts');
    for (const [project, types, engine, otherEngine] of [[projectA, typesA, engineA, engineB], [projectB, typesB, engineB, engineA]]) {
        const program = compile(types.configFile);
        const files = program.getSourceFiles().map(file => path.resolve(file.fileName).toLowerCase());
        assert.ok(files.includes(path.resolve(engine, 'bin/.declarations/cc.d.ts').toLowerCase()));
        assert.ok(!files.includes(path.resolve(otherEngine, 'bin/.declarations/cc.d.ts').toLowerCase()));
        const sdk = support.prepareTypeScriptSdk(project, path.dirname(require.resolve('typescript/package.json')));
        assert.equal(fs.readFileSync(path.join(sdk.packageRoot, 'LICENSE.txt'), 'utf8'), fs.readFileSync(require.resolve('typescript/LICENSE.txt'), 'utf8'));
        execFileSync(process.execPath, [path.join(sdk.sdkPath, 'tsc.js'), '--project', types.configFile], { windowsHide: true, encoding: 'utf8' });
        const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'tsserver-type-check.cjs'), project, sdk.packageRoot, sourceFile], { windowsHide: true, encoding: 'utf8' }));
        assert.equal(result.typescriptVersion, ts.version);
        assert.equal(path.resolve(result.projectName), path.join(plugin.pluginPath, 'tsconfig.json'));
        assert.deepEqual(result.diagnostics, []);
        assert.ok(result.definitions.some(item => path.resolve(item.fileName).toLowerCase() === path.resolve(engine, 'bin/.declarations/cc.d.ts').toLowerCase()));
        const loaded = result.files.map(file => path.resolve(file).toLowerCase());
        assert.ok(!loaded.includes(path.resolve(otherEngine, 'bin/.declarations/cc.d.ts').toLowerCase()));
        assert.match(fs.readFileSync(path.join(project, 'tsserver.log'), 'utf8'), /Plugin validation succeeded/);
    }
    const vscodeSdk = process.env.COCOS_TYPES_VSCODE_SDK || 'D:/work/Microsoft VS Code/fcf604774b/resources/app/extensions/node_modules/typescript';
    if (fs.existsSync(path.join(vscodeSdk, 'package.json'))) {
        const sdk = support.prepareTypeScriptSdk(projectA, vscodeSdk);
        const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'tsserver-type-check.cjs'), projectA, sdk.packageRoot, sourceFile], { windowsHide: true, encoding: 'utf8' }));
        assert.equal(result.typescriptVersion, support.readJson(path.join(vscodeSdk, 'package.json')).version);
        assert.deepEqual(result.diagnostics, []);
        assert.ok(result.definitions.some(item => path.resolve(item.fileName).toLowerCase() === path.resolve(engineA, 'bin/.declarations/cc.d.ts').toLowerCase()));
    }
});

test('类型环境迁移移除共享宿主引用并保留用户编译选项', t => {
    const { root, host } = fixture(t);
    const plugin = core.createPlugin({ pluginPath: path.join(root, 'migrate'), name: 'migrate' });
    const configFile = path.join(plugin.pluginPath, 'tsconfig.json');
    const config = support.readJson(configFile);
    config.include.push('.local/**/*.d.ts');
    config.compilerOptions.noUnusedLocals = true;
    support.writeJson(configFile, config);
    support.write(path.join(plugin.pluginPath, '.local/cc-host.d.ts'), '// Generated by cocos-plugin-dev. Do not edit manually.\n');
    support.syncTypeDeclarations(host('migration-host'), plugin.pluginPath);
    const migrated = support.readJson(configFile);
    assert.equal(migrated.compilerOptions.noUnusedLocals, true);
    assert.ok(!migrated.include.includes('.local/**/*.d.ts'));
    assert.equal(fs.existsSync(path.join(plugin.pluginPath, '.local/cc-host.d.ts')), false);
    compile(configFile);
});

test('运行时目标路径拒绝绝对路径与 Windows 文件名别名', t => {
    const { root } = fixture(t);
    const plugin = core.createPlugin({ pluginPath: path.join(root, 'paths'), name: 'paths' });
    for (const target of ['/model.onnx', '\\model.onnx', 'C:\\model.onnx', 'C:model.onnx', '../model.onnx', 'models/model.onnx.', 'models/model.onnx ', 'NUL', 'NUL .dll', 'CONIN$', 'COM1.dll', 'LPT².txt', 'models/AUX/file']) {
        assert.throws(() => support.collectRuntimeFiles(plugin.pluginPath, { runtimeFiles: [{ source: 'runtime/index.ts', target }] }), /无效的运行时目标路径/);
    }
    assert.equal(support.collectRuntimeFiles(plugin.pluginPath, { runtimeFiles: [{ source: 'runtime/index.ts', target: 'models/source.ts' }] })[0].target, 'models/source.ts');
});
