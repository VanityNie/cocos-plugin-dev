'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const support = require('../templates/common/editor/plugin-support.cjs');

const ASSET_DIRECTORY = 'assets/__plugin_dev_host';
const ASSET_URL = 'db://assets/__plugin_dev_host';
const SCENE_NAME = 'plugin-dev.scene';
const SCRIPT_NAME = 'Bootstrap.ts';
const OWNER = 'cocos-plugin-dev';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

// Creator registers project components with the 23-character script UUID.
// The first five hexadecimal characters remain readable; each following
// group of three hex digits is represented by two base64 characters.
function scriptClassId(uuid) {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(uuid)) throw new Error(`Invalid script UUID: ${uuid}`);
    const hex = uuid.replace(/-/g, '');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = hex.slice(0, 5);
    for (let index = 5; index < hex.length; index += 3) {
        const value = parseInt(hex.slice(index, index + 3), 16);
        result += alphabet[value >> 6] + alphabet[value & 63];
    }
    return result;
}

function probeEntries(projectPath, plugins) {
    return plugins.filter(plugin => plugin.enabled).sort((a, b) => a.name.localeCompare(b.name)).map(plugin => {
        support.validateName(plugin.name);
        if (typeof plugin.nativeClass !== 'string' || !plugin.nativeClass) throw new Error(`插件 ${plugin.name} 缺少 nativeClass，无法检查原生注册。`);
        const runtimePath = path.join(projectPath, 'assets', '__plugin_dev', plugin.name);
        const probePath = path.join(runtimePath, 'PluginProbe.ts');
        support.noLinks(projectPath, probePath);
        const hasProbe = fs.existsSync(probePath);
        if (hasProbe && !fs.statSync(probePath).isFile()) throw new Error(`插件测试入口不是文件：${probePath}`);
        return { name: plugin.name, nativeClass: plugin.nativeClass, probePath: hasProbe ? probePath : null };
    });
}

function bootstrapSource(entries) {
    const imports = entries.flatMap((entry, index) => entry.probePath
        ? [`import * as probe${index} from '../__plugin_dev/${entry.name}/PluginProbe';`] : []).join('\n');
    const registrations = entries.map(entry => `        requireNative(${JSON.stringify(entry.name)}, ${JSON.stringify(entry.nativeClass)});`).join('\n');
    const probes = entries.map((entry, index) => entry.probePath
        ? `        attachProbe(this.node, ${JSON.stringify(entry.name)}, probe${index});`
        : `        log(${JSON.stringify(`[plugin-dev] ${entry.name}: 已检查原生注册；未提供 runtime/PluginProbe.ts，不执行业务测试。`)});`).join('\n');
    return fs.readFileSync(path.join(__dirname, '../templates/dev-host/Bootstrap.ts'), 'utf8')
        .replace('{{IMPORTS}}', imports).replace('{{REGISTRATIONS}}', registrations).replace('{{PROBES}}', probes);
}

function sceneSource(template, sceneUuid, scriptUuid) {
    const sceneData = JSON.parse(template);
    const asset = sceneData.find(value => value.__type__ === 'cc.SceneAsset');
    const sceneIndex = asset?.scene?.__id__;
    const scene = sceneData[sceneIndex];
    if (!scene || scene.__type__ !== 'cc.Scene' || !Array.isArray(scene._components)) throw new Error('所选引擎的默认场景格式不受支持：缺少 cc.SceneAsset/cc.Scene。');
    asset._name = 'plugin-dev';
    scene._name = 'Plugin Development';
    scene._id = sceneUuid;
    scene._components.push({ __id__: sceneData.length });
    sceneData.push({
        __type__: scriptClassId(scriptUuid), _name: '', _objFlags: 0,
        node: { __id__: sceneIndex }, _enabled: true, __prefab: null,
        _id: scriptClassId(scriptUuid),
    });
    return json(sceneData);
}

