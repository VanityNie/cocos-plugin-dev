'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const support = require('../../../templates/common/editor/plugin-support.cjs');
const { deployRuntimeFiles } = require('../../../templates/common/editor/runtime-deployment.cjs');

const [project, source, executable, expected] = process.argv.slice(2);
const before = process.memoryUsage().arrayBuffers;
const items = support.collectRuntimeFiles(source);
assert.equal(items.length, 1);
assert.deepEqual(Object.keys(items[0]).sort(), ['sha256', 'source', 'target']);
assert.equal(items[0].sha256, expected);
const collected = process.memoryUsage().arrayBuffers;
assert.match(support.nativeFingerprint(source), /^[a-f0-9]{64}$/);
const fingerprinted = process.memoryUsage().arrayBuffers;
const deployment = deployRuntimeFiles(project, executable);
const deployed = process.memoryUsage().arrayBuffers;
const sha256 = support.hashFile(path.join(path.dirname(executable), 'weights.bin'));
assert.equal(sha256, expected);
const bufferGrowth = Math.max(collected, fingerprinted, deployed) - before;
assert.ok(bufferGrowth < 8 * 1024 * 1024, `Buffer 内存增长超出限制: ${bufferGrowth}`);
process.stdout.write(JSON.stringify({ deployed: deployment.deployed, sha256, bufferGrowth }));
