'use strict';

const fs = require('fs');
const path = require('path');
const PACKAGE_NAME = 'cocos-plugin-dev';
const labels = {
    create: '创建插件', enable: '更新插件状态', sync: '同步运行时文件', package: '打包插件',
    doctor: '检查环境', prepare: '准备 Windows 宿主', configure: '配置原生构建',
    build: '编译 Windows 宿主', run: '启动游戏', 'build-run': '构建并运行', debug: '生成调试工作区',
    stop: '停止游戏', restart: '重启游戏',
};

function isPending(task) { return task.status === 'running' || task.status === 'cancelling'; }

function request(message, ...args) { return Editor.Message.request(PACKAGE_NAME, message, ...args); }
function query(panel, selector) { return panel.$.app.querySelector(selector); }
function textElement(document, tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
}
function notice(panel, text, kind = 'error') {
    const element = query(panel, '#notice');
    element.textContent = text;
    element.className = text ? `visible ${kind}` : '';
}
function busy(panel, value) {
    panel._busy = value;
    panel.$.app.querySelectorAll('[data-mutation], #save-settings, .settings input').forEach((element) => { element.disabled = value; });
}
function settings(panel) {
    return {
        enginePath: query(panel, '#engine-path').value,
        creatorPath: query(panel, '#creator-path').value,
        outputDir: query(panel, '#output-dir').value,
    };
}
function showTask(panel, task) {
    const previousSequence = panel._task === task.id ? panel._sequence : 0;
    if (task.sequence < previousSequence) return;
    panel._task = task.id;
    panel._sequence = task.sequence;
    const label = query(panel, '#task-status');
    label.className = `status ${task.status}`;
    const statuses = { running: '进行中', cancelling: '取消中', cancelled: '已取消', succeeded: '已完成', failed: '失败', attention: '需要处理' };
    label.textContent = `${labels[task.action] || task.action} · ${statuses[task.status] || task.status}`;
    const cancelButton = query(panel, '#cancel-task');
    cancelButton.hidden = !task.canCancel && task.status !== 'cancelling';
    cancelButton.disabled = !task.canCancel || panel._cancelRequested;
    cancelButton.textContent = task.status === 'cancelling' ? '取消中…' : '取消任务';
    query(panel, '#task-detail').textContent = task.status === 'cancelling'
        ? task.waitingForEditorBuild ? '等待 Creator 资源构建结束，随后停止后续操作。' : '正在结束当前操作，请稍候。'
        : task.status === 'cancelled' ? '操作已取消，可重新执行。'
        : task.status === 'running'
        ? '正在执行，请稍候。关闭面板不会中断操作；构建期间其他写入操作已暂停。'
        : task.status === 'attention' ? '操作需要后续处理，请查看下方日志中的具体步骤。'
            : task.status === 'failed' ? '操作未完成。修复日志中的错误后重新执行。'
                : task.action === 'stop' ? (task.result && task.result.stopped ? '游戏进程已停止。' : '当前没有由工作台管理的运行中游戏。')
                : ['run', 'restart', 'build-run'].includes(task.action) ? (task.result && task.result.alreadyRunning ? '游戏已在运行，未启动新进程。' : '游戏进程已启动；请通过游戏画面、运行日志或断点验证插件行为。') : '操作已结束，详细结果见下方日志。';
    const log = query(panel, '#log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    if (task.logs.length) {
        log.textContent += task.logs.filter((line) => line.seq > previousSequence).map((line) => line.text).join('');
        if (log.textContent.length > 200000) log.textContent = '[较早日志已截断]\n' + log.textContent.slice(-180000);
        if (atBottom) log.scrollTop = log.scrollHeight;
    }
    busy(panel, isPending(task));
}
function schedulePoll(panel) {
    clearTimeout(panel._timer);
    panel._timer = setTimeout(async () => {
        if (panel._closed) return;
        try {
            const taskId = panel._task;
            const task = await request('get-task', taskId, panel._sequence);
            if (panel._closed || panel._task !== taskId) return;
            showTask(panel, task);
            if (isPending(task)) schedulePoll(panel);
            else {
                if (task.status === 'failed') notice(panel, task.error ? task.error.split('\n')[0] : '操作失败，请检查日志。');
                await refresh(panel, false);
            }
        } catch (error) {
            if (panel._closed) return;
            notice(panel, `无法读取任务进度：${error.message}。请点击刷新。`);
            // Keep the UI locked until the authoritative main-process state is refreshed.
        }
    }, 700);
}

async function start(panel, action, input = {}) {
    if (panel._busy) return;
    busy(panel, true);
    notice(panel, '');
    try {
        await request('save-settings', settings(panel));
        const task = await request('start-task', action, { ...input, refreshAssets: query(panel, '#refresh-assets').checked });
        if (panel._closed) return;
        query(panel, '#log').textContent = '';
        showTask(panel, task);
        schedulePoll(panel);
    } catch (error) {
        if (panel._closed) return;
        busy(panel, false);
        notice(panel, error.message || String(error));
    }
}