function assetMeta(uuid, importer, ver) {
    return { ver, importer, imported: false, uuid, files: [], subMetas: {}, userData: {} };
}

/** Generate an isolated, executable plugin test scene in the selected host.
 * Call after syncing plugins, then refresh assetUrl before invoking Creator's
 * in-process builder. CLI builds import these assets when Creator opens them.
 */
function ensureDevHost({ projectPath, enginePath, plugins }) {
    const project = support.projectRoot(projectPath);
    const directory = path.join(project, ASSET_DIRECTORY);
    const markerPath = path.join(project, '.plugin-dev/dev-host.json');
    support.noLinks(project, directory);
    support.noLinks(project, markerPath);
    const templatePath = path.join(enginePath, 'editor/assets/default_file_content/scene/default.scene');
    const template = fs.readFileSync(templatePath, 'utf8');
    const templateMeta = JSON.parse(fs.readFileSync(`${templatePath}.meta`, 'utf8'));
    const entries = probeEntries(project, plugins);
    const previous = fs.existsSync(markerPath) ? support.readJson(markerPath) : null;
    if (previous && (previous.schemaVersion !== 1 || previous.managedBy !== OWNER || !previous.hashes)) throw new Error(`插件测试场景管理记录无效：${markerPath}`);
    if (!previous && fs.existsSync(directory)) throw new Error(`测试场景目录已存在且不属于工作台，拒绝覆盖：${directory}`);
    const sceneUuid = previous ? previous.sceneUuid : crypto.randomUUID();
    const scriptUuid = previous ? previous.scriptUuid : crypto.randomUUID();
    // Validate stored UUIDs before writing any generated files.
    scriptClassId(sceneUuid);
    scriptClassId(scriptUuid);
    const generated = new Map([
        [SCENE_NAME, sceneSource(template, sceneUuid, scriptUuid)],
        [SCRIPT_NAME, bootstrapSource(entries)],
    ]);
    for (const [name] of generated) {
        const file = path.join(directory, name);
        support.noLinks(project, file);
        if (fs.existsSync(file) && hash(fs.readFileSync(file)) !== previous?.hashes[name]) throw new Error(`工作台测试文件已被修改，拒绝覆盖：${file}`);
    }
    const metadata = new Map([
        [`${SCENE_NAME}.meta`, assetMeta(sceneUuid, 'scene', templateMeta.ver)],
        [`${SCRIPT_NAME}.meta`, assetMeta(scriptUuid, 'typescript', '4.0.24')],
    ]);
    for (const [name, meta] of metadata) {
        const file = path.join(directory, name);
        support.noLinks(project, file);
        if (!fs.existsSync(file)) continue;
        const current = support.readJson(file);
        if (current.uuid !== meta.uuid || current.importer !== meta.importer) throw new Error(`工作台测试资源的 UUID 或 importer 已被修改：${file}`);
    }
    let changed = false;
    for (const [name, value] of generated) {
        const file = path.join(directory, name);
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === value) continue;
        support.write(file, value);
        changed = true;
    }
    for (const [name, meta] of metadata) {
        const file = path.join(directory, name);
        if (fs.existsSync(file)) continue; // Creator owns imported/files/userData.
        support.writeJson(file, meta);
        changed = true;
    }
    const marker = { schemaVersion: 1, managedBy: OWNER, sceneUuid, scriptUuid,
        hashes: Object.fromEntries([...generated].map(([name, value]) => [name, hash(value)])) };
    if (!previous || JSON.stringify(previous) !== JSON.stringify(marker)) support.writeJson(markerPath, marker);
    return {
        scene: { url: `${ASSET_URL}/${SCENE_NAME}`, uuid: sceneUuid },
        assetUrl: ASSET_URL, directory, changed,
        plugins: entries.map(entry => ({ name: entry.name, nativeClass: entry.nativeClass, test: entry.probePath ? 'component' : 'native-registration' })),
    };
}

module.exports = { ensureDevHost, _internal: { scriptClassId, bootstrapSource, sceneSource } };
