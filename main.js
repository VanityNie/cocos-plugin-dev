'use strict';

// This extension deliberately uses the same libraries as the command-line tools.
// Editor APIs below are declared by Creator 3.8's creator-types/editor package.
const fs = require('fs');
const path = require('path');
const PACKAGE_NAME = 'cocos-plugin-dev';
const tasks = new Map();
let activeTask = null;
let nextTaskId = 0;

function projectPath() {
    const value = Editor.Project.path;
    if (!value || !fs.existsSync(path.join(value, 'package.json'))) {
        throw new Error('请先打开一个 Creator 游戏项目。');
    }
    return path.resolve(value);
}

function settingsPath(project) {
    const file = path.join(project, '.plugin-dev', 'ui-settings.json');
    support().noLinks(project, file);
    return file;
}

function readSettings(project) {
    const file = settingsPath(project);
    let saved = {};
    if (fs.existsSync(file)) {
        try {
            saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        } catch (error) {
            throw new Error(`工作台配置无法读取，请检查 ${file}：${error.message}`);
        }
    }
    const creator = /cocoscreator\.exe$/i.test(process.execPath) ? process.execPath : '';
    return { enginePath: '', creatorPath: creator, outputDir: path.join(project, '.plugin-dev', 'packages'), ...saved };
}

function cleanSettings(values) {
    const result = {};
    for (const key of ['enginePath', 'creatorPath', 'outputDir']) {
        if (typeof values[key] === 'string') result[key] = values[key].trim();
    }
    return result;
}

function writeSettings(project, values) {
    const file = settingsPath(project);
    const settings = { ...readSettings(project), ...cleanSettings(values || {}) };
    support().ensureLocalIgnore(project);
    support().writeJson(file, settings);
    return settings;
}

function core() { return require('./lib/core.cjs'); }
function windows() { return require('./lib/windows.cjs'); }
function support() { return require(path.join(__dirname, 'templates/common/editor/plugin-support.cjs')); }

function normalizedEngine(value) {
    if (typeof value !== 'string' || !value) return null;
    const resolved = path.resolve(value);
    const root = path.basename(resolved).toLowerCase() === 'native' ? path.dirname(resolved) : resolved;
    if (!fs.existsSync(path.join(root, 'native', 'CMakeLists.txt'))) return null;
    return fs.realpathSync(root).toLowerCase();
}

async function activeEngine() {
    // Public message declared by builtin/engine/@types/message.d.ts in Creator 3.8.8.
    // The JavaScript and native engine can be configured separately: verify both.
    const info = await Editor.Message.request('engine', 'query-info');
    if (!info || !info.path || !info.nativePath) throw new Error('编辑器未返回当前 JS 与 C++ 引擎路径。');
    return info;
}

async function prepareInEditor(task, options) {
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const fallback = `保存并关闭当前项目的 Creator 后，在 PowerShell 执行：\nnode ${quote(path.join(__dirname, 'cli.cjs'))} prepare --project ${quote(options.projectPath)} --engine-path ${quote(options.enginePath)}`;
    try {
        const engine = await activeEngine();
        const expected = normalizedEngine(options.enginePath);
        if (!expected || normalizedEngine(engine.path) !== expected || normalizedEngine(engine.nativePath) !== expected) {
            throw new Error(`当前编辑器的引擎与工作台设置不一致。\nJS：${engine.path}\nC++：${engine.nativePath}\n目标：${options.enginePath}\n请在 Creator 偏好设置中选择相同的 JS 和原生引擎，并重启项目。`);
        }
        const ready = await Editor.Message.request('builder', 'query-worker-ready');
        if (!ready) throw new Error('Creator 构建进程尚未就绪。请等项目加载完成后重试。');
        append(task, '正在通过当前编辑器构建 Windows 资源；不会启动第二个 Creator。\n');
        // add-task is a version-adapted, protected Creator API, not a stable public API.
        // Its declaration is builtin/builder/@types/protected/message.d.ts. shouldWait
        // returns BuildExitCode; 36 is BUILD_SUCCESS. Never equate queueing with success.
        const result = await Editor.Message.request('builder', 'add-task', {
            ...options.buildConfig, taskName: 'Plugin Development Windows', nextStages: [],
        }, true);
        if (result !== 36) {
            const descriptions = { 32: '构建参数错误', 34: '资源构建失败', 37: '构建器正在处理其他任务', 50: '构建器未知错误' };
            throw new Error(`Creator 构建未完成：${descriptions[result] || `返回值 ${JSON.stringify(result)}，接口可能已变化`}。请检查 Creator 构建日志。`);
        }
        append(task, '当前编辑器已完成资源构建（BUILD_SUCCESS=36）。\n');
        return { enginePath: options.enginePath };
    } catch (error) {
        throw new Error(`${error.message}\n\n如果当前 Creator 版本不支持编辑器内构建接口，可使用命令行回退：\n${fallback}`);
    }
}

