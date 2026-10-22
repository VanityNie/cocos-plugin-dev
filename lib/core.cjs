'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const support = require('../templates/common/editor/plugin-support.cjs');
const TEMPLATE_ROOT = path.resolve(__dirname, '..', 'templates');
const { OWNER, validateName, inside, noLinks, projectRoot, readJson, write, writeJson, readState, walk, pluginInfo } = support;

function createPlugin({ projectPath, name, displayName = name, template = 'native', enginePath }) {
    const project = projectRoot(projectPath);
    validateName(name);
    if (!['native', 'render'].includes(template)) throw new Error('模板必须是 native 或 render。');
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 120 || /[\r\n\x00-\x1f]/.test(displayName)) {
        throw new Error('显示名称需要为 1–120 字符的单行文本。');
    }
    if (enginePath && !fs.existsSync(path.join(enginePath, 'native', 'CMakeLists.txt'))) {
        throw new Error('enginePath 必须指向包含 native/CMakeLists.txt 的引擎根目录。');
    }
    const pluginPath = path.join(project, 'extensions', name);
    const runtimePath = path.join(project, 'assets', '__plugin_dev', name);
    noLinks(project, pluginPath);
    noLinks(project, runtimePath);
    noLinks(project, path.join(project, '.plugin-dev', 'state.json'));
    noLinks(project, path.join(project, '.plugin-dev', '.gitignore'));
    if (fs.existsSync(pluginPath)) throw new Error(`插件目录已存在，拒绝覆盖: ${pluginPath}`);
    if (fs.existsSync(runtimePath)) throw new Error(`运行时目标目录已存在，拒绝接管: ${runtimePath}`);
    const state = readState(project);
    if (state.plugins[name]) throw new Error(`项目中已有 ${name} 的开发记录，请先检查原插件文件。`);
    const suffix = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
    const className = name.split('-').map(piece => piece[0].toUpperCase() + piece.slice(1)).join('');
    const target = `cpd_${name.replace(/-/g, '_')}_${suffix}`;
    const nativeClass = `Cpd${className}_${suffix}`;
    const namespace = `cpd_${suffix}`;
    const render = template === 'render';
    const substitutions = {
        NAME: name, DISPLAY_NAME: displayName, TEMPLATE: template, CLASS: className,
        TARGET: target, NATIVE_CLASS: nativeClass, NAMESPACE: namespace,
        NATIVE_API_EXTRA: render ? '    installRenderProbe(): boolean;\n    renderExecutionCount(): number;' : '',
        TS_EXTRA: render ? `    /** Registers a native callback; does not add a graph node or produce an image. */\n    installRenderProbe(): boolean { return nativeBridge()?.installRenderProbe() ?? false; },\n    renderExecutionCount(): number { return nativeBridge()?.renderExecutionCount() ?? 0; },\n    behaviorName: '${name}.probe.v1',` : '',
        PROBE_EXTRA: render ? `        log('[${name}] render callback registered:', ${className}.installRenderProbe());\n        // An execution count of zero is expected until an explicit graph node runs.` : '',
        CMAKE_EXTRA: render ? '    "${CMAKE_CURRENT_LIST_DIR}/RenderProbe.cpp"' : '',
        CPP_INCLUDE: render ? '#include "RenderProbe.h"' : '',
        CPP_METHODS: render ? `    static bool installRenderProbe() { return ${namespace}::installRenderProbe(); }\n    static unsigned int renderExecutionCount() { return ${namespace}::executionCount(); }` : '',
        CPP_BINDINGS: render ? `        .staticFunction("installRenderProbe", &${className}Bridge::installRenderProbe)\n        .staticFunction("renderExecutionCount", &${className}Bridge::renderExecutionCount)` : '',
        RENDER_README: render ? `## Render probe (not an inference implementation)\n\nThe sample registers a CustomComputePass named \`${name}.probe.v1\` on the\ncurrent native pipeline. It does not alter the project's PipelineBuilder, add\na pass, declare a writable texture, or claim to produce an image.\n\nThe scene component calls installRenderProbe after startup; false means a native\ncustom pipeline is unavailable. renderExecutionCount increments only when a graph\nnode actually reaches the callback. A registration success is not a rendered\nframe or an executed model. The no-op probe must never be used as the producer of\na texture: the graph could consume uninitialized data.\n\nNext implement a real backend and its resource read/write contract, then insert\na compute node from your project's chosen PipelineBuilder. Keep the existing\nimage path until valid output and synchronization are verified. Registry names\nare per pipeline; no global installed flag is used.\n` : '',
    };
    const files = new Map();
    for (const folder of ['common', ...(render ? ['render'] : [])]) {
        for (const rel of walk(path.join(TEMPLATE_ROOT, folder))) {
            const destination = rel === 'native/windows/plugin-config.cmake' ? `native/windows/${target}-config.cmake` : rel;
            const source = fs.readFileSync(path.join(TEMPLATE_ROOT, folder, rel), 'utf8');
            files.set(destination, source.replace(/\{\{([A-Z_]+)\}\}/g, (match, token) => {
                if (!Object.prototype.hasOwnProperty.call(substitutions, token)) throw new Error(`未知模板占位符: ${token}`);
                return substitutions[token];
            }));
        }
    }
    const meta = { schemaVersion: 1, managedBy: OWNER, name, displayName, template, enabled: true, target, nativeClass };
    files.set('plugin-dev.json', `${JSON.stringify(meta, null, 2)}\n`);
    files.set('package.json', `${JSON.stringify({
        name, title: displayName, package_version: 2, version: '0.1.0',
        description: 'TS + C++ project plugin generated by Cocos Plugin Development',
        main: './editor/main.js',
        contributions: { messages: { sync: { methods: ['sync'] } } },
    }, null, 2)}\n`);
    files.set('native/cc_plugin.json', `${JSON.stringify({
        name, version: '0.1.0', author: 'Plugin developer', description: `${name} native runtime`,
        'engine-version': '>=3.8.0 <5.0.0', disabled: false, modules: [{ target }], platforms: ['windows'],
    }, null, 2)}\n`);
    // Rendering all templates before touching the project avoids partial generation.
    fs.mkdirSync(pluginPath, { recursive: true });
    for (const [rel, data] of files) write(path.join(pluginPath, rel), data);
    const result = support.syncPlugin({ projectPath: project, name });
    return { ...result, path: pluginPath, nativeClass, component: `${className}Probe`, enginePath: enginePath ? path.resolve(enginePath) : undefined };
}

