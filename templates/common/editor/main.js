'use strict';

const fs = require('node:fs');
const path = require('node:path');
const support = require('./plugin-support.cjs');
let watcher;
let timer;
const name = '{{NAME}}';

async function sync() {
    if (!Editor.Project || !Editor.Project.path) return;
    const result = support.syncPlugin({ projectPath: Editor.Project.path, name });
    if (result.copied || result.removed) {
        await Editor.Message.request('asset-db', 'refresh-asset', result.assetUrl);
    }
    return result;
}
exports.load = async function () {
    await sync();
    // Native source participates in CMake directly. Changes are fingerprinted to
    // mark a pending native rebuild; only runtime files are mirrored to assets.
    watcher = fs.watch(path.join(__dirname, '..'), { recursive: true }, (_event, file) => {
        const relative = file ? String(file).replace(/\\/g, '/') : '';
        if (relative && relative !== 'plugin-dev.json' && !/^(runtime|native)\//.test(relative)) return;
        if (/^native\/(build|out|cache|temp|\.vs|CMakeFiles)(\/|$)/.test(relative)
            || /\.(obj|pdb|ilk|log|tmp)$/.test(relative)) return;
        clearTimeout(timer);
        timer = setTimeout(() => sync().catch(error => console.error(`[${name}]`, error)), 250);
    });
};
exports.unload = function () {
    clearTimeout(timer);
    if (watcher) watcher.close();
    watcher = undefined;
    // Editor reload is not plugin disable. The development panel owns enable state.
};
exports.methods = { sync };