function append(task, value) {
    const message = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!message) return;
    task.logs.push({ seq: ++task.sequence, text: message });
    // Avoid growing the editor process indefinitely during verbose engine builds.
    if (task.logs.length > 1500) task.logs.splice(0, task.logs.length - 1500);
}

function snapshot(task, after = 0) {
    if (!task) return null;
    return {
        id: task.id, action: task.action, projectPath: task.projectPath,
        status: task.status, startedAt: task.startedAt, finishedAt: task.finishedAt,
        logs: task.logs.filter((line) => line.seq > after), sequence: task.sequence,
        result: task.result, error: task.error,
    };
}

async function refreshAssets(task) {
    try {
        await Editor.Message.request('asset-db', 'refresh-asset', 'db://assets');
        append(task, '项目资源已刷新。\n');
    } catch (error) {
        append(task, `文件已写入；编辑器资源刷新失败：${error.message}。请在资源管理器刷新后再构建。\n`);
    }
}

async function activateGeneratedExtension(task, plugin) {
    try {
        const folder = plugin.pluginPath || plugin.path;
        if (!folder) throw new Error('生成结果未返回扩展目录。');
        // register/enable/getPackages are public Editor.Package functions. Loading
        // the generated extension starts its own runtime-source watcher immediately.
        const registered = Editor.Package.getPackages({ path: folder });
        if (!registered.length) await Editor.Package.register(folder);
        await Editor.Package.enable(folder);
        await Editor.Message.request(plugin.name, 'sync');
        append(task, '插件编辑器入口已加载，运行时源码自动同步已启动。\n');
    } catch (error) {
        task.outcome = 'attention';
        append(task, `插件源码已创建；自动加载编辑器入口未完成：${error.message}\n请在扩展管理器启用该插件，或重载扩展后再使用自动同步。手动“同步”仍可使用。\n`);
    }
}

async function openPath(file) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) throw new Error(`路径不存在：${resolved}`);
    const error = await require('electron').shell.openPath(resolved);
    if (error) throw new Error(`无法打开 ${resolved}：${error}`);
    return resolved;
}

const ACTIONS = new Set(['create', 'enable', 'sync', 'package', 'doctor', 'prepare', 'configure', 'build', 'run', 'build-run', 'debug']);

async function execute(task, input, settings) {
    const options = {
        projectPath: task.projectPath,
        ...(settings.enginePath ? { enginePath: settings.enginePath } : {}),
        ...(settings.creatorPath ? { creatorPath: settings.creatorPath } : {}),
        onOutput: (value) => append(task, value),
        prepareAssets: (request) => prepareInEditor(task, request),
    };
    const pluginOptions = { ...options, name: input.name };
    let result;
    switch (task.action) {
    case 'create':
        result = await core().createPlugin({ ...pluginOptions, displayName: input.displayName || undefined, template: input.template || 'native' });
        await activateGeneratedExtension(task, result);
        await refreshAssets(task);
        append(task, '插件已创建。原生入口需要在 Windows 宿主重新构建后生效。\n');
        break;
    case 'enable':
        if (typeof input.enabled !== 'boolean') throw new Error('enabled 必须是布尔值。');
        result = await core().setEnabled({ ...pluginOptions, enabled: input.enabled });
        await refreshAssets(task);
        append(task, '启用配置已更新。请重新构建 Windows 宿主，使 TS 和原生模块状态一致。\n');
        break;
    case 'sync':
        result = await core().syncPlugin(pluginOptions);
        await refreshAssets(task);
        break;
    case 'package':
        result = await core().packagePlugin({ ...pluginOptions, outputDir: settings.outputDir || path.join(task.projectPath, '.plugin-dev', 'packages') });
        break;
    case 'doctor':
        result = await windows().doctor(options);
        try {
            const current = await activeEngine();
            const selected = normalizedEngine(settings.enginePath || result.host.enginePath);
            const matches = Boolean(selected && normalizedEngine(current.path) === selected && normalizedEngine(current.nativePath) === selected);
            result.checks.push({ name: 'editor-engine', ok: matches, required: true, message: `当前编辑器 JS=${current.path}，C++=${current.nativePath}${matches ? '' : '；请在 Creator 偏好设置中与工作台引擎保持一致。'}` });
            if (!matches) result.ok = false;
        } catch (error) {
            result.checks.push({ name: 'editor-engine', ok: false, required: true, message: error.message });
            result.ok = false;
        }
        if (result.ok === false) task.outcome = 'attention';
        break;
    case 'prepare': result = await windows().prepareHost(options); break;
    case 'configure': result = await windows().configure(options); break;
    case 'build': result = await windows().build({ ...options, refreshAssets: Boolean(input.refreshAssets) }); break;
    case 'run':
        result = await windows().run(options);
        append(task, '已启动游戏进程。此状态仅确认启动，运行日志及断点用于检查插件行为。\n');
        break;
    case 'build-run':
        await windows().build({ ...options, refreshAssets: Boolean(input.refreshAssets) });
        result = await windows().run(options);
        append(task, '构建完成，游戏进程已启动。\n');
        break;
    case 'debug':
        result = await windows().debugWorkspace(options);
        try {
            await openPath(result.workspacePath);
            append(task, '已请求系统打开调试工作区。在 VS Code 选择生成的调试配置启动。\n');
        } catch (error) {
            append(task, `${error.message}\n工作区已生成，可在 VS Code 中手动打开。\n`);
        }
        break;
    default: throw new Error('未知操作。');
    }
    if (result !== undefined) append(task, JSON.stringify(result, null, 2) + '\n');
    return result;
}

