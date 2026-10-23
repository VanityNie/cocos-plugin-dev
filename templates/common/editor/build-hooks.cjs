'use strict';

const fs = require('node:fs');
const path = require('node:path');
const support = require('./plugin-support.cjs');
const { ensureWindowsBuildHook } = require('./windows-build.cjs');
const { deployRuntimeFiles } = require('./runtime-deployment.cjs');

const name = '{{NAME}}';
exports.throwError = true;

function projectPath() {
    if (!Editor.Project?.path) throw new Error(`[${name}] 需要已打开的 Creator 宿主项目。`);
    return support.projectRoot(Editor.Project.path);
}
function ensureHook(project, required) {
    const sources = ['win64', 'windows'].map(directory => path.join(project, 'native/engine', directory))
        .filter(directory => fs.existsSync(path.join(directory, 'CMakeLists.txt')));
    if (sources.length > 1) throw new Error(`存在多个 Windows 原生项目目录: ${sources.join(', ')}`);
    if (!sources.length) {
        if (required) throw new Error('Creator 尚未生成 Windows 原生项目目录。');
        return;
    }
    return ensureWindowsBuildHook(project, sources[0]);
}
function pathKey(value) {
    return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}
function builtExecutable(project, root, options) {
    const directory = path.join(project, '.plugin-dev/native-build/metadata');
    support.noLinks(project, directory);
    if (!fs.existsSync(directory)) throw new Error('CMake 尚未生成运行时部署信息，请重新生成并编译 Windows 原生项目。');
    const configuration = options.debug ? 'Debug' : 'Release';
    const buildDirectories = new Set([pathKey(root), pathKey(path.join(root, 'proj'))]);
    const candidates = [];
    for (const file of fs.readdirSync(directory)) {
        if (!file.endsWith('.json')) continue;
        const metadataFile = path.join(directory, file);
        support.noLinks(project, metadataFile);
        const item = support.readJson(metadataFile);
        if (item.schemaVersion !== 1 || typeof item.projectPath !== 'string'
            || typeof item.resourceDirectory !== 'string' || typeof item.buildDirectory !== 'string'
            || typeof item.executable !== 'string' || !path.isAbsolute(item.executable)) throw new Error(`CMake 部署信息无效: ${metadataFile}`);
        if (pathKey(item.projectPath) !== pathKey(project) || item.configuration !== configuration) continue;
        if (!buildDirectories.has(pathKey(item.buildDirectory))) continue;
        if (fs.existsSync(item.executable)) candidates.push(item.executable);
    }
    const unique = [...new Set(candidates.map(executable => path.resolve(executable)))];
    if (unique.length !== 1) throw new Error(`无法唯一识别本次 ${configuration} 构建的可执行文件: ${root}`);
    return unique[0];
}

exports.onBeforeBuild = async function () {
    const project = projectPath();
    const result = support.syncPlugin({ projectPath: project, name });
    if (result.copied || result.removed) await Editor.Message.request('asset-db', 'refresh-asset', result.assetUrl);
    ensureHook(project, false);
};
exports.onAfterBuild = function () {
    ensureHook(projectPath(), true);
};
exports.onAfterCompressSettings = function () {
    ensureHook(projectPath(), true);
};
exports.onBeforeMake = function () {
    ensureHook(projectPath(), true);
};
exports.onAfterMake = function (root, options) {
    const project = projectPath();
    return deployRuntimeFiles(project, builtExecutable(project, root, options));
};
exports._internal = { builtExecutable };
