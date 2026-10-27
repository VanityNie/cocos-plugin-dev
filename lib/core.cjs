'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const support = require('../templates/common/editor/plugin-support.cjs');
const TEMPLATE_ROOT = path.resolve(__dirname, '..', 'templates');
const { OWNER, validateName, inside, noLinks, projectRoot, readJson, write, writeJson, readState, walk, pluginInfo } = support;

function createPlugin({ projectPath, pluginPath: requestedPath, name, displayName = name, template = 'native', enginePath }) {
    const project = projectPath ? projectRoot(projectPath) : undefined;
    if (!project && !requestedPath) throw new Error('创建插件需要 pluginPath（独立源码目录）或 projectPath（内嵌插件宿主）。');
    validateName(name);
    if (!['native', 'render'].includes(template)) throw new Error('模板必须是 native 或 render。');
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 120 || /[\r\n\x00-\x1f]/.test(displayName)) {
        throw new Error('显示名称需要为 1–120 字符的单行文本。');
    }
    if (enginePath && !fs.existsSync(path.join(enginePath, 'native', 'CMakeLists.txt'))) {
        throw new Error('enginePath 必须指向包含 native/CMakeLists.txt 的引擎根目录。');
    }
    const pluginPath = requestedPath ? path.resolve(requestedPath) : path.join(project, 'extensions', name);
    noLinks(path.parse(pluginPath).root, pluginPath);
    if (fs.existsSync(pluginPath)) throw new Error(`插件目录已存在，拒绝覆盖: ${pluginPath}`);
    if (project) {
        if (requestedPath) validateSourceLocation(project, pluginPath);
        const runtimePath = path.join(project, 'assets', '__plugin_dev', name);
        noLinks(project, runtimePath);
        noLinks(project, path.join(project, '.plugin-dev', 'state.json'));
        noLinks(project, path.join(project, '.plugin-dev', '.gitignore'));
        if (fs.existsSync(runtimePath)) throw new Error(`运行时目标目录已存在，拒绝接管: ${runtimePath}`);
        if (readState(project).plugins[name]) throw new Error(`项目中已有 ${name} 的开发记录，请先检查原插件文件。`);
        if (requestedPath && (support.readHost(project).plugins[name] || fs.existsSync(path.join(project, 'extensions', name)))) throw new Error(`宿主同名插件已存在: ${name}`);
    }
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
        RENDER_README: render ? `## 渲染扩展\n\ninstallRenderProbe() 在当前原生管线注册名为 \`${name}.probe.v1\` 的 CustomComputePass；返回 false 表示原生自定义管线不可用。renderExecutionCount() 统计图节点调用回调的次数。\n\n模板只注册回调，未添加渲染图节点或执行推理。接入时由项目 PipelineBuilder 添加节点，并声明资源读写与同步关系。空回调不可作为输出纹理的生产者。\n` : '',
    };
    const files = new Map();
    for (const folder of ['common', ...(render ? ['render'] : [])]) {
        for (const rel of walk(path.join(TEMPLATE_ROOT, folder))) {
            const destination = rel === 'native/windows/plugin-config.cmake' ? `native/windows/${target}-config.cmake`
                : rel === 'native/android/plugin-config.cmake' ? `native/android/${target}-config.cmake` : rel;
            const source = fs.readFileSync(path.join(TEMPLATE_ROOT, folder, rel), 'utf8');
            files.set(destination, source.replace(/\{\{([A-Z_]+)\}\}/g, (match, token) => {
                if (!Object.prototype.hasOwnProperty.call(substitutions, token)) throw new Error(`未知模板占位符: ${token}`);
                return substitutions[token];
            }));
        }
    }
    const meta = { schemaVersion: requestedPath ? 2 : 1, managedBy: OWNER, name, displayName, template, ...(!requestedPath ? { enabled: true } : {}), target, nativeClass };
    files.set('plugin-dev.json', `${JSON.stringify(meta, null, 2)}\n`);
    files.set('package.json', `${JSON.stringify({
        name, title: displayName, package_version: 2, version: '0.1.0',
        description: 'TS + C++ project plugin generated by Cocos Plugin Development',
        main: './editor/main.js',
        contributions: { builder: './editor/builder.js', messages: { sync: { methods: ['sync'] } } },
    }, null, 2)}\n`);
    files.set('native/cc_plugin.json', `${JSON.stringify({
        name, version: '0.1.0', author: 'Plugin developer', description: `${name} native runtime`,
        'engine-version': '>=3.8.0 <5.0.0', disabled: false, modules: [{ target }], platforms: ['windows', 'android'],
    }, null, 2)}\n`);
    if (requestedPath) files.set('.gitignore', '.plugin-dev/\n.local/\nbuild/\nout/\ncache/\n.vs/\nnode_modules/\nCMakeFiles/\nCMakeCache.txt\ncompile_commands.json\n*.obj\n*.pdb\n*.ilk\n*.log\n');
    // Rendering all templates before touching the project avoids partial generation.
    fs.mkdirSync(pluginPath, { recursive: true });
    for (const [rel, data] of files) write(path.join(pluginPath, rel), data);
    const result = project ? requestedPath ? linkPlugin({ projectPath: project, sourcePath: pluginPath }) : support.syncPlugin({ projectPath: project, name })
        : { ...meta, pluginPath, sourcePath: pluginPath, sourceType: 'local', standalone: true };
    if (!project || enginePath) support.syncTypeDeclarations(project, pluginPath, enginePath);
    return { ...result, path: pluginPath, nativeClass, component: `${className}Probe`, enginePath: enginePath ? path.resolve(enginePath) : undefined };
}

