'use strict';

const { deployRuntimeFiles } = require('./runtime-deployment.cjs');

if (process.argv.length !== 4) throw new Error('用法: node deploy-runtime.cjs <Creator 项目路径> <宿主可执行文件路径>');
const result = deployRuntimeFiles(process.argv[2], process.argv[3]);
process.stdout.write(`插件运行时文件：复制 ${result.deployed}，清理 ${result.removed}。\n`);
if (result.legacyUnowned) process.stdout.write('旧版本部署记录已保存，相关已有文件继续由宿主管理。\n');
