'use strict';

const fs = require('node:fs');
const path = require('node:path');
const support = require('./plugin-support.cjs');
const { directoryKey, objectRecord, noLinks, targetPath, fileHash, enabledPlugins, applyDeployment } = require('./runtime-deployment.cjs')._internal;

function requireDirectory(directory, label) {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error(`需要 ${label} 路径。`);
    const absolute = path.resolve(directory);
    noLinks(absolute);
    if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${label}不存在或不是目录: ${absolute}`);
    return absolute;
}
function resolveNativeAndroidDirectory(directory) {
    const native = requireDirectory(directory, 'Android 原生项目目录');
    const cmake = path.join(native, 'CMakeLists.txt');
    noLinks(cmake);
    if (!fs.statSync(cmake, { throwIfNoEntry: false })?.isFile()) throw new Error(`Android 原生项目缺少 CMakeLists.txt: ${cmake}`);
    return native;
}

function readManifest(project, manifestFile, manifestHash) {
    if (manifestHash === null) return { schemaVersion: 1, managedBy: support.OWNER, projectPath: project, outputs: {} };
    const record = support.readJson(manifestFile);
    if (!objectRecord(record) || record.schemaVersion !== 1 || record.managedBy !== support.OWNER || !objectRecord(record.outputs)
        || typeof record.projectPath !== 'string' || !path.isAbsolute(record.projectPath)
        || directoryKey(record.projectPath) !== directoryKey(project)) {
        throw new Error(`Android 运行时部署记录无效: ${manifestFile}`);
    }
    for (const [key, output] of Object.entries(record.outputs)) {
        if (!objectRecord(output) || typeof output.directory !== 'string' || !path.isAbsolute(output.directory)
            || directoryKey(output.directory) !== key || !['libs', 'assets'].includes(output.kind) || !objectRecord(output.files)) {
            throw new Error(`Android 运行时输出目录记录无效: ${key}`);
        }
        noLinks(output.directory);
        if (output.createdDirectories !== undefined && (output.kind !== 'libs' || !Array.isArray(output.createdDirectories)
            || output.createdDirectories.some(relative => support.normalizeRelTarget(relative) !== relative))) {
            throw new Error(`Android 运行时创建目录记录无效: ${key}`);
        }
        for (const [fileKey, item] of Object.entries(output.files)) {
            if (!objectRecord(item) || typeof item.target !== 'string' || fileKey !== item.target.toLowerCase()
                || support.normalizeRelTarget(item.target) !== item.target || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
                || typeof item.managed !== 'boolean' || !Array.isArray(item.owners) || !item.owners.length) {
                throw new Error(`Android 运行时文件记录无效: ${fileKey}`);
            }
            for (const owner of item.owners) support.validateName(owner);
        }
    }
    return record;
}

function collectDesired(plugins, options, includeAssets, fileHashes) {
    const desired = { libs: new Map(), assets: new Map() };
    const add = (kind, items, owner) => {
        for (const item of items) {
            const key = item.target.toLowerCase();
            const previous = desired[kind].get(key);
            if (previous && previous.sha256 !== item.sha256) {
                throw new Error(`插件 Android 运行时文件冲突: ${item.target} (${[...previous.owners, owner].join(', ')})`);
            }
            if (previous) previous.owners.push(owner);
            else desired[kind].set(key, { ...item, owners: [owner] });
        }
    };
    for (const { pluginPath, meta } of plugins) {
        add('libs', support.collectAndroidNativeLibs(pluginPath, meta, options, fileHashes), meta.name);
        if (includeAssets) add('assets', support.collectAndroidRuntimeAssets(pluginPath, meta, fileHashes), meta.name);
    }
    return desired;
}

function checkDestinations(outputs, current, desired, manifestFile) {
    const manifestKey = directoryKey(manifestFile);
    const destinations = new Map([[manifestKey, null]]);
    const claim = (key, directory, target) => {
        const dest = path.join(directory, target);
        const absolute = directoryKey(dest);
        if (destinations.has(absolute) && destinations.get(absolute) !== key) {
            if (absolute === manifestKey) throw new Error(`运行时文件不能覆盖部署记录: ${dest}`);
            throw new Error(`运行时输出目录的文件路径重叠: ${dest}`);
        }
        destinations.set(absolute, key);
    };
    for (const [key, output] of Object.entries(outputs)) {
        for (const { target } of Object.values(output.files)) claim(key, output.directory, target);
        if (current[output.kind] === key) {
            for (const { target } of desired[output.kind].values()) claim(key, output.directory, target);
        }
    }
    function checkParents(candidate) {
        let parent = path.posix.dirname(candidate);
        while (parent !== candidate) {
            if (destinations.has(parent)) throw new Error(`运行时文件与目录冲突: ${parent} (${candidate})`);
            candidate = parent;
            parent = path.posix.dirname(candidate);
        }
    }
    for (const file of destinations.keys()) checkParents(file);
    for (const directory of Object.keys(outputs)) {
        if (destinations.has(directory)) throw new Error(`运行时文件与输出目录冲突: ${directory}`);
        checkParents(directory);
    }
}

function planOutput(output, active, desired, operations) {
    const { writes, deletes, checked } = operations;
    const { directory, kind } = output;
    const createdDirectories = new Set(output.createdDirectories);
    const files = Object.create(null);
    const keys = active ? new Set([...desired.keys(), ...Object.keys(output.files)]) : Object.keys(output.files);
    for (const key of keys) {
        const previous = Object.hasOwn(output.files, key) ? output.files[key] : undefined;
        const item = desired.get(key);
        const target = previous?.target || item.target;
        const dest = targetPath(directory, target);
        const actual = fileHash(dest);
        checked.set(dest, actual);
        if (previous?.managed && actual !== previous.sha256) throw new Error(`受管运行时文件包含手工修改: ${dest}`);
        if (active && item) {
            const managed = actual === null || !!previous?.managed;
            if (!managed && actual !== item.sha256) throw new Error(`拒绝覆盖宿主已有文件: ${dest}`);
            if (actual !== item.sha256) {
                writes.push({ dest, source: item.source, sha256: item.sha256, previousHash: actual, kind });
                if (kind === 'libs') {
                    for (let parent = path.dirname(dest); parent !== directory; parent = path.dirname(parent)) {
                        if (!fs.existsSync(parent)) createdDirectories.add(path.relative(directory, parent).replace(/\\/g, '/'));
                    }
                }
            }
            files[key] = { target, sha256: item.sha256, owners: item.owners, managed };
            continue;
        }
        const owners = previous.owners.filter(owner => item?.owners.includes(owner));
        if (owners.length && actual !== null) files[key] = { ...previous, owners };
        else if (previous.managed) deletes.push({ dest, sha256: actual, kind });
    }
    return { ...output, files, ...(createdDirectories.size ? { createdDirectories: [...createdDirectories] } : {}) };
}

function planDirectoryCleanup(outputs, writes, deletes) {
    const filesystemKey = process.platform === 'win32' ? directoryKey : path.resolve;
    const retainedDirectories = new Set(Object.values(outputs).map(({ directory }) => filesystemKey(directory)));
    for (const { dest } of writes) {
        let directory = path.dirname(dest);
        while (true) {
            retainedDirectories.add(filesystemKey(directory));
            const parent = path.dirname(directory);
            if (parent === directory) break;
            directory = parent;
        }
    }
    const removedPaths = new Set(deletes.map(({ dest }) => filesystemKey(dest)));
    const emptyDirectories = new Map();
    const candidates = Object.values(outputs).flatMap(output => (output.createdDirectories || []).map(relative => ({
        directory: targetPath(output.directory, relative),
        output,
        relative,
    })));
    // 先检查子目录，再根据文件和子目录的删除计划判断父目录是否为空。
    candidates.sort((a, b) => b.directory.length - a.directory.length);
    for (const { directory, output, relative } of candidates) {
        const key = filesystemKey(directory);
        if (retainedDirectories.has(key)) continue;
        if (fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
            if (fs.readdirSync(directory).some(name => !removedPaths.has(filesystemKey(path.join(directory, name))))) continue;
            emptyDirectories.set(key, directory);
            removedPaths.add(key);
        }
        output.createdDirectories = output.createdDirectories.filter(item => item !== relative);
        if (!output.createdDirectories.length) delete output.createdDirectories;
    }
    return emptyDirectories.values();
}

function deployUnlocked(project, { nativeAndroidDir, assetsDataDir, abis, buildType }) {
    support.validateAndroidAbis(abis);
    const native = resolveNativeAndroidDirectory(nativeAndroidDir);
    const libs = path.join(native, 'libs');
    noLinks(libs);
    if (fs.existsSync(libs)) requireDirectory(libs, 'Android 库目录');
    const assets = assetsDataDir === undefined ? null : requireDirectory(assetsDataDir, 'Android 构建资源 data 目录');
    const manifestPath = path.join(project, '.plugin-dev', 'android-runtime-binaries.json');
    noLinks(manifestPath);
    const manifestHash = fileHash(manifestPath);
    const manifest = readManifest(project, manifestPath, manifestHash);
    const current = {};
    for (const [kind, directory] of Object.entries({ libs, assets })) {
        if (!directory) continue;
        const key = directoryKey(directory);
        const existing = manifest.outputs[key];
        if (existing && existing.kind !== kind) throw new Error(`Android 运行时输出目录重叠: ${directory}`);
        current[kind] = key;
        if (!existing) manifest.outputs[key] = { directory, kind, files: {} };
    }
    const sourceHashes = new Map();
    const desired = collectDesired(enabledPlugins(project), { abis, buildType },
        Object.values(manifest.outputs).some(output => output.kind === 'assets'), sourceHashes);
    checkDestinations(manifest.outputs, current, desired, manifestPath);

    const operations = { writes: [], deletes: [], checked: new Map([[manifestPath, manifestHash]]) };
    for (const [key, output] of Object.entries(manifest.outputs)) {
        manifest.outputs[key] = planOutput(output, current[output.kind] === key, desired[output.kind], operations);
    }
    const { writes, deletes, checked } = operations;
    const emptyDirectories = planDirectoryCleanup(manifest.outputs, writes, deletes);
    applyDeployment(writes, deletes, manifestPath, manifest, {
        verify() {
            for (const [source, sha256] of sourceHashes) {
                noLinks(source);
                if (fileHash(source) !== sha256) throw new Error(`准备部署期间运行时来源文件发生修改: ${source}`);
            }
            for (const [dest, sha256] of checked) {
                noLinks(dest);
                if (fileHash(dest) !== sha256) throw new Error(`准备部署期间目标文件发生修改: ${dest}`);
            }
        },
        cleanup() {
            for (const directory of emptyDirectories) {
                noLinks(directory);
                fs.rmdirSync(directory);
            }
        },
    });

    const result = (kind, directory) => ({
        deployed: writes.filter(item => item.kind === kind).length,
        removed: deletes.filter(item => item.kind === kind).length,
        files: Object.values(manifest.outputs[current[kind]]?.files || {}).map(item => item.target),
        directory,
    });
    return { libs: result('libs', libs), assets: result('assets', assets), manifestPath };
}

function deployAndroidBuildFiles(projectPath, options) {
    const project = support.projectRoot(projectPath);
    noLinks(project);
    return support.withProjectLock(project, () => deployUnlocked(project, options));
}

module.exports = { deployAndroidBuildFiles, _internal: { requireDirectory, resolveNativeAndroidDirectory } };
