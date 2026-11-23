'use strict';

// Also shipped inside generated plugins: installed packages need no development tool.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const OWNER = 'cocos-plugin-dev';
const ANDROID_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const heldLocks = new Set();
const fileHashBuffer = Buffer.allocUnsafe(1024 * 1024);

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
        if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`不支持符号链接或目录联接: ${current}`);
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
function hashFile(file) {
    const descriptor = fs.openSync(file, 'r');
    try {
        const before = fs.fstatSync(descriptor);
        if (!before.isFile()) fail(`需要普通文件: ${file}`);
        const digest = crypto.createHash('sha256');
        for (;;) {
            const count = fs.readSync(descriptor, fileHashBuffer, 0, fileHashBuffer.length, null);
            if (!count) break;
            digest.update(fileHashBuffer.subarray(0, count));
        }
        const after = fs.fstatSync(descriptor);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            fail(`计算指纹期间文件发生修改: ${file}`);
        }
        return digest.digest('hex');
    } finally { fs.closeSync(descriptor); }
}
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
    try { fs.mkdirSync(recovery); } catch (error) { if (error.code === 'EEXIST' || (process.platform === 'win32' && error.code === 'EPERM')) return; throw error; }
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
    noLinks(root, root);
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
function normalizeRelTarget(value) {
    if (typeof value !== 'string' || !value.trim() || /[\r\n\x00-\x1f]/.test(value)) fail(`无效的运行时目标路径: ${value}`);
    const normalized = value.replace(/\\/g, '/');
    const parts = normalized.split('/');
    if (!normalized || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value)
        || parts.some(part => !part || part === '.' || part === '..' || /[:*?"<>|]/.test(part)
            || /[. ]$/.test(part) || /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i.test(part))) {
        fail(`无效的运行时目标路径: ${value}`);
    }
    return parts.join('/');
}
function validateRuntimeFilesSpec(pluginPath, runtimeFiles) {
    if (runtimeFiles === undefined) return [];
    if (!Array.isArray(runtimeFiles)) fail(`插件 runtimeFiles 必须是数组: ${pluginPath}`);
    return runtimeFiles.map(entry => {
        const { source, target, platform } = typeof entry === 'string' ? { source: entry } : entry || {};
        if (typeof source !== 'string' || !source.trim()) fail(`插件 runtimeFiles 条目缺少有效的 source: ${pluginPath}`);
        const parts = source.replace(/\\/g, '/').split('/');
        if (path.posix.isAbsolute(source) || path.win32.isAbsolute(source) || parts.includes('..')) fail(`路径越界: ${source} (${pluginPath})`);
        const relative = parts.filter(part => part && part !== '.').join('/');
        if (relative) normalizeRelTarget(relative);
        if (platform !== undefined && !['windows', 'android', 'all'].includes(platform)) {
            fail(`插件 runtimeFiles 条目的 platform 无效: ${platform} (${pluginPath})`);
        }
        const resolved = inside(pluginPath, path.join(pluginPath, relative));
        noLinks(pluginPath, resolved);
        return { relative, source: resolved, target: target == null ? null : normalizeRelTarget(target), platform };
    });
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
    validateRuntimeFilesSpec(source, meta.runtimeFiles);
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
    files.set('package.json', Buffer.from(`${JSON.stringify({ ...pkg, main: './editor/main.js', contributions: { ...pkg.contributions, builder: './editor/builder.js' } }, null, 2)}\n`));
    files.set('editor/main.js', fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8').replace(/\{\{NAME\}\}/g, info.meta.name));
    files.set('editor/plugin-support.cjs', fs.readFileSync(__filename));
    for (const file of ['builder.js', 'build-hooks.cjs', 'runtime-deployment.cjs', 'android-build.cjs', 'runtime-build.cmake', 'deploy-runtime.cjs', 'windows-build.cjs', 'windows-build.cmake', 'typescript-plugin.cjs']) {
        files.set(`editor/${file}`, fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\{\{NAME\}\}/g, info.meta.name));
    }
    files.set('native/cc_plugin.json', `${JSON.stringify({ ...native, disabled: !enabled }, null, 2)}\n`);
    const platforms = Array.isArray(native.platforms) && native.platforms.length ? native.platforms : ['windows'];
    for (const module of native.modules) {
        if (typeof module.target !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(module.target)) fail(`无效的原生模块 target: ${module.target}`);
        for (const [platform, label] of [['windows', 'Windows'], ['android', 'Android']]) {
            const config = path.join(info.pluginPath, 'native', platform, `${module.target}-config.cmake`);
            noLinks(info.pluginPath, config);
            if (!fs.existsSync(config)) {
                if (platforms.includes(platform)) fail(`缺少 ${label} 模块配置: ${config}`);
                continue;
            }
            const normalized = config.replace(/\\/g, '/');
            let delimiter = '=';
            while (normalized.includes(`]${delimiter}]`)) delimiter += '=';
            files.set(`native/${platform}/${module.target}-config.cmake`, `# Generated host reference; edit the independent plugin source.\ninclude([${delimiter}[${normalized}]${delimiter}])\n`);
        }
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
function runtimeFilter(rel, item) {
    if (item.isDirectory()) return !['build', 'out', 'cache', 'temp', '.vs', 'CMakeFiles'].includes(item.name);
    return !/\.(obj|pdb|ilk|log|tmp|bak)$/.test(item.name) && item.name !== '.DS_Store';
}
function cachedFileHash(source, fileHashes) {
    const key = path.resolve(source);
    if (!fileHashes.has(key)) fileHashes.set(key, hashFile(source));
    return fileHashes.get(key);
}
function verifyBinaryManifest(root, descriptor, platform, fileHashes) {
    const distribution = descriptor?.distribution;
    const isDistributedBinary = distribution?.type === 'binary' && (distribution.platform === platform
        || (Array.isArray(distribution.platforms) && distribution.platforms.includes(platform)));
    const manifestFile = path.join(root, 'native', platform, 'binary-manifest.json');
    noLinks(root, manifestFile);
    if (!fs.existsSync(manifestFile)) {
        if (isDistributedBinary) fail(`缺少二进制文件记录: ${manifestFile}`);
        return null;
    }
    const manifest = readJson(manifestFile);
    const files = manifest?.files;
    if (!files || typeof files !== 'object' || Array.isArray(files)) fail(`二进制文件记录无效: ${manifestFile}`);
    for (const [file, sha256] of Object.entries(files)) {
        if (normalizeRelTarget(file) !== file || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
            fail(`二进制文件记录无效: ${file}`);
        }
        const source = path.join(root, file);
        noLinks(root, source);
        const stat = fs.statSync(source, { throwIfNoEntry: false });
        if (!stat) fail(`二进制${/\.so$/i.test(file) ? '动态库' : '文件'}不存在: ${source}`);
        if (!stat.isFile()) fail(`需要普通文件: ${source}`);
        if (cachedFileHash(source, fileHashes) !== sha256) fail(`二进制文件 SHA-256 不匹配: ${source}`);
    }
    return manifest;
}
function runtimeEntries(fileHashes, conflictMessage) {
    const entries = new Map();
    return {
        add(relative, source, platform) {
            const target = normalizeRelTarget(relative);
            const key = target.toLowerCase();
            const sha256 = cachedFileHash(source, fileHashes);
            if (entries.has(key) && entries.get(key).sha256 !== sha256) fail(`${conflictMessage}: ${target}`);
            entries.set(key, { target, source, sha256, ...(platform === undefined ? {} : { platform }) });
        },
        list: () => [...entries.values()].sort((a, b) => a.target.localeCompare(b.target)),
    };
}
function isWindowsNativeSource(relative) {
    return /^native\/windows(?:\/|$)/i.test(relative);
}
function isLegacyWindowsBin(relative) {
    return /^native\/third_party\/bin(?:\/|$)/i.test(relative);
}
function collectPlatformRuntimeFiles(pluginPath, meta, fileHashes, platform, includePlatform = false) {
    const resolvedRoot = path.resolve(pluginPath);
    const descriptorFile = path.join(resolvedRoot, 'plugin-dev.json');
    noLinks(path.parse(resolvedRoot).root, descriptorFile);
    const descriptor = meta || (fs.existsSync(descriptorFile) ? readJson(descriptorFile) : {});
    verifyBinaryManifest(resolvedRoot, descriptor, platform, fileHashes);
    const declared = validateRuntimeFilesSpec(resolvedRoot, descriptor.runtimeFiles);
    const entries = runtimeEntries(fileHashes, '插件内部运行时文件目标冲突');
    const windowsBins = platform === 'windows' ? ['native/third_party/bin', 'native/windows/bin'] : [];
    const androidOnly = declared.filter(item => item.platform === 'android').map(item => item.relative.toLowerCase());
    for (const binRel of windowsBins) {
        const binDir = path.join(resolvedRoot, binRel);
        noLinks(resolvedRoot, binDir);
        const collect = (rel, entry) => {
            const file = `${binRel}/${rel}`.toLowerCase();
            return runtimeFilter(rel, entry) && !androidOnly.some(source => !source || file === source || file.startsWith(`${source}/`));
        };
        for (const rel of walk(binDir, collect)) entries.add(rel, path.join(binDir, rel), includePlatform ? 'windows' : undefined);
    }
    for (const item of declared) {
        if (item.platform && item.platform !== 'all' && item.platform !== platform) continue;
        const { relative, source, target } = item;
        if (platform === 'android' && isWindowsNativeSource(relative)) continue;
        const stat = fs.statSync(source, { throwIfNoEntry: false });
        if (!stat) fail(`插件声明的运行时文件不存在: ${source}`);
        const add = (target, file, relativeSource) => {
            const windowsSource = isWindowsNativeSource(relativeSource) || (platform === 'windows' && isLegacyWindowsBin(relativeSource));
            const runtimePlatform = windowsSource ? 'windows' : item.platform;
            entries.add(target, file, includePlatform ? runtimePlatform : undefined);
        };
        if (stat.isDirectory()) {
            if (platform === 'android' && isLegacyWindowsBin(relative)) continue;
            const collect = (rel, entry) => {
                const file = relative ? `${relative}/${rel}` : rel;
                return runtimeFilter(rel, entry) && !(platform === 'android' && (isWindowsNativeSource(file) || isLegacyWindowsBin(file)));
            };
            for (const rel of walk(source, collect)) {
                add(target ? `${target}/${rel}` : rel, path.join(source, rel), relative ? `${relative}/${rel}` : rel);
            }
        } else {
            if (!stat.isFile()) fail(`需要普通文件: ${source}`);
            add(target || path.basename(source), source, relative);
        }
    }
    return entries.list();
}
function collectRuntimeFiles(pluginPath, meta, fileHashes = new Map()) {
    return collectPlatformRuntimeFiles(pluginPath, meta, fileHashes, 'windows');
}
function collectAndroidRuntimeAssets(pluginPath, meta, fileHashes = new Map()) {
    return collectPlatformRuntimeFiles(pluginPath, meta, fileHashes, 'android');
}
function collectPackageRuntimeFiles(pluginPath, meta, platform) {
    return collectPlatformRuntimeFiles(pluginPath, meta, new Map(), platform, true);
}
function validateAndroidAbis(abis) {
    if (abis === undefined) return;
    if (!Array.isArray(abis)) fail('Android abis 必须是 ABI 名称数组。');
    for (const abi of abis) if (!ANDROID_ABIS.includes(abi)) fail(`不支持的 Android ABI: ${abi}`);
}
function androidBinaryLibs(root, descriptor, abis, buildType, fileHashes, entries) {
    const manifest = verifyBinaryManifest(root, descriptor, 'android', fileHashes);
    if (!manifest) return;
    const { files } = manifest;
    let requestedConfig = buildType?.toLowerCase();
    if (requestedConfig && (typeof manifest.buildType === 'string' || Array.isArray(manifest.buildTypes))) {
        const buildTypes = Array.isArray(manifest.buildTypes) ? manifest.buildTypes : [manifest.buildType];
        const supportedConfigs = buildTypes.map(config => typeof config === 'string' ? config.toLowerCase() : null);
        if (requestedConfig === 'relwithdebinfo' && !supportedConfigs.includes(requestedConfig) && supportedConfigs.includes('release')) {
            requestedConfig = 'release';
        }
        if (!supportedConfigs.includes(requestedConfig)) fail(`Android 二进制插件不支持构建配置: ${buildType}`);
    }
    const runtimeLibs = Object.hasOwn(manifest, 'runtimeLibs') ? manifest.runtimeLibs : Object.keys(files);
    if (!Array.isArray(runtimeLibs)) fail(`Android 二进制 runtimeLibs 必须是文件路径数组: ${path.join(root, 'native/android/binary-manifest.json')}`);
    const thirdPartyPrefix = 'native/third_party/android/';
    const layouts = new Map();
    const configs = new Map();
    for (const file of Object.keys(files)) {
        const lower = file.toLowerCase();
        const thirdParty = lower.startsWith(thirdPartyPrefix);
        if (!thirdParty && !lower.startsWith('native/android/')) continue;
        if (thirdParty) {
            const [abi, ...rest] = file.slice(thirdPartyPrefix.length).split('/');
            if (rest.length && /\.so$/i.test(file)) layouts.set(file, { abi, config: null });
            continue;
        }
        const [first, second, ...rest] = file.slice('native/android/'.length).split('/');
        const libsDirectory = first.toLowerCase() === 'libs';
        const abi = libsDirectory ? second : first;
        const config = !libsDirectory && rest.length && second.toLowerCase() !== 'lib' ? second.toLowerCase() : null;
        layouts.set(file, { abi, config });
        if (config && ANDROID_ABIS.includes(abi)) {
            if (!configs.has(abi)) configs.set(abi, new Set());
            configs.get(abi).add(config);
        }
    }
    for (const file of runtimeLibs) {
        if (typeof file !== 'string' || !Object.hasOwn(files, file)) fail(`Android 二进制文件记录缺少 SHA-256: ${file}`);
        if (!layouts.has(file) || !/\.so$/i.test(file)) continue;
        const { abi, config } = layouts.get(file);
        if (!ANDROID_ABIS.includes(abi)) fail(`Android 二进制动态库的 ABI 无效: ${file}`);
        const source = path.join(root, file);
        const selectedConfig = requestedConfig === 'relwithdebinfo' && !configs.get(abi)?.has(requestedConfig)
            ? 'release' : requestedConfig;
        if (abis.includes(abi) && (!config || !selectedConfig || config === selectedConfig)) {
            const target = file.toLowerCase().startsWith(thirdPartyPrefix)
                ? file.slice(thirdPartyPrefix.length) : `${abi}/${path.basename(file)}`;
            entries.add(target, source);
        }
    }
}
function collectAndroidNativeLibs(pluginPath, meta, options = {}, fileHashes = new Map()) {
    const { abis, buildType } = options;
    validateAndroidAbis(abis);
    if (buildType !== undefined && (typeof buildType !== 'string' || !buildType.trim())) fail(`Android 构建配置无效: ${buildType}`);
    const selected = abis?.length ? abis : ANDROID_ABIS;
    const root = path.resolve(pluginPath);
    noLinks(path.parse(root).root, root);
    const descriptorFile = path.join(root, 'plugin-dev.json');
    noLinks(root, descriptorFile);
    const descriptor = meta || (fs.existsSync(descriptorFile) ? readJson(descriptorFile) : {});
    const entries = runtimeEntries(fileHashes, '插件内部 Android 动态库目标冲突');
    for (const relative of ['native/android/libs', 'native/third_party/android']) {
        const directory = path.join(root, relative);
        noLinks(root, directory);
        for (const file of walk(directory, (rel, item) => /\.(jar|aar)$/i.test(rel) && !item.isDirectory())) {
            entries.add(file, path.join(directory, file));
        }
        for (const abi of new Set(selected)) {
            const abiDirectory = path.join(directory, abi);
            noLinks(root, abiDirectory);
            for (const file of walk(abiDirectory, (rel, item) => item.isDirectory() || item.isSymbolicLink() || /\.so$/i.test(rel))) {
                entries.add(`${abi}/${file}`, path.join(abiDirectory, file));
            }
        }
    }
    androidBinaryLibs(root, descriptor, selected, buildType, fileHashes, entries);
    return entries.list();
}
function nativeFingerprint(pluginPath, meta) {
    const root = path.join(pluginPath, 'native');
    const excluded = new Set(['build', 'out', 'cache', 'temp', '.vs', 'CMakeFiles']);
    const files = walk(root, (rel, item) => item.isDirectory() ? !excluded.has(item.name)
        : !/\.(obj|pdb|ilk|log|tmp)$/.test(item.name) && item.name !== 'CMakeCache.txt' && item.name !== 'compile_commands.json');
    const fileHashes = new Map();
    const runtimeItems = collectRuntimeFiles(pluginPath, meta, fileHashes);
    const entries = files.map(rel => {
        const source = path.resolve(root, rel);
        if (!fileHashes.has(source)) fileHashes.set(source, hashFile(source));
        return `${rel}:${fileHashes.get(source)}`;
    });
    const descriptor = meta || (fs.existsSync(path.join(pluginPath, 'plugin-dev.json')) ? readJson(path.join(pluginPath, 'plugin-dev.json')) : {});
    if (Array.isArray(descriptor.runtimeFiles) && descriptor.runtimeFiles.length) {
        for (const item of runtimeItems) entries.push(`runtime:${item.target}:${item.sha256}`);
        for (const item of collectAndroidRuntimeAssets(pluginPath, descriptor, fileHashes)) {
            entries.push(`android-runtime:${item.target}:${item.sha256}`);
        }
    }
    return hash(entries.join('\n'));
}
const FALLBACK_CC_DECLARATIONS = [
    '// 由 cocos-plugin-dev 生成；Creator 生成声明后使用宿主类型。',
    "declare module 'cc' {",
    '    export class Component {',
    '        node: unknown;',
    '        protected onLoad?(): void;',
    '        protected start?(): void;',
    '        protected update?(dt: number): void;',
    '        protected lateUpdate?(dt: number): void;',
    '        protected onEnable?(): void;',
    '        protected onDisable?(): void;',
    '        protected onDestroy?(): void;',
    '    }',
    '    export const _decorator: {',
    '        ccclass: (name?: string) => ClassDecorator;',
    '        property: (options?: unknown) => PropertyDecorator;',
    '        executeInEditMode: ClassDecorator;',
    '        menu: (path: string) => ClassDecorator;',
    '    };',
    '    export function log(...data: unknown[]): void;',
    '    export function warn(...data: unknown[]): void;',
    '    export function error(...data: unknown[]): void;',
    '}',
    '',
].join('\n');
function discoverHostEngine(project, explicitEnginePath) {
    if (explicitEnginePath) return explicitEnginePath;
    if (!project) return null;
    for (const rel of ['.plugin-dev/windows.json', '.plugin-dev/android.json', '.plugin-dev/ui-settings.json']) {
        const file = path.join(project, rel);
        if (!fs.existsSync(file)) continue;
        noLinks(project, file);
        const data = readJson(file);
        if (typeof data.enginePath === 'string' && data.enginePath.trim()) return data.enginePath.trim();
    }
    return null;
}
function syncTypeDeclarations(project, pluginPath, explicitEnginePath) {
    const resolvedPlugin = path.resolve(pluginPath);
    noLinks(path.parse(resolvedPlugin).root, resolvedPlugin);
    const localDir = path.join(resolvedPlugin, '.local');
    const defaultFile = path.join(localDir, 'cc-default.d.ts');
    const ignoreFile = path.join(localDir, '.gitignore');
    noLinks(resolvedPlugin, ignoreFile);
    const ignore = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : '';
    if (ignore !== '*\n' && !ignore.endsWith('\n*\n')) write(ignoreFile, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}*\n`);
    noLinks(resolvedPlugin, defaultFile);
    write(defaultFile, FALLBACK_CC_DECLARATIONS.split('\n').filter(line => line !== "declare module 'cc' {" && line !== '}').join('\n'));
    const configFile = path.join(resolvedPlugin, 'tsconfig.json');
    noLinks(resolvedPlugin, configFile);
    const config = readJson(configFile);
    config.include = (config.include || ['runtime/**/*.ts']).filter(entry => entry !== '.local/**/*.d.ts');
    if (config.files) config.files = config.files.filter(entry => !['.local/cc-host.d.ts', './.local/cc-host.d.ts'].includes(entry));
    config.compilerOptions ||= {};
    config.compilerOptions.paths ||= {};
    config.compilerOptions.paths.cc ||= ['./.local/cc-default.d.ts'];
    config.compilerOptions.plugins ||= [];
    if (!config.compilerOptions.plugins.some(plugin => plugin.name === 'cocos-plugin-dev-types')) config.compilerOptions.plugins.push({ name: 'cocos-plugin-dev-types' });
    writeJson(configFile, config);
    const legacyFile = path.join(localDir, 'cc-host.d.ts');
    noLinks(resolvedPlugin, legacyFile);
    if (fs.existsSync(legacyFile)) {
        const legacy = fs.readFileSync(legacyFile, 'utf8');
        if (legacy.startsWith('// Generated by cocos-plugin-dev.') || legacy === FALLBACK_CC_DECLARATIONS) fs.unlinkSync(legacyFile);
        else fail(`已有类型文件包含手工修改，请将声明移入 runtime 后继续: ${legacyFile}`);
    }
    if (!project && !explicitEnginePath) return { targetFile: defaultFile, configFile, declarationCount: 0, mode: 'fallback' };
    const resolvedProject = project ? path.resolve(project) : undefined;
    if (resolvedProject) ensureLocalIgnore(resolvedProject);
    const typesRoot = resolvedProject ? path.join(resolvedProject, '.plugin-dev', 'typescript') : path.join(localDir, 'typescript');
    const typeDirectory = path.join(typesRoot, 'projects', hash(resolvedPlugin.toLowerCase()).slice(0, 16));
    const targetFile = path.join(typeDirectory, 'cc-host.d.ts');
    noLinks(path.parse(typesRoot).root, targetFile);
    const dtsFiles = [];
    const seenNames = new Set();
    const engine = discoverHostEngine(project, explicitEnginePath);
    if (engine) {
        const resolvedEngine = path.resolve(engine);
        const engineRoot = path.basename(resolvedEngine).toLowerCase() === 'native' ? path.dirname(resolvedEngine) : resolvedEngine;
        const engineDecl = path.join(engineRoot, 'bin', '.declarations');
        if (fs.existsSync(engineDecl)) {
            noLinks(path.parse(engineDecl).root, engineDecl);
            for (const rel of walk(engineDecl, (r, item) => item.isDirectory() || r.endsWith('.d.ts'))) {
                const base = path.basename(rel).toLowerCase();
                if (!seenNames.has(base)) {
                    dtsFiles.push(path.join(engineDecl, rel));
                    seenNames.add(base);
                }
            }
        }
    }
    if (project) {
        const tempDecl = path.join(resolvedProject, 'temp', 'declarations');
        if (fs.existsSync(tempDecl)) {
            noLinks(resolvedProject, tempDecl);
            for (const rel of walk(tempDecl, (r, item) => item.isDirectory() || r.endsWith('.d.ts'))) {
                const base = path.basename(rel).toLowerCase();
                if (!seenNames.has(base)) {
                    dtsFiles.push(path.join(tempDecl, rel));
                    seenNames.add(base);
                }
            }
        }
    }
    if (dtsFiles.length) {
        const lines = ['// 由 cocos-plugin-dev 生成；本文件属于当前宿主的 TypeScript 项目。'];
        for (const dts of dtsFiles) {
            const rel = path.relative(typeDirectory, dts);
            const ref = (path.isAbsolute(rel) ? dts : rel).replace(/\\/g, '/');
            if (/["<>\r\n]/.test(ref)) fail(`类型声明路径含有不支持的字符: ${dts}`);
            lines.push(`/// <reference path="${ref}" />`);
        }
        write(targetFile, `${lines.join('\n')}\n`);
    } else write(targetFile, FALLBACK_CC_DECLARATIONS);
    const hostConfig = path.join(typeDirectory, 'tsconfig.json');
    noLinks(path.parse(typesRoot).root, hostConfig);
    writeJson(hostConfig, {
        extends: configFile.replace(/\\/g, '/'),
        files: [targetFile.replace(/\\/g, '/')],
        include: [path.join(resolvedPlugin, 'runtime', '**', '*.ts').replace(/\\/g, '/')],
        exclude: [],
    });
    const moduleDirectory = path.join(typesRoot, 'node_modules', 'cocos-plugin-dev-types');
    const manifestFile = path.join(moduleDirectory, 'projects.json');
    noLinks(path.parse(typesRoot).root, manifestFile);
    const manifest = fs.existsSync(manifestFile) ? readJson(manifestFile) : {};
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail(`TypeScript 宿主项目记录无效: ${manifestFile}`);
    manifest[configFile.replace(/\\/g, '/').toLowerCase()] = targetFile.replace(/\\/g, '/');
    writeJson(manifestFile, manifest);
    const packageFile = path.join(moduleDirectory, 'package.json');
    const moduleFile = path.join(moduleDirectory, 'index.cjs');
    noLinks(path.parse(typesRoot).root, packageFile);
    noLinks(path.parse(typesRoot).root, moduleFile);
    writeJson(packageFile, { name: 'cocos-plugin-dev-types', version: '1.0.0', main: 'index.cjs' });
    write(moduleFile, fs.readFileSync(path.join(__dirname, 'typescript-plugin.cjs')));
    return { targetFile, configFile: hostConfig, pluginProbeLocation: typesRoot, declarationCount: dtsFiles.length, mode: dtsFiles.length ? 'referenced' : 'fallback' };
}
function enabledRuntime(enabled) {
    return Buffer.from(`// Generated by cocos-plugin-dev. Edit runtime/ sources, not this directory.\nexport const PLUGIN_ENABLED = ${enabled};\n`);
}
function prepareTypeScriptSdk(projectPath, packageRoot) {
    const project = projectRoot(projectPath);
    const source = path.resolve(packageRoot);
    noLinks(path.parse(source).root, source);
    const packageInfo = readJson(path.join(source, 'package.json'));
    if (packageInfo.name !== 'typescript' || typeof packageInfo.version !== 'string'
        || !fs.existsSync(path.join(source, 'lib', 'tsserver.js'))) fail(`需要完整的官方 TypeScript npm 包: ${source}`);
    ensureLocalIgnore(project);
    const typesRoot = path.join(project, '.plugin-dev', 'typescript');
    const destination = path.join(typesRoot, 'node_modules', 'typescript');
    const recordFile = path.join(typesRoot, 'sdk-files.json');
    noLinks(project, recordFile);
    noLinks(project, destination);
    const previous = fs.existsSync(recordFile) ? readJson(recordFile) : { schemaVersion: 1, files: {} };
    if (previous.schemaVersion !== 1 || !previous.files || typeof previous.files !== 'object') fail(`TypeScript SDK 文件记录无效: ${recordFile}`);
    const desired = new Map(walk(source).map(rel => [rel, fs.readFileSync(path.join(source, rel))]));
    const files = Object.fromEntries([...desired].map(([rel, data]) => [rel, hash(data)]));
    for (const rel of new Set([...Object.keys(previous.files), ...desired.keys()])) {
        const file = inside(destination, path.join(destination, rel));
        noLinks(project, file);
        if (fs.existsSync(file)) {
            const actual = hash(fs.readFileSync(file));
            if (actual !== previous.files[rel] && actual !== files[rel]) fail(`TypeScript SDK 文件包含手工修改: ${file}`);
        }
    }
    for (const [rel, data] of desired) write(path.join(destination, rel), data);
    for (const rel of Object.keys(previous.files)) {
        const file = path.join(destination, rel);
        if (!desired.has(rel) && fs.existsSync(file)) fs.unlinkSync(file);
    }
    writeJson(recordFile, { schemaVersion: 1, version: packageInfo.version, files });
    return { packageRoot: destination, sdkPath: path.join(destination, 'lib'), version: packageInfo.version };
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
    nativeFingerprint(info.pluginPath, info.meta);
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
    syncTypeDeclarations(project, info.pluginPath);
    const fingerprint = nativeFingerprint(info.pluginPath, info.meta);
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
module.exports = { OWNER, validateName, normalizeRelTarget, inside, noLinks, projectRoot, readJson, write, writeJson, hash, hashFile, ensureLocalIgnore, withProjectLock, readState, readHost, sourceInfo, walk, pluginInfo, adapterFiles, prepareAdapter, applyAdapter, enabledRuntime, collectRuntimeFiles, collectAndroidRuntimeAssets, collectAndroidNativeLibs, collectPackageRuntimeFiles, validateAndroidAbis, syncTypeDeclarations, prepareTypeScriptSdk, nativeFingerprint, prepareSync, applySync, syncPlugin, setEnabled };
