'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const support = require('./plugin-support.cjs');

function directoryKey(directory) {
    return path.resolve(directory).replace(/\\/g, '/').toLowerCase();
}
function objectRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function noLinks(candidate) {
    let current = path.resolve(candidate);
    for (;;) {
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (stat?.isSymbolicLink()) throw new Error(`不支持符号链接或目录联接: ${current}`);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
}
function targetPath(directory, target) {
    if (typeof target !== 'string' || !target || path.posix.isAbsolute(target) || path.win32.isAbsolute(target)
        || /[\\\x00-\x1f:*?"<>|]/.test(target)
        || target.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
            || /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) {
        throw new Error(`运行时目标路径无效: ${target}`);
    }
    const result = support.inside(directory, path.join(directory, target));
    noLinks(result);
    return result;
}
function fileHash(file) {
    if (!fs.existsSync(file)) return null;
    if (!fs.statSync(file).isFile()) throw new Error(`运行时目标必须是文件: ${file}`);
    return support.hashFile(file);
}
function enabledPlugins(project) {
    const host = support.readHost(project);
    const extensions = path.join(project, 'extensions');
    support.noLinks(project, extensions);
    const names = new Set(Object.keys(host.plugins));
    if (fs.existsSync(extensions)) for (const item of fs.readdirSync(extensions, { withFileTypes: true })) {
        const extension = path.join(extensions, item.name);
        const descriptor = path.join(extension, 'plugin-dev.json');
        const marker = path.join(extension, '.plugin-dev-adapter.json');
        if (!fs.existsSync(descriptor) && !fs.existsSync(marker)) continue;
        support.noLinks(project, extension);
        if (fs.existsSync(marker) && !names.has(item.name)) throw new Error(`宿主适配目录缺少插件引用: ${extension}`);
        if (fs.existsSync(descriptor)) names.add(item.name);
    }
    const result = [];
    for (const name of [...names].sort()) {
        if (host.plugins[name] && !host.plugins[name].enabled) continue;
        const info = support.pluginInfo(project, name);
        if (info.meta.enabled) result.push(info);
    }
    return result;
}
function readManifest(project, manifestFile) {
    const empty = { schemaVersion: 2, managedBy: support.OWNER, projectPath: project, outputs: {} };
    if (!fs.existsSync(manifestFile)) return empty;
    const record = support.readJson(manifestFile);
    if (record.schemaVersion === 1 && objectRecord(record.files)) {
        // 缺少创建归属和输出目录的记录只保存备查，不产生文件删除权限。
        return { ...empty, legacyUnowned: record };
    }
    if (record.schemaVersion !== 2 || record.managedBy !== support.OWNER || !objectRecord(record.outputs)
        || typeof record.projectPath !== 'string' || directoryKey(record.projectPath) !== directoryKey(project)) {
        throw new Error(`运行时部署记录无效: ${manifestFile}`);
    }
    for (const [key, output] of Object.entries(record.outputs)) {
        if (!objectRecord(output) || typeof output.directory !== 'string' || !path.isAbsolute(output.directory)
            || directoryKey(output.directory) !== key || !objectRecord(output.files)
            || !Array.isArray(output.executables) || output.executables.some(name => typeof name !== 'string'
                || name !== path.basename(name) || /[\\/]/.test(name))) {
            throw new Error(`运行时输出目录记录无效: ${manifestFile}`);
        }
        noLinks(output.directory);
        for (const [fileKey, item] of Object.entries(output.files)) {
            if (!objectRecord(item) || typeof item.target !== 'string' || fileKey !== item.target.toLowerCase()
                || !/^[a-f0-9]{64}$/.test(item.sha256) || typeof item.managed !== 'boolean'
                || !Array.isArray(item.owners) || !item.owners.length) throw new Error(`运行时文件记录无效: ${fileKey}`);
            for (const owner of item.owners) support.validateName(owner);
            targetPath(output.directory, item.target);
            if (output.executables.some(name => name.toLowerCase() === fileKey)) throw new Error(`运行时记录包含宿主可执行文件: ${item.target}`);
        }
    }
    return record;
}
function collectDesired(project, directory, executableNames, manifestFile) {
    const desired = new Map();
    for (const plugin of enabledPlugins(project)) for (const item of support.collectRuntimeFiles(plugin.pluginPath, plugin.meta)) {
        const key = item.target.toLowerCase();
        const dest = targetPath(directory, item.target);
        if (executableNames.some(name => name.toLowerCase() === key)) throw new Error(`插件运行时文件不能覆盖宿主可执行文件: ${item.target}`);
        if (directoryKey(dest) === directoryKey(manifestFile)) throw new Error(`插件运行时文件不能覆盖部署记录: ${item.target}`);
        const previous = desired.get(key);
        if (previous && previous.sha256 !== item.sha256) throw new Error(`插件运行时文件冲突: ${item.target} (${previous.owners.join(', ')}, ${plugin.meta.name})`);
        if (previous) previous.owners.push(plugin.meta.name);
        else desired.set(key, { ...item, owners: [plugin.meta.name] });
    }
    for (const key of desired.keys()) {
        const parts = key.split('/');
        for (let count = 1; count < parts.length; count++) {
            if (desired.has(parts.slice(0, count).join('/'))) throw new Error(`插件运行时文件与目录冲突: ${key}`);
        }
    }
    return desired;
}
function deployUnlocked(project, executablePath) {
    const executable = path.resolve(executablePath);
    noLinks(executable);
    if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) throw new Error(`宿主可执行文件不存在: ${executable}`);
    const directory = path.dirname(executable);
    const key = directoryKey(directory);
    const manifestFile = path.join(project, '.plugin-dev', 'runtime-binaries.json');
    noLinks(manifestFile);
    const manifest = readManifest(project, manifestFile);
    const current = manifest.outputs[key] || { directory, executables: [], files: {} };
    const executableName = path.basename(executable);
    if (Object.hasOwn(current.files, executableName.toLowerCase())) throw new Error(`运行时记录包含宿主可执行文件: ${executable}`);
    if (!current.executables.some(name => name.toLowerCase() === executableName.toLowerCase())) current.executables.push(executableName);
    const desired = collectDesired(project, directory, current.executables, manifestFile);
    const writes = [], deletes = [];
    const nextFiles = Object.create(null);
    const destinations = new Map();
    const claimDestination = (outputKey, outputDirectory, target) => {
        const absolute = targetPath(outputDirectory, target);
        const absoluteKey = directoryKey(absolute);
        if (destinations.has(absoluteKey) && destinations.get(absoluteKey) !== outputKey) throw new Error(`运行时输出目录的文件路径重叠: ${absolute}`);
        if (absoluteKey === directoryKey(manifestFile)) throw new Error(`运行时文件不能覆盖部署记录: ${absolute}`);
        destinations.set(absoluteKey, outputKey);
    };
    for (const item of desired.values()) claimDestination(key, directory, item.target);
    for (const [outputKey, output] of Object.entries(manifest.outputs)) {
        for (const item of Object.values(output.files)) claimDestination(outputKey, output.directory, item.target);
    }
    for (const [fileKey, item] of desired) {
        const previous = current.files[fileKey];
        const target = previous ? previous.target : item.target;
        const dest = targetPath(directory, target);
        const actual = fileHash(dest);
        const managed = actual === null || !!previous?.managed;
        if (actual !== null && previous?.managed && actual !== previous.sha256) {
            throw new Error(`受管运行时文件包含手工修改: ${dest}`);
        }
        if (actual !== null && !managed && actual !== item.sha256) throw new Error(`拒绝覆盖宿主已有文件: ${dest}`);
        if (actual !== item.sha256) writes.push({ dest, source: item.source, sha256: item.sha256, previousHash: actual });
        nextFiles[fileKey] = { target, sha256: item.sha256, owners: [...new Set(item.owners)].sort(), managed };
    }
    for (const [outputKey, output] of Object.entries({ ...manifest.outputs, [key]: current })) {
        const retained = outputKey === key ? nextFiles : Object.create(null);
        for (const [fileKey, previous] of Object.entries(output.files)) {
            if (outputKey === key && desired.has(fileKey)) continue;
            const item = desired.get(fileKey);
            const owners = item ? previous.owners.filter(owner => item.owners.includes(owner)) : [];
            const dest = targetPath(output.directory, previous.target);
            const actual = fileHash(dest);
            if (previous.managed && actual !== null && actual !== previous.sha256) throw new Error(`受管运行时文件包含手工修改: ${dest}`);
            if (outputKey !== key && owners.length && actual !== null) {
                retained[fileKey] = { ...previous, owners };
            } else if (previous.managed && actual !== null) deletes.push({ dest, sha256: actual });
        }
        manifest.outputs[outputKey] = { ...output, files: retained };
    }
    const staged = [];
    try {
        for (const operation of writes) {
            noLinks(operation.source);
            noLinks(operation.dest);
            fs.mkdirSync(path.dirname(operation.dest), { recursive: true });
            const temporary = path.join(path.dirname(operation.dest), `.cpd-${crypto.randomUUID()}.tmp`);
            fs.copyFileSync(operation.source, temporary, fs.constants.COPYFILE_EXCL);
            staged.push({ ...operation, temporary });
            if (support.hashFile(temporary) !== operation.sha256) throw new Error(`准备部署期间运行时来源文件发生修改: ${operation.source}`);
        }
        // 全部复制内容与目标归属验证通过后，才修改受管文件。
        for (const operation of staged) {
            noLinks(operation.dest);
            if (fileHash(operation.dest) !== operation.previousHash) throw new Error(`准备部署期间目标文件发生修改: ${operation.dest}`);
        }
        for (const operation of deletes) {
            noLinks(operation.dest);
            if (fileHash(operation.dest) !== operation.sha256) throw new Error(`准备部署期间目标文件发生修改: ${operation.dest}`);
        }
        for (const operation of staged) fs.renameSync(operation.temporary, operation.dest);
        for (const operation of deletes) fs.unlinkSync(operation.dest);
        support.writeJson(manifestFile, manifest);
    } finally {
        for (const operation of staged) if (fs.existsSync(operation.temporary)) fs.unlinkSync(operation.temporary);
    }
    return { deployed: writes.length, removed: deletes.length, files: Object.values(nextFiles).map(item => item.target),
        manifestPath: manifestFile, legacyUnowned: !!manifest.legacyUnowned };
}
function deployRuntimeFiles(projectPath, executablePath) {
    const project = support.projectRoot(projectPath);
    return support.withProjectLock(project, () => deployUnlocked(project, executablePath));
}

module.exports = { deployRuntimeFiles };