function validateSourceLocation(project, source) {
    for (const [root, candidate] of [[project, source], [source, project]]) {
        const relative = path.relative(root, candidate);
        if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error('独立插件源码和宿主项目必须位于互不包含的目录。');
    }
}

function linkPlugin({ projectPath, sourcePath }) {
    const project = projectRoot(projectPath);
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error('关联宿主需要独立插件源码路径 sourcePath。');
    const source = support.sourceInfo(sourcePath);
    validateSourceLocation(project, source.pluginPath);
    const name = source.meta.name;
    const host = support.readHost(project);
    if (host.plugins[name]) {
        if (path.resolve(project, host.plugins[name].source) !== source.pluginPath) throw new Error(`宿主已关联 ${name} 的其他源码；请先解除现有引用。`);
        return { ...support.syncPlugin({ projectPath: project, name }), linked: true };
    }
    const extensionPath = path.join(project, 'extensions', name);
    noLinks(project, extensionPath);
    if (fs.existsSync(extensionPath)) throw new Error(`宿主同名扩展已存在，拒绝覆盖: ${extensionPath}`);
    const runtimePath = path.join(project, 'assets', '__plugin_dev', name);
    const previous = readState(project).plugins[name];
    if (fs.existsSync(runtimePath) && !previous?.detached) throw new Error(`运行时目标目录已存在，拒绝接管: ${runtimePath}`);
    const relative = path.relative(project, source.pluginPath);
    host.plugins[name] = { source: (path.isAbsolute(relative) ? source.pluginPath : relative).replace(/\\/g, '/'), enabled: true };
    const info = { ...source, sourceMeta: source.meta, meta: { ...source.meta, enabled: true }, sourceType: 'local', extensionPath, runtimePath, host };
    const plan = support.prepareSync(project, name, true, info);
    return { ...support.applySync(plan), linked: true };
}

