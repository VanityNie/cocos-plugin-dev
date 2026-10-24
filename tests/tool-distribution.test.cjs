'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const core = require('../lib/core.cjs');
const support = require('../templates/common/editor/plugin-support.cjs');

const repository = path.resolve(__dirname, '..');
const sourceFiles = () => support.walk(repository, (relative, item) =>
    !item.isDirectory() || !['.git', '.local', 'node_modules', '.plugin-dev', 'dist'].includes(item.name));

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpd-tool-distribution-'));
    t.after(() => {
        support.inside(os.tmpdir(), root);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const project = path.join(root, 'game');
    fs.mkdirSync(path.join(project, 'assets'), { recursive: true });
    support.writeJson(path.join(project, 'package.json'), { name: 'distribution-host' });
    return { root, project };
}

test('the tool checkout cannot register its test fixtures as native plugins', () => {
    const manifests = sourceFiles().filter(file => path.posix.basename(file) === 'cc_plugin.json');
    assert.deepEqual(manifests, [], 'Creator scans nested cc_plugin.json files even inside tests; store fixture manifests with a .fixture suffix.');
    assert.ok(sourceFiles().includes('tests/fixtures/binary-symbols/plugin/native/cc_plugin.json.fixture'));
});

test('tool upgrades refuse modified obsolete fixtures and retain their contents', t => {
    const { project } = fixture(t);
    const installation = core.installTools({ projectPath: project });
    const obsolete = 'tests/fixtures/binary-symbols/plugin/native/cc_plugin.json';
    const filename = path.join(installation.path, obsolete);
    support.write(filename, 'old owned fixture');
    const marker = path.join(installation.path, '.cocos-plugin-dev-install.json');
    const ownership = support.readJson(marker);
    ownership.files[obsolete] = support.hashFile(filename);
    support.writeJson(marker, ownership);
    fs.writeFileSync(filename, 'user changed fixture');
    assert.throws(() => core.installTools({ projectPath: project }), /手工修改/);
    assert.equal(fs.readFileSync(filename, 'utf8'), 'user changed fixture');
});

test('Creator official scanner discovers only the user plugin in installed and checkout distributions', {
    skip: process.env.COCOS_PLUGIN_TEST_ENGINE ? false : 'Set COCOS_PLUGIN_TEST_ENGINE to run the Creator native-plugin scanner.',
}, t => {
    const { root, project } = fixture(t);
    const parser = path.join(process.env.COCOS_PLUGIN_TEST_ENGINE, 'native/cmake/scripts/plugins_parser.js');
    assert.ok(fs.existsSync(parser), `Creator plugin scanner is missing: ${parser}`);
    const installation = core.installTools({ projectPath: project });
    assert.equal(fs.existsSync(path.join(installation.path, 'tests')), false);
    assert.equal(support.walk(installation.path).some(file => path.posix.basename(file) === 'cc_plugin.json'), false);
    const userPlugin = core.createPlugin({ projectPath: project, name: 'actual-user-plugin' });
    const checkout = path.join(root, 'checkout-extensions/cocos-plugin-dev');
    for (const relative of sourceFiles()) {
        const destination = path.join(checkout, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(repository, relative), destination);
    }
    fs.cpSync(userPlugin.pluginPath, path.join(path.dirname(checkout), userPlugin.name), { recursive: true });
    for (const [name, directory] of [['installed', path.join(project, 'extensions')], ['checkout', path.dirname(checkout)]]) {
        const input = path.join(root, `${name}-search-paths.txt`);
        const output = path.join(root, `${name}-plugins.cmake`);
        fs.writeFileSync(input, `${directory}\n`);
        execFileSync(process.execPath, [parser, input, output, 'windows'], { encoding: 'utf8', windowsHide: true });
        const content = fs.readFileSync(output, 'utf8');
        const targets = [...content.matchAll(/find_package\(([^\s)]+)/g)].map(match => match[1]);
        assert.deepEqual(targets, [userPlugin.target], name);
        assert.doesNotMatch(content, /binary_symbols|tests\/fixtures/);
    }
});