exports.methods = {
    openPanel() { return Editor.Panel.open(PACKAGE_NAME); },

    async getContext() {
        const project = projectPath();
        const result = await core().listPlugins({ projectPath: project });
        const lastTask = Array.from(tasks.values()).reverse().find((task) => task.projectPath === project);
        const settings = readSettings(project);
        if (!settings.enginePath) {
            try {
                const engine = await activeEngine();
                const current = normalizedEngine(engine.path);
                if (current && current === normalizedEngine(engine.nativePath)) settings.enginePath = engine.path;
            } catch (_) { /* Let environment checks explain unavailable editor APIs. */ }
        }
        return {
            projectPath: project, settings,
            plugins: Array.isArray(result) ? result : result.plugins || [],
            task: snapshot(lastTask),
        };
    },

    saveSettings(values) {
        if (activeTask) throw new Error('当前操作完成后才能修改环境配置。');
        return writeSettings(projectPath(), values);
    },

    startTask(action, input = {}) {
        if (!ACTIONS.has(action)) throw new Error(`不支持的操作：${action}`);
        if (activeTask) throw new Error('已有操作正在进行，请等待完成。');
        const project = projectPath();
        const settings = readSettings(project);
        const task = {
            id: String(++nextTaskId), action, projectPath: project, status: 'running',
            startedAt: new Date().toISOString(), logs: [], sequence: 0,
        };
        activeTask = task;
        tasks.set(task.id, task);
        if (tasks.size > 12) tasks.delete(tasks.keys().next().value);
        append(task, `开始：${action}\n项目：${project}\n`);
        // Return an ID immediately. Long native builds must not depend on the IPC timeout.
        Promise.resolve().then(() => execute(task, input || {}, settings)).then((result) => {
            task.result = result;
            task.status = task.outcome || 'succeeded';
        }).catch((error) => {
            task.error = error.stack || error.message || String(error);
            task.status = 'failed';
            append(task, `\n操作失败：${task.error}\n`);
        }).finally(() => {
            task.finishedAt = new Date().toISOString();
            activeTask = null;
        });
        return snapshot(task);
    },

    getTask(id, after = 0) {
        const task = tasks.get(String(id));
        if (!task || task.projectPath !== projectPath()) throw new Error('任务已失效，请刷新面板。');
        return snapshot(task, Number(after) || 0);
    },

    async openSource(name) {
        const project = projectPath();
        const result = await core().listPlugins({ projectPath: project });
        const plugins = Array.isArray(result) ? result : result.plugins || [];
        const plugin = plugins.find((item) => item.name === name);
        if (!plugin) throw new Error('插件不存在，请刷新列表。');
        const folder = plugin.path || plugin.pluginPath || path.join(project, 'extensions', name);
        return openPath(folder);
    },
};

exports.load = function load() {};
exports.unload = function unload() {
    if (activeTask) console.warn('[cocos-plugin-dev] 原生构建尚未结束。关闭面板不会取消构建，请等待日志完成后再重载扩展。');
};
