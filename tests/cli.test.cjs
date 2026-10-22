'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, createSandbox } = require('../cli.cjs');

test('CLI accepts explicit values and rejects misspelled or ambiguous flags', () => {
    assert.equal(parseArgs(['create', '--project', '.', '--name', 'neural-demo']).options.name, 'neural-demo');
    assert.throws(() => parseArgs(['create', '--project']), /Missing value/);
    assert.throws(() => parseArgs(['create', '--project', '.', '--project', '..']), /Duplicate/);
    assert.throws(() => parseArgs(['create', '--projet', '.']), /Unknown/);
});

test('sandbox creation preserves template assets but assigns project identity and refuses overwrite', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-cli-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const creator = path.join(root, 'Creator');
    const template = path.join(creator, 'resources/templates/hello-3d-world');
    fs.mkdirSync(template, { recursive: true });
    fs.writeFileSync(path.join(creator, 'CocosCreator.exe'), 'test executable placeholder');
    fs.writeFileSync(path.join(template, 'package.json'), JSON.stringify({ uuid: 'template-id', creator: { version: '3.8.8' } }));
    fs.writeFileSync(path.join(template, 'scene.scene'), 'fixture');
    const project = path.join(root, 'new-project');
    createSandbox({ projectPath: project, creatorPath: path.join(creator, 'CocosCreator.exe') });
    const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json')));
    assert.notEqual(pkg.uuid, 'template-id');
    assert.equal(fs.readFileSync(path.join(project, 'scene.scene'), 'utf8'), 'fixture');
    assert.throws(() => createSandbox({ projectPath: project, creatorPath: creator }), /already exists/);
    assert.equal(fs.readFileSync(path.join(project, 'scene.scene'), 'utf8'), 'fixture');
});