function listPlugins({ projectPath }) {
    const project = projectRoot(projectPath);
    const directory = path.join(project, 'extensions');
    noLinks(project, directory);
    if (!fs.existsSync(directory)) return [];
    const state = readState(project);
    const result = [];
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!item.isDirectory() || item.name === OWNER) continue;
        const file = path.join(directory, item.name, 'plugin-dev.json');
        if (!fs.existsSync(file)) continue;
        const info = pluginInfo(project, item.name);
        const record = state.plugins[item.name];
        const pendingRuntime = support.prepareSync(project, item.name);
        const assetsDirty = !record || record.assetsDirty !== false || pendingRuntime.writes.length > 0 || pendingRuntime.deletes.length > 0;
        result.push({ ...info.meta, pluginPath: info.pluginPath, path: info.pluginPath, runtimePath: info.runtimePath,
            needsRebuild: !record || record.needsRebuild !== false || assetsDirty || record.nativeFingerprint !== support.nativeFingerprint(info.pluginPath),
            assetsDirty, lastSync: record?.lastSync });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
}

const EXCLUDED_DIRECTORIES = new Set(['.git', '.plugin-dev', '.local', '.vs', '.vscode', '.idea', 'node_modules', 'build', 'out', 'temp', 'tmp', 'cache', 'library', 'CMakeFiles', 'tests']);
function distributable(rel, item) {
    if (item.isDirectory()) return !EXCLUDED_DIRECTORIES.has(item.name);
    return !/(^|\/)(CMakeCache\.txt|compile_commands\.json|\.DS_Store|\.cocos-plugin-dev-install\.json)$/.test(rel)
        && !/\.(obj|pdb|ilk|log|tmp|bak)$/.test(item.name);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
function crc32(buffer) {
    let value = 0xffffffff;
    for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}
function storedZip(entries) {
    const local = [];
    const central = [];
    let offset = 0;
    for (const [name, data] of entries) {
        const fileName = Buffer.from(name, 'utf8');
        if (data.length > 0xffffffff || fileName.length > 0xffff) throw new Error('包超出 ZIP32 大小限制。');
        const checksum = crc32(data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
        header.writeUInt16LE(0x5021, 12); header.writeUInt32LE(checksum, 14);
        header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(fileName.length, 26);
        local.push(header, fileName, data);
        const index = Buffer.alloc(46);
        index.writeUInt32LE(0x02014b50, 0); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6);
        index.writeUInt16LE(0x800, 8); index.writeUInt16LE(0x5021, 14); index.writeUInt32LE(checksum, 16);
        index.writeUInt32LE(data.length, 20); index.writeUInt32LE(data.length, 24);
        index.writeUInt16LE(fileName.length, 28); index.writeUInt32LE(offset, 42);
        central.push(index, fileName);
        offset += header.length + fileName.length + data.length;
    }
    const directorySize = central.reduce((total, item) => total + item.length, 0);
    if (entries.length > 65535 || offset + directorySize > 0xffffffff) throw new Error('包超出 ZIP32 大小限制。');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, ...central, end]);
}