function unlinkPlugin({ projectPath, name }) {
    const project = projectRoot(projectPath);
    validateName(name);
    const host = support.readHost(project);
    if (!host.plugins[name]) throw new Error('仅独立源码引用可以解除；内嵌插件请使用禁用。');
    const sourcePath = path.resolve(project, host.plugins[name].source);
    const extensionPath = path.join(project, 'extensions', name);
    const runtimePath = path.join(project, 'assets', '__plugin_dev', name);
    noLinks(project, extensionPath);
    if (fs.existsSync(extensionPath)) {
        const marker = path.join(extensionPath, '.plugin-dev-adapter.json');
        noLinks(project, marker);
        const ownership = readJson(marker);
        if (ownership.schemaVersion !== 1 || ownership.managedBy !== OWNER || ownership.name !== name || !ownership.files) throw new Error(`宿主适配目录归属不匹配: ${extensionPath}`);
        for (const rel of walk(extensionPath)) {
            if (rel === '.plugin-dev-adapter.json') continue;
            if (!ownership.files[rel] || support.hash(fs.readFileSync(path.join(extensionPath, rel))) !== ownership.files[rel]) throw new Error(`宿主适配目录包含未管理或手工修改的文件，拒绝移除: ${path.join(extensionPath, rel)}`);
        }
    }
    const state = readState(project);
    const previous = state.plugins[name] || {};
    const enabledFile = path.join(runtimePath, 'plugin-enabled.ts');
    noLinks(project, enabledFile);
    if (fs.existsSync(enabledFile)) {
        const current = fs.readFileSync(enabledFile);
        if (!current.equals(support.enabledRuntime(true)) && !current.equals(support.enabledRuntime(false))) throw new Error(`同步冲突，启用状态文件包含手工修改: ${enabledFile}`);
    }
    write(enabledFile, support.enabledRuntime(false));
    delete host.plugins[name];
    writeJson(path.join(project, 'plugin-dev.host.json'), host);
    inside(path.join(project, 'extensions'), extensionPath);
    if (fs.existsSync(extensionPath)) fs.rmSync(extensionPath, { recursive: true });
    state.plugins[name] = { ...previous, sourcePath, enabled: false, detached: true, needsRebuild: true, assetsDirty: true,
        tracked: { ...previous.tracked, 'plugin-enabled.ts': support.hash(support.enabledRuntime(false)) } };
    writeJson(path.join(project, '.plugin-dev', 'state.json'), state);
    return { name, pluginPath: sourcePath, sourcePath, extensionPath, runtimePath, sourceType: 'local', enabled: false,
        linked: false, detached: true, needsRebuild: true, assetsDirty: true, copied: 1, removed: 0, assetUrl: `db://assets/__plugin_dev/${name}` };
}

function listPlugins({ projectPath, includeErrors = false }) {
    const project = projectRoot(projectPath);
    const directory = path.join(project, 'extensions');
    noLinks(project, directory);
    const state = readState(project);
    const host = support.readHost(project);
    const names = new Set(Object.keys(host.plugins));
    if (fs.existsSync(directory)) for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!item.isDirectory() || item.name === OWNER) continue;
        const extension = path.join(directory, item.name);
        if (fs.existsSync(path.join(extension, '.plugin-dev-adapter.json')) && !names.has(item.name)) throw new Error(`宿主适配目录缺少 plugin-dev.host.json 引用，请恢复配置: ${extension}`);
        if (fs.existsSync(path.join(extension, 'plugin-dev.json'))) names.add(item.name);
    }
    const result = [];
    for (const name of names) {
        try {
            const info = pluginInfo(project, name);
            const record = state.plugins[name];
            const pendingRuntime = support.prepareSync(project, name);
            const assetsDirty = !record || record.assetsDirty !== false || record.enabled !== info.meta.enabled || pendingRuntime.writes.length > 0 || pendingRuntime.deletes.length > 0;
            result.push({ ...info.meta, pluginPath: info.pluginPath, sourcePath: info.sourcePath, extensionPath: info.extensionPath, sourceType: info.sourceType, path: info.pluginPath, runtimePath: info.runtimePath,
                needsRebuild: !record || record.needsRebuild !== false || assetsDirty || info.adapterMissing || record.sourcePath !== info.pluginPath || record.nativeFingerprint !== support.nativeFingerprint(info.pluginPath, info.meta),
                assetsDirty, lastSync: record?.lastSync });
        } catch (error) {
            if (!includeErrors || !host.plugins[name]) throw error;
            const sourcePath = path.resolve(project, host.plugins[name].source);
            result.push({ name, displayName: name, sourceType: 'local', sourcePath, pluginPath: sourcePath, path: sourcePath,
                extensionPath: path.join(project, 'extensions', name), enabled: host.plugins[name].enabled, error: error.message });
        }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
}

const EXCLUDED_DIRECTORIES = new Set(['.git', '.plugin-dev', '.local', '.vs', '.vscode', '.idea', 'node_modules', 'build', 'out', 'temp', 'tmp', 'cache', 'library', 'CMakeFiles', 'tests']);
function distributable(rel, item) {
    if (item.isDirectory()) return !EXCLUDED_DIRECTORIES.has(item.name);
    return !/(^|\/)(CMakeCache\.txt|compile_commands\.json|\.DS_Store|\.cocos-plugin-dev-install\.json)$/.test(rel)
        && !/\.(obj|pdb|ilk|log|tmp|bak)$/.test(item.name);
}

