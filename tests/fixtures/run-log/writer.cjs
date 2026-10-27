'use strict';

const fs = require('node:fs');
const path = require('node:path');

if (process.argv[2] === 'early-exit') {
    fs.writeSync(2, '启动阶段中文错误\n');
    process.exit(23);
}

const directory = process.argv[2];
const commandPath = path.join(directory, 'command.json');
fs.writeSync(1, '游戏启动中文\n');
fs.writeSync(2, 'stderr 中文\n');
fs.mkdirSync(path.join(directory, 'ready'));
let previous = 0;
setInterval(() => {
    if (!fs.existsSync(commandPath)) return;
    const command = JSON.parse(fs.readFileSync(commandPath, 'utf8'));
    if (command.id === previous) return;
    previous = command.id;
    fs.writeSync(command.channel || 1, Buffer.from(command.bytes, 'base64'));
    fs.mkdirSync(path.join(directory, `done-${command.id}`));
    if (command.exit) process.exit(0);
}, 20);