function packagePlugin({ projectPath, name, outputDir }) {
    const project = projectRoot(projectPath);
    // Surface unresolved mirrors before packaging; never silently ship stale source.
    support.syncPlugin({ projectPath: project, name });
    const info = pluginInfo(project, name);
    const pkg = readJson(path.join(info.pluginPath, 'package.json'));
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('插件 package.json.version 必须是安全的语义版本号。');
    const output = path.resolve(outputDir || path.join(project, '.plugin-dev', 'packages'));
    const relative = path.relative(info.pluginPath, output);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('打包输出不能位于插件源码目录内。');
    noLinks(path.parse(output).root, output);
    const directory = path.join(output, `${name}-${pkg.version}`);
    const zipPath = `${directory}.zip`;
    if (fs.existsSync(directory) || fs.existsSync(zipPath)) throw new Error(`打包目标已存在，请更换输出位置或更新版本: ${directory}`);
    const entries = [];
    for (const rel of walk(info.pluginPath, distributable)) {
        let data = fs.readFileSync(path.join(info.pluginPath, rel));
        if (rel === 'plugin-dev.json') data = Buffer.from(`${JSON.stringify({ ...info.meta, enabled: true }, null, 2)}\n`);
        if (rel === 'native/cc_plugin.json') data = Buffer.from(`${JSON.stringify({ ...JSON.parse(data), disabled: false }, null, 2)}\n`);
        entries.push([`${name}/${rel}`, data]);
    }
    // Creator generates UUID metadata alongside the imported mirror, not in the
    // extension's source tree. Ship those identities with source assets so that
    // prefabs/materials/scene references survive installation in another game.
    const entryMap = new Map(entries);
    const warnings = [];
    let metadataSeeds = 0;
    for (const rel of walk(info.runtimePath)) {
        if (!rel.endsWith('.meta')) continue;
        const asset = rel.slice(0, -5);
        const prefix = `${name}/runtime/${asset}`;
        if (!entryMap.has(prefix) && ![...entryMap.keys()].some(key => key.startsWith(`${prefix}/`))) continue;
        const key = `${name}/runtime/${rel}`;
        const metadata = fs.readFileSync(path.join(info.runtimePath, rel));
        const existing = entryMap.get(key);
        if (existing && !existing.equals(metadata)) warnings.push(`runtime/${rel}: 源 metadata 与项目已导入 metadata 不同；导出使用项目当前 UUID，源文件保持不变。`);
        entryMap.set(key, metadata);
        metadataSeeds++;
    }
    entries.splice(0, entries.length, ...entryMap.entries());
    const zip = storedZip(entries);
    for (const [rel, data] of entries) write(path.join(directory, rel), data);
    write(zipPath, zip);
    return { name, version: pkg.version, directory, packagePath: path.join(directory, name), zipPath, fileCount: entries.length, metadataSeeds, warnings };
}

