'use strict';

const fs = require('fs');
const path = require('path');
const support = require('./plugin-support.cjs');

function ensureWindowsBuildHookImpl(projectPath, nativeSourceDir) {
    const project = path.resolve(projectPath);
    const source = path.resolve(nativeSourceDir);
    if (!fs.statSync(source).isDirectory()) throw new Error(`Windows native source directory is missing: ${source}`);
    const manifestPath = path.join(project, '.plugin-dev/windows-build-hooks.json');
    support.noLinks(path.parse(source).root, source);
    support.noLinks(project, manifestPath);
    const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { schemaVersion: 1, files: {} };
    if (previous.schemaVersion !== 1 || !previous.files || typeof previous.files !== 'object' || Array.isArray(previous.files)) {
        throw new Error(`Invalid Windows build hook manifest: ${manifestPath}`);
    }
    const supportDirectory = path.join(project, '.plugin-dev/native-build');
    const cmakePath = path.join(supportDirectory, 'windows-build.cmake');
    const relativeProject = path.relative(source, project).replace(/\\/g, '/') || '.';
    let delimiter = '=';
    while (relativeProject.includes(`]${delimiter}]`)) delimiter += '=';
    const hookPath = path.join(source, 'Post-PluginDevWindows.cmake');
    const outputs = ['windows-build.cmake', 'plugin-support.cjs', 'runtime-deployment.cjs', 'deploy-runtime.cjs', 'runtime-build.cmake', 'typescript-plugin.cjs']
        .map(name => [path.join(supportDirectory, name), fs.readFileSync(path.join(__dirname, name))]);
    outputs.push([hookPath, Buffer.from(`# cocos-plugin-dev 生成并管理此文件。\nget_filename_component(CPD_PROJECT_PATH [${delimiter}[${relativeProject}]${delimiter}] ABSOLUTE BASE_DIR "\${CMAKE_CURRENT_LIST_DIR}")\ninclude("\${CPD_PROJECT_PATH}/.plugin-dev/native-build/windows-build.cmake")\n`)]);
    for (const [file, data] of outputs) {
        support.noLinks(path.parse(file).root, file);
        if (!fs.existsSync(file)) continue;
        if (!fs.statSync(file).isFile()) throw new Error(`Windows build hook target is not a file: ${file}`);
        const actual = support.hash(fs.readFileSync(file));
        const key = file.toLowerCase();
        if (actual !== previous.files[key]?.sha256 && actual !== support.hash(data)) {
            throw new Error(`Windows build hook contains unmanaged or modified content: ${file}`);
        }
    }
    const ignorePath = path.join(source, '.gitignore');
    support.noLinks(path.parse(ignorePath).root, ignorePath);
    if (fs.existsSync(ignorePath) && !fs.statSync(ignorePath).isFile()) throw new Error(`Windows build hook ignore target is not a file: ${ignorePath}`);
    const ignore = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath) : Buffer.alloc(0);
    const ignoreRule = Buffer.from('/Post-PluginDevWindows.cmake\n');
    const ruleOffset = ignore.length - ignoreRule.length;
    const hasLastRule = ruleOffset >= 0 && (ruleOffset === 0 || ignore[ruleOffset - 1] === 10)
        && ignore.subarray(ruleOffset).equals(ignoreRule);
    const ignoreData = hasLastRule ? ignore : Buffer.concat([ignore,
        ignore.length && ignore[ignore.length - 1] !== 10 ? Buffer.from('\n') : Buffer.alloc(0), ignoreRule]);
    support.write(ignorePath, ignoreData);
    const files = { ...previous.files };
    for (const [file, data] of outputs) {
        support.write(file, data);
        files[file.toLowerCase()] = { path: file, sha256: support.hash(data) };
    }
    support.writeJson(manifestPath, { schemaVersion: 1, files });
    return { hookPath, cmakePath, manifestPath };
}

function ensureWindowsBuildHook(projectPath, nativeSourceDir) {
    return support.withProjectLock(projectPath, () => ensureWindowsBuildHookImpl(projectPath, nativeSourceDir));
}

module.exports = { ensureWindowsBuildHook };