async function cancel(panel) {
    if (!panel._task || panel._cancelRequested) return;
    panel._cancelRequested = true;
    query(panel, '#cancel-task').disabled = true;
    try {
        const task = await request('cancel-task', panel._task);
        if (panel._closed) return;
        showTask(panel, task);
        schedulePoll(panel);
    } catch (error) {
        if (!panel._closed) {
            notice(panel, error.message || String(error));
            await refresh(panel);
        }
    } finally {
        panel._cancelRequested = false;
    }
}

function renderPlugins(panel, plugins) {
    const container = query(panel, '#plugins');
    container.textContent = '';
    const document = container.ownerDocument;
    query(panel, '#plugin-count').textContent = `${plugins.length} 个插件`;
    if (!plugins.length) {
        container.appendChild(textElement(document, 'p', '还没有工作台插件。创建第一个 TS + C++ 插件开始开发。', 'empty'));
        return;
    }
    for (const plugin of plugins) {
        const row = textElement(document, 'article', '', 'plugin');
        const info = textElement(document, 'div', '');
        info.appendChild(textElement(document, 'div', plugin.displayName || plugin.name, 'plugin-name'));
        info.appendChild(textElement(document, 'div', `${plugin.name} · ${plugin.template === 'render' ? '渲染扩展' : '原生能力'}`, 'plugin-meta'));
        const state = `${plugin.enabled ? '已启用' : '已禁用'}${plugin.needsRebuild ? ' · 待重新构建' : ''}`;
        info.appendChild(textElement(document, 'div', state, `plugin-meta ${plugin.enabled ? 'enabled' : 'disabled'}`));
        row.appendChild(info);
        const actions = textElement(document, 'div', '', 'plugin-actions');
        for (const [action, title] of [['enable', plugin.enabled ? '禁用' : '启用'], ['source', '打开源码'], ['sync', '同步'], ['package', '打包']]) {
            const button = textElement(document, 'button', title);
            button.type = 'button';
            if (action !== 'source') button.setAttribute('data-mutation', '');
            button.addEventListener('click', async () => {
                if (action === 'source') {
                    try { await request('open-source', plugin.name); }
                    catch (error) { notice(panel, error.message); }
                } else await start(panel, action, { name: plugin.name, enabled: !plugin.enabled });
            });
            actions.appendChild(button);
        }
        row.appendChild(actions);
        container.appendChild(row);
    }
    busy(panel, panel._busy);
}

async function refresh(panel, restoreTask = true) {
    try {
        const context = await request('get-context');
        if (panel._closed) return;
        query(panel, '#project-path').textContent = context.projectPath;
        if (!panel._settingsLoaded) {
            query(panel, '#engine-path').value = context.settings.enginePath || '';
            query(panel, '#creator-path').value = context.settings.creatorPath || '';
            query(panel, '#output-dir').value = context.settings.outputDir || '';
            query(panel, '#settings-details').open = !context.settings.enginePath;
            panel._settingsLoaded = true;
        }
        renderPlugins(panel, context.plugins);
        if (restoreTask && context.task) {
            query(panel, '#log').textContent = '';
            panel._sequence = 0;
            showTask(panel, context.task);
            if (isPending(context.task)) schedulePoll(panel);
        } else if (restoreTask) busy(panel, false);
    } catch (error) {
        if (!panel._closed) notice(panel, error.message || String(error));
    }
}

module.exports = Editor.Panel.define({
    template: fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'),
    style: fs.readFileSync(path.join(__dirname, 'index.css'), 'utf8'),
    $: { app: '#app' },
    ready() {
        this._closed = false;
        this._busy = false;
        this._settingsLoaded = false;
        this._sequence = 0;
        this._cancelRequested = false;
        query(this, '#refresh').addEventListener('click', () => refresh(this));
        query(this, '#cancel-task').addEventListener('click', () => cancel(this));
        query(this, '#save-settings').addEventListener('click', async () => {
            try {
                await request('save-settings', settings(this));
                notice(this, '环境设置已保存。', 'info');
            } catch (error) { notice(this, error.message); }
        });
        query(this, '#create-form').addEventListener('submit', (event) => {
            event.preventDefault();
            start(this, 'create', {
                name: query(this, '#plugin-name').value.trim(),
                displayName: query(this, '#display-name').value.trim(),
                template: query(this, '#template').value,
            });
        });
        this.$.app.querySelectorAll('[data-action]').forEach((button) => {
            button.addEventListener('click', () => start(this, button.dataset.action));
        });
        refresh(this);
    },
    close() {
        this._closed = true;
        clearTimeout(this._timer);
    },
});