function installTools({ projectPath, sourcePath = path.resolve(__dirname, '..') }) {
    const project = projectRoot(projectPath);
    const source = path.resolve(sourcePath);
    const destination = path.join(project, 'extensions', OWNER);
    if (source === destination) throw new Error('工具已在此项目目录内，无需重复安装。');
    noLinks(project, destination);
    noLinks(project, path.join(project, '.plugin-dev', '.gitignore'));
    const sourcePackage = readJson(path.join(source, 'package.json'));
    if (sourcePackage.name !== OWNER) throw new Error('sourcePath 不是 cocos-plugin-dev 工具目录。');
    const marker = path.join(destination, '.cocos-plugin-dev-install.json');
    let previous = {};
    if (fs.existsSync(destination)) {
        noLinks(project, marker);
        if (!fs.existsSync(marker)) throw new Error(`同名扩展已存在且不属于本工具，拒绝覆盖: ${destination}`);
        const ownership = readJson(marker);
        if (ownership.managedBy !== OWNER || !ownership.files) throw new Error('工具安装记录不匹配，拒绝覆盖。');
        previous = ownership.files;
    }
    const desired = new Map();
    const records = {};
    // Keep this tool's small source tests: package.json exposes npm test after installation.
    const projectRelative = path.relative(source, project).replace(/\\/g, '/');
    for (const rel of walk(source, (rel, item) => {
        // A development sandbox may live underneath the tool checkout. Never
        // recursively install the user's game inside the tool's own extension.
        if (item.isDirectory() && rel === projectRelative) return false;
        return item.isDirectory() && rel === 'tests' ? true : distributable(rel, item);
    })) {
        const data = fs.readFileSync(path.join(source, rel));
        desired.set(rel, data); records[rel] = crypto.createHash('sha256').update(data).digest('hex');
    }
    const removals = [];
    const conflicts = [];
    for (const rel of new Set([...Object.keys(previous), ...desired.keys()])) {
        const file = inside(destination, path.join(destination, rel));
        noLinks(project, file);
        if (!fs.existsSync(file)) continue;
        const checksum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (checksum !== previous[rel] && checksum !== records[rel]) conflicts.push(file);
        else if (!desired.has(rel)) removals.push(file);
    }
    if (conflicts.length) throw new Error(`工具文件包含手工修改，请先备份再升级:\n${conflicts.join('\n')}`);
    for (const [rel, data] of desired) write(path.join(destination, rel), data);
    for (const file of removals) fs.unlinkSync(file);
    writeJson(marker, { schemaVersion: 1, managedBy: OWNER, files: records });
    support.ensureLocalIgnore(project);
    return { installed: true, projectPath: project, path: destination, extensionPath: destination, version: sourcePackage.version, files: desired.size };
}

function locked(operation) {
    return options => support.withProjectLock(projectRoot(options.projectPath), () => operation(options));
}
module.exports = { createPlugin: locked(createPlugin), listPlugins: locked(listPlugins), setEnabled: support.setEnabled, syncPlugin: support.syncPlugin,
    packagePlugin: locked(packagePlugin), installTools: locked(installTools) };
