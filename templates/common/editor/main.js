'use strict';

const fs = require('node:fs');
const support = require('./plugin-support.cjs');
let sourceWatcher;
let hostWatcher;
let sourcePath;
let watching = false;
let timer;
const name = '{{NAME}}';

async function sync() {
    if (!Editor.Project || !Editor.Project.path) throw new Error(`[${name}] 需要已打开的 Creator 宿主项目。`);
    const result = support.syncPlugin({ projectPath: Editor.Project.path, name });
    if (watching) watchSource(result.sourcePath);
    if (result.copied || result.removed) {
        await Editor.Message.request('asset-db', 'refresh-asset', result.assetUrl);
    }
    return result;
}
function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => sync().catch(error => console.error(`[${name}] 同步失败 (${sourcePath}):`, error)), 250);
}
function watchSource(nextPath) {
    if (sourceWatcher && nextPath === sourcePath) return;
    const watcher = fs.watch(nextPath, { recursive: true }, (_event, file) => {
        const relative = file ? String(file).replace(/\\/g, '/') : '';
        if (relative && !['plugin-dev.json', 'package.json'].includes(relative) && !/^(runtime|native)(\/|$)/.test(relative)) return;
        if (/^native\/(build|out|cache|temp|\.vs|CMakeFiles)(\/|$)/.test(relative)
            || /\.(obj|pdb|ilk|log|tmp)$/.test(relative)) return;
        schedule();
    });
    watcher.on('error', error => console.error(`[${name}] 源码监听失败 (${nextPath}):`, error));
    if (sourceWatcher) sourceWatcher.close();
    sourceWatcher = watcher;
    sourcePath = nextPath;
}
function stopWatching() {
    watching = false;
    clearTimeout(timer);
    if (sourceWatcher) sourceWatcher.close();
    if (hostWatcher) hostWatcher.close();
    sourceWatcher = undefined;
    hostWatcher = undefined;
    sourcePath = undefined;
}
exports.load = async function () {
    const result = await sync();
    const project = Editor.Project.path;
    watching = true;
    try {
        // CMake reads original native sources; only runtime assets are mirrored.
        watchSource(result.sourcePath);
        if (result.sourceType === 'local') {
            hostWatcher = fs.watch(project, (_event, file) => { if (!file || String(file) === 'plugin-dev.host.json') schedule(); });
            hostWatcher.on('error', error => console.error(`[${name}] 宿主配置监听失败 (${project}):`, error));
        }
    } catch (error) {
        stopWatching();
        throw error;
    }
};
exports.unload = function () {
    stopWatching();
    // Editor reload is not plugin disable. The development panel owns enable state.
};
exports.methods = { sync };
