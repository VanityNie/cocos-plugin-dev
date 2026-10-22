'use strict';

// Also shipped inside generated plugins: installed packages need no development tool.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const OWNER = 'cocos-plugin-dev';
const heldLocks = new Set();

function fail(message) { throw new Error(message); }
function validateName(name) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)
        || name.length > 64 || name === OWNER || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:-|$)/i.test(name)) {
        fail('插件名称必须为小写 kebab-case（最多 64 字符），且不能使用保留名称。');
    }
    return name;
}
function inside(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`路径越界: ${candidate}`);
    return candidate;
}
function noLinks(root, candidate) {
    inside(root, candidate);
    let current = path.resolve(candidate);
    const limit = path.resolve(root);
    for (;;) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail(`不支持符号链接或目录联接: ${current}`);
        if (current === limit) break;
        current = path.dirname(current);
    }
}
function projectRoot(projectPath) {
    if (typeof projectPath !== 'string' || !projectPath.trim()) fail('需要 Creator 项目路径。');
    const project = path.resolve(projectPath);
    if (!fs.existsSync(path.join(project, 'package.json')) || !fs.existsSync(path.join(project, 'assets'))) {
        fail('请选择已有 Creator 项目（需要 package.json 和 assets 目录）。');
    }
    noLinks(project, project);
    return project;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function hash(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function write(file, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (fs.existsSync(file) && fs.readFileSync(file).equals(bytes)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try { fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return true;
}
function writeJson(file, value) { return write(file, `${JSON.stringify(value, null, 2)}\n`); }
function ensureLocalIgnore(project) {
    const file = path.join(project, '.plugin-dev', '.gitignore');
    noLinks(project, file);
    if (fs.existsSync(file)) return; // A user-maintained ignore file is never rewritten.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, '*\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
}
function recoverDeadLock(project, directory, ownerFile) {
    // Serialize stale-lock recovery as well: two recoverers must not remove a
    // newly acquired operation lock using an owner record they read earlier.
    const recovery = path.join(project, '.plugin-dev', 'operation-recovery.lock');
    noLinks(project, recovery);
    try { fs.mkdirSync(recovery); } catch (error) { if (error.code === 'EEXIST') return; throw error; }
    try {
        if (!fs.existsSync(ownerFile)) return;
        const owner = readJson(ownerFile);
        if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) fail(`插件锁记录无效，请检查后恢复: ${ownerFile}`);
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; else throw probe; }
        if (!alive) {
            fs.unlinkSync(ownerFile);
            fs.rmdirSync(directory); // Unknown extra content is preserved; never recursive.
        }
    } finally { fs.rmdirSync(recovery); }
}
function withProjectLock(project, operation) {
    const key = path.resolve(project).toLowerCase();
    if (heldLocks.has(key)) return operation();
    ensureLocalIgnore(project);
    const directory = path.join(project, '.plugin-dev', 'operation.lock');
    const ownerFile = path.join(directory, 'owner.json');
    noLinks(project, ownerFile);
    const deadline = Date.now() + 3000;
    for (;;) {
        try {
            fs.mkdirSync(directory);
            fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid }));
            break;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            // Recover a lock left by a terminated process. Never steal an active
            // lock or recursively delete an unrecognized directory.
            try { recoverDeadLock(project, directory, ownerFile); }
            catch (recoveryError) { if (!['ENOENT', 'ENOTEMPTY'].includes(recoveryError.code)) throw recoveryError; }
            if (Date.now() >= deadline) fail('另一个进程正在更新插件，请等待同步结束后重试。');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
    }
    heldLocks.add(key);
    try { return operation(); }
    finally {
        heldLocks.delete(key);
        try { fs.unlinkSync(ownerFile); fs.rmdirSync(directory); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}
function readState(project) {
    const file = path.join(project, '.plugin-dev', 'state.json');
    noLinks(project, file);
    const state = fs.existsSync(file) ? readJson(file) : { schemaVersion: 1, plugins: {} };
    if (state.schemaVersion !== 1 || !state.plugins || typeof state.plugins !== 'object') fail('不支持的 plugin-dev/state.json 格式。');
    state.plugins = Object.assign(Object.create(null), state.plugins);
    return state;
}
function walk(root, filter = () => true) {
    if (!fs.existsSync(root)) return [];
    const files = [];
    function visit(directory, relative) {
        noLinks(root, directory);
        for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const rel = relative ? `${relative}/${item.name}` : item.name;
            if (!filter(rel, item)) continue;
            if (item.isSymbolicLink()) fail(`不支持符号链接: ${path.join(root, rel)}`);
            if (item.isDirectory()) visit(path.join(root, rel), rel);
            else if (item.isFile()) files.push(rel);
        }
    }
    visit(root, '');
    return files;
}
function readHost(project) {
    const file = path.join(project, 'plugin-dev.host.json');
    noLinks(project, file);
    const host = fs.existsSync(file) ? readJson(file) : { schemaVersion: 1, plugins: {} };
    if (host.schemaVersion !== 1 || !host.plugins || typeof host.plugins !== 'object' || Array.isArray(host.plugins)) fail(`宿主配置格式不支持: ${file}`);
    for (const [name, reference] of Object.entries(host.plugins)) {
        validateName(name);
        if (!reference || typeof reference.source !== 'string' || !reference.source.trim() || typeof reference.enabled !== 'boolean') fail(`宿主插件引用无效: ${name}`);
    }
    host.plugins = Object.assign(Object.create(null), host.plugins);
    return host;
}
function sourceInfo(sourcePath, expectedName) {
    const source = path.resolve(sourcePath);
    noLinks(path.parse(source).root, source);
    const file = path.join(source, 'plugin-dev.json');
    noLinks(source, file);
    if (!fs.existsSync(file)) fail(`插件源码不存在或缺少 plugin-dev.json: ${source}`);
    const meta = readJson(file);
    validateName(meta.name);
    if (meta.managedBy !== OWNER || ![1, 2].includes(meta.schemaVersion) || (expectedName && meta.name !== expectedName)
        || (meta.schemaVersion === 1 && typeof meta.enabled !== 'boolean') || (meta.schemaVersion === 2 && Object.hasOwn(meta, 'enabled'))) fail(`插件配置不匹配: ${file}`);
    return { meta, sourcePath: source, pluginPath: source };
}
function pluginInfo(project, name) {
    validateName(name);
    const extensionPath = path.join(project, 'extensions', name);
    noLinks(project, extensionPath);
    const host = readHost(project);
    const reference = host.plugins[name];
    const info = sourceInfo(reference ? path.resolve(project, reference.source) : extensionPath, name);
    const adapterMissing = !!reference && !fs.existsSync(extensionPath);
    if (reference) {
        const marker = path.join(extensionPath, '.plugin-dev-adapter.json');
        noLinks(project, marker);
        if (!adapterMissing && !fs.existsSync(marker)) fail(`宿主同名目录不属于开发引用，拒绝接管: ${extensionPath}`);
    } else if (info.meta.schemaVersion !== 1) fail(`独立插件需要通过“关联宿主”使用: ${info.pluginPath}`);
    return { ...info, meta: { ...info.meta, enabled: reference ? reference.enabled : info.meta.enabled }, sourceMeta: info.meta,
        sourceType: reference ? 'local' : 'embedded', extensionPath, host, adapterMissing,
        runtimePath: path.join(project, 'assets', '__plugin_dev', name) };
}

function adapterFiles(info, enabled) {
    const pkg = readJson(path.join(info.pluginPath, 'package.json'));
    const native = readJson(path.join(info.pluginPath, 'native', 'cc_plugin.json'));
    if (pkg.name !== info.meta.name || !Array.isArray(native.modules) || !native.modules.length) fail(`插件 package.json 或原生模块声明不匹配: ${info.pluginPath}`);
    const files = new Map();
    files.set('package.json', Buffer.from(`${JSON.stringify({ ...pkg, main: './editor/main.js' }, null, 2)}\n`));
    files.set('editor/main.js', fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8').replace(/\{\{NAME\}\}/g, info.meta.name));
    files.set('editor/plugin-support.cjs', fs.readFileSync(__filename));
    files.set('native/cc_plugin.json', `${JSON.stringify({ ...native, disabled: !enabled }, null, 2)}\n`);
    for (const module of native.modules) {
        if (typeof module.target !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(module.target)) fail(`无效的原生模块 target: ${module.target}`);
        const config = path.join(info.pluginPath, 'native', 'windows', `${module.target}-config.cmake`);
        noLinks(info.pluginPath, config);
        if (!fs.existsSync(config)) fail(`缺少 Windows 模块配置: ${config}`);
        const normalized = config.replace(/\\/g, '/');
        let delimiter = '=';
        while (normalized.includes(`]${delimiter}]`)) delimiter += '=';
        files.set(`native/windows/${module.target}-config.cmake`, `# Generated host reference; edit the independent plugin source.\ninclude([${delimiter}[${normalized}]${delimiter}])\n`);
    }
    return new Map([...files].map(([rel, value]) => [rel, Buffer.isBuffer(value) ? value : Buffer.from(value)]));
}
function prepareAdapter(project, info, enabled, initial = false) {
    const directory = info.extensionPath;
    const marker = path.join(directory, '.plugin-dev-adapter.json');
    noLinks(project, marker);
    let previous = {};
    if (!initial) {
        const record = readJson(marker);
        if (record.schemaVersion !== 1 || record.managedBy !== OWNER || record.name !== info.meta.name || !record.files) fail(`宿主适配目录归属不匹配: ${directory}`);
        previous = record.files;
    } else if (fs.existsSync(directory)) fail(`宿主同名扩展已存在，拒绝覆盖: ${directory}`);
    const desired = adapterFiles(info, enabled);
    const writes = [], deletes = [], conflicts = [], files = {};
    for (const [rel, bytes] of desired) files[rel] = hash(bytes);
    for (const rel of new Set([...Object.keys(previous), ...desired.keys()])) {
        const file = inside(directory, path.join(directory, rel));
        noLinks(project, file);
        if (fs.existsSync(file)) {
            const actual = hash(fs.readFileSync(file));
            if (actual !== previous[rel] && actual !== files[rel]) { conflicts.push(file); continue; }
            if (!desired.has(rel)) deletes.push(file);
            else if (actual !== files[rel]) writes.push({ dest: file, data: desired.get(rel) });
        } else if (desired.has(rel)) writes.push({ dest: file, data: desired.get(rel) });
        else fail(`宿主适配文件已被删除: ${file}`);
    }
    if (conflicts.length) fail(`宿主适配文件包含手工修改，请恢复生成文件或合并到独立源码:\n${conflicts.join('\n')}`);
    return { directory, marker, writes, deletes, record: { schemaVersion: 1, managedBy: OWNER, name: info.meta.name, files } };
}
function applyAdapter(plan) {
    for (const operation of plan.writes) write(operation.dest, operation.data);
    for (const file of plan.deletes) fs.unlinkSync(file);
    writeJson(plan.marker, plan.record);
}
function nativeFingerprint(pluginPath) {
    const root = path.join(pluginPath, 'native');
    const excluded = new Set(['build', 'out', 'cache', 'temp', '.vs', 'CMakeFiles']);
    const files = walk(root, (rel, item) => item.isDirectory() ? !excluded.has(item.name)
        : !/\.(obj|pdb|ilk|log|tmp)$/.test(item.name) && item.name !== 'CMakeCache.txt' && item.name !== 'compile_commands.json');
    return hash(files.map(rel => `${rel}:${hash(fs.readFileSync(path.join(root, rel)))}`).join('\n'));
}
function enabledRuntime(enabled) {
    return Buffer.from(`// Generated by cocos-plugin-dev. Edit runtime/ sources, not this directory.\nexport const PLUGIN_ENABLED = ${enabled};\n`);
}
function prepareSync(projectPath, name, enabledOverride, initialInfo) {
    const project = projectRoot(projectPath);
    const info = initialInfo || pluginInfo(project, name);
    const enabled = enabledOverride === undefined ? info.meta.enabled : enabledOverride;
    if (typeof enabled !== 'boolean') fail('enabled 必须是 boolean。');
    const state = readState(project);
    noLinks(project, path.join(project, '.plugin-dev', '.gitignore'));
    const previous = state.plugins[name] || {};
    const tracked = previous.tracked || {};
    const source = path.join(info.pluginPath, 'runtime');
    noLinks(info.pluginPath, source);
    if (!fs.existsSync(source)) fail(`插件 runtime 目录缺失: ${source}`);
    const desired = {};
    for (const rel of walk(source)) {
        if (rel === 'plugin-enabled.ts') fail('runtime/plugin-enabled.ts 是保留的自动生成文件，请从源码目录移除。');
        desired[rel] = fs.readFileSync(path.join(source, rel));
    }
    desired['plugin-enabled.ts'] = enabledRuntime(enabled);
    const writes = [];
    const deletes = [];
    const conflicts = [];
    const nextTracked = {};
    noLinks(project, info.runtimePath);
    for (const [rel, data] of Object.entries(desired)) {
        const dest = inside(info.runtimePath, path.join(info.runtimePath, rel));
        noLinks(project, dest);
        // Creator owns imported asset UUIDs; source meta is only a first-import seed.
        if (rel.endsWith('.meta') && fs.existsSync(dest)) continue;
        const checksum = hash(data);
        if (!rel.endsWith('.meta')) nextTracked[rel] = checksum;
        if (fs.existsSync(dest)) {
            if (!fs.statSync(dest).isFile()) fail(`目标不是文件: ${dest}`);
            const actual = hash(fs.readFileSync(dest));
            if (actual === checksum) continue;
            if (!tracked[rel] || actual !== tracked[rel]) { conflicts.push(dest); continue; }
        }
        writes.push({ dest, data });
    }
    for (const [rel, checksum] of Object.entries(tracked)) {
        if (Object.prototype.hasOwnProperty.call(desired, rel)) continue;
        const dest = inside(info.runtimePath, path.join(info.runtimePath, rel));
        noLinks(project, dest);
        if (!fs.existsSync(dest)) continue;
        if (!fs.statSync(dest).isFile() || hash(fs.readFileSync(dest)) !== checksum) conflicts.push(dest);
        else deletes.push(dest);
    }
    if (conflicts.length) fail(`同步冲突，保留了项目中手工修改的文件。请先把修改合并回插件 runtime/，或备份并删除冲突副本，再同步:\n${conflicts.join('\n')}`);
    const createAdapter = !!initialInfo || info.adapterMissing;
    const nativeFile = path.join(info.sourceType === 'local' && !createAdapter ? info.extensionPath : info.pluginPath, 'native', 'cc_plugin.json');
    noLinks(path.parse(nativeFile).root, nativeFile);
    const native = readJson(nativeFile);
    // Inspect the whole native source tree before any mutation, so an unsupported
    // linked dependency cannot cause an enable operation to fail halfway through.
    nativeFingerprint(info.pluginPath);
    const adapter = info.sourceType === 'local' ? prepareAdapter(project, info, enabled, createAdapter) : undefined;
    return { project, info, enabled, state, previous, nextTracked, writes, deletes, nativeFile, native, adapter };
}
function applySync(plan) {
    const { project, info, enabled, state, previous } = plan;
    ensureLocalIgnore(project);
    for (const operation of plan.writes) write(operation.dest, operation.data);
    // Delete only files whose recorded content still matches. Keep .meta UUIDs.
    for (const file of plan.deletes) fs.unlinkSync(file);
    const enableChanged = info.meta.enabled !== enabled || plan.native.disabled !== !enabled;
    info.meta.enabled = enabled;
    plan.native.disabled = !enabled;
    if (info.sourceType === 'local') {
        applyAdapter(plan.adapter);
        info.host.plugins[info.meta.name].enabled = enabled;
        writeJson(path.join(project, 'plugin-dev.host.json'), info.host);
    } else {
        writeJson(path.join(info.pluginPath, 'plugin-dev.json'), info.meta);
        writeJson(plan.nativeFile, plan.native);
    }
    const fingerprint = nativeFingerprint(info.pluginPath);
    const assetsChanged = enableChanged || plan.writes.length > 0 || plan.deletes.length > 0;
    state.plugins[info.meta.name] = {
        ...previous, enabled, template: info.meta.template, target: info.meta.target, sourcePath: info.pluginPath, detached: false,
        needsRebuild: previous.needsRebuild !== false || assetsChanged || info.adapterMissing || previous.nativeFingerprint !== fingerprint || previous.sourcePath !== info.pluginPath,
        assetsDirty: previous.assetsDirty !== false || assetsChanged,
        nativeFingerprint: fingerprint,
        lastSync: new Date().toISOString(), tracked: plan.nextTracked,
    };
    writeJson(path.join(project, '.plugin-dev', 'state.json'), state);
    return {
        name: info.meta.name, displayName: info.meta.displayName, enabled, template: info.meta.template,
        target: info.meta.target, pluginPath: info.pluginPath, sourcePath: info.sourcePath, extensionPath: info.extensionPath, sourceType: info.sourceType, runtimePath: info.runtimePath,
        needsRebuild: state.plugins[info.meta.name].needsRebuild,
        assetsDirty: state.plugins[info.meta.name].assetsDirty,
        copied: plan.writes.length, removed: plan.deletes.length,
        assetUrl: `db://assets/__plugin_dev/${info.meta.name}`,
    };
}
function syncPlugin({ projectPath, name }) {
    const project = projectRoot(projectPath);
    return withProjectLock(project, () => applySync(prepareSync(project, name)));
}
function setEnabled({ projectPath, name, enabled }) {
    const project = projectRoot(projectPath);
    return withProjectLock(project, () => applySync(prepareSync(project, name, enabled)));
}
module.exports = { OWNER, validateName, inside, noLinks, projectRoot, readJson, write, writeJson, hash, ensureLocalIgnore, withProjectLock, readState, readHost, sourceInfo, walk, pluginInfo, adapterFiles, prepareAdapter, applyAdapter, enabledRuntime, nativeFingerprint, prepareSync, applySync, syncPlugin, setEnabled };