function preparePackage({ projectPath, name, outputDir, binary = false, buildType, platform, abi }) {
    const project = projectRoot(projectPath);
    if (typeof binary !== 'boolean') throw new Error('binary 必须为布尔值。');
    if (!binary && buildType !== undefined) throw new Error('package --build-type 需要同时指定 --binary。');
    const normalizedPlatform = platform === undefined || platform === null || platform === '' ? 'windows'
        : typeof platform === 'string' && ['windows', 'android'].includes(platform.trim().toLowerCase()) ? platform.trim().toLowerCase()
            : (() => { throw new Error(`不支持的打包平台: ${platform}（可选 windows 或 android）。`); })();
    if (!binary && platform !== undefined && normalizedPlatform !== 'windows') throw new Error('package --platform 仅用于 --binary 二进制打包；源码包同时包含多平台支持。');
    if (abi !== undefined && (!binary || normalizedPlatform !== 'android')) throw new Error('package --abi 需要同时指定 --binary 与 --platform android。');
    support.syncPlugin({ projectPath: project, name });
    const info = pluginInfo(project, name);
    const pkg = readJson(path.join(info.pluginPath, 'package.json'));
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('插件 package.json.version 必须是安全的语义版本号。');
    const binaryPlan = binary ? require('./binary-package.cjs').prepareBinaryPackage({ projectPath: project, info, buildType, platform: normalizedPlatform, abi }) : undefined;
    const output = path.resolve(outputDir || path.join(project, '.plugin-dev', 'packages'));
    const relative = path.relative(info.pluginPath, output);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('打包输出不能位于插件源码目录内。');
    noLinks(path.parse(output).root, output);
    const binarySuffix = binaryPlan
        ? binaryPlan.platform === 'android' ? `-android-${binaryPlan.abi}-${binaryPlan.buildType}` : `-windows-x64-${binaryPlan.buildType}`
        : '';
    const directory = path.join(output, `${name}-${pkg.version}${binarySuffix}`);
    const zipPath = `${directory}.zip`;
    if (fs.existsSync(directory) || fs.existsSync(zipPath)) throw new Error(`打包目标已存在，请更换输出位置或更新版本: ${directory}`);
    const entryMap = new Map();
    for (const rel of walk(info.pluginPath, (rel, item) => distributable(rel, item) && (!binaryPlan || binaryPlan.include(rel, item)))) {
        let data = { source: path.join(info.pluginPath, rel) };
        if (rel === 'plugin-dev.json') data = Buffer.from(`${JSON.stringify({ ...info.sourceMeta, schemaVersion: 1, enabled: true }, null, 2)}\n`);
        if (rel === 'native/cc_plugin.json') data = Buffer.from(`${JSON.stringify({ ...readJson(data.source), disabled: false }, null, 2)}\n`);
        entryMap.set(`${name}/${rel}`, data);
    }
    const publishedPackage = { ...pkg, contributions: { ...pkg.contributions, builder: './editor/builder.js' } };
    entryMap.set(`${name}/package.json`, Buffer.from(`${JSON.stringify(publishedPackage, null, 2)}\n`));
    for (const [rel, data] of support.adapterFiles(info, true)) {
        if (rel.startsWith('editor/') && rel !== 'editor/main.js') entryMap.set(`${name}/${rel}`, data);
    }
    if (typeof pkg.main !== 'string' || !pkg.main) throw new Error('发布插件需要 package.json.main 编辑器入口。');
    const mainPath = inside(info.pluginPath, path.resolve(info.pluginPath, pkg.main));
    const mainRelative = path.relative(info.pluginPath, mainPath).replace(/\\/g, '/');
    if (!entryMap.has(`${name}/${mainRelative}`)) throw new Error(`编辑器入口未包含在发布包中: ${pkg.main}`);
    if (binaryPlan) for (const [rel, data] of binaryPlan.entries) entryMap.set(`${name}/${rel}`, data);
    for (const runtime of binaryPlan ? [] : support.collectRuntimeFiles(info.pluginPath, info.meta)) {
        const relativeSource = path.relative(info.pluginPath, runtime.source).replace(/\\/g, '/');
        if (!entryMap.has(`${name}/${relativeSource}`)) throw new Error(`运行时文件未包含在发布包中: ${relativeSource}`);
    }
    const warnings = [];
    let metadataSeeds = 0;
    for (const rel of walk(info.runtimePath)) {
        if (!rel.endsWith('.meta')) continue;
        const asset = rel.slice(0, -5);
        const prefix = `${name}/runtime/${asset}`;
        if (!entryMap.has(prefix) && ![...entryMap.keys()].some(key => key.startsWith(`${prefix}/`))) continue;
        const key = `${name}/runtime/${rel}`;
        const metadata = fs.readFileSync(path.join(info.runtimePath, rel));
        const entry = entryMap.get(key);
        const existing = entry && (Buffer.isBuffer(entry) ? entry : fs.readFileSync(entry.source));
        if (existing && !existing.equals(metadata)) warnings.push(`runtime/${rel}: 源 metadata 与项目已导入 metadata 不同；导出使用项目当前 UUID，源文件保持不变。`);
        entryMap.set(key, metadata);
        metadataSeeds++;
    }
    return { entries: entryMap, result: { name, version: pkg.version, directory, packagePath: path.join(directory, name), zipPath,
        fileCount: entryMap.size, metadataSeeds, warnings, binary, ...(binaryPlan ? { platform: binaryPlan.platform, ...(binaryPlan.abi ? { abi: binaryPlan.abi } : {}), buildType: binaryPlan.buildType, binaryManifest: binaryPlan.manifest } : {}) } };
}

async function packagePlugin(options) {
    const project = projectRoot(options.projectPath);
    const processes = require('./processes.cjs');
    return processes.withLock(project, async () => {
        const prepared = support.withProjectLock(project, () => preparePackage(options));
        await require('./package-archive.cjs').publishPackage(prepared, options.signal);
        return prepared.result;
    }, options);
}

function dependencyDirectory(name, from) {
    let directory = path.dirname(require.resolve(name, { paths: [from] }));
    for (;;) {
        const manifest = path.join(directory, 'package.json');
        if (fs.existsSync(manifest) && readJson(manifest).name === name) return directory;
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error(`无法定位工具依赖的 package.json: ${name}`);
        directory = parent;
    }
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
    // Creator recursively scans extensions for cc_plugin.json. Only ship the
    // workbench runtime; repository fixtures must never become host plugins.
    const runtimeDirectories = new Set(['lib', 'panels', 'templates']);
    const runtimeFiles = new Set(['package.json', 'main.js', 'cli.cjs', 'LICENSE', 'README.md', 'README.en.md']);
    const projectRelative = path.relative(source, project).replace(/\\/g, '/');
    for (const rel of walk(source, (rel, item) => {
        // A development sandbox may live underneath the tool checkout. Never
        // recursively install the user's game inside the tool's own extension.
        if (item.isDirectory() && rel === projectRelative) return false;
        const root = rel.split('/')[0];
        return (runtimeDirectories.has(root) || runtimeFiles.has(rel)) && distributable(rel, item);
    })) {
        let data = fs.readFileSync(path.join(source, rel));
        if (rel === 'package.json') {
            const installedPackage = JSON.parse(data);
            delete installedPackage.devDependencies;
            if (installedPackage.scripts) delete installedPackage.scripts.test;
            data = Buffer.from(`${JSON.stringify(installedPackage, null, 2)}\n`);
        }
        desired.set(rel, data); records[rel] = crypto.createHash('sha256').update(data).digest('hex');
    }
    const dependencies = Object.keys(sourcePackage.dependencies || { typescript: '*' }).map(name => ({ name, from: source }));
    const installed = new Map();
    for (let index = 0; index < dependencies.length; index++) {
        const { name, from } = dependencies[index];
        const dependencyRoot = dependencyDirectory(name, from);
        const dependency = readJson(path.join(dependencyRoot, 'package.json'));
        if (installed.has(name)) {
            if (installed.get(name) !== dependency.version) throw new Error(`工具依赖包含多个版本，无法安装: ${name}`);
            continue;
        }
        installed.set(name, dependency.version);
        for (const rel of walk(dependencyRoot, (rel, item) => !item.isDirectory() || item.name !== 'node_modules')) {
            const data = fs.readFileSync(path.join(dependencyRoot, rel));
            const target = `node_modules/${name}/${rel}`;
            desired.set(target, data);
            records[target] = support.hash(data);
        }
        for (const child of Object.keys(dependency.dependencies || {})) dependencies.push({ name: child, from: dependencyRoot });
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
module.exports = { createPlugin: options => options.projectPath ? locked(createPlugin)(options) : createPlugin(options), linkPlugin: locked(linkPlugin), unlinkPlugin: locked(unlinkPlugin), listPlugins: locked(listPlugins), setEnabled: support.setEnabled, syncPlugin: support.syncPlugin,
    packagePlugin, installTools: locked(installTools) };
