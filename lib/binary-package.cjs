'use strict';

const path = require('node:path');
const support = require('../templates/common/editor/plugin-support.cjs');

const IMPLEMENTATION = /\.(?:c|cc|cpp|cxx|c\+\+|m|mm|ixx|cppm)$/i;
const HEADER_ROOTS_BY_PLATFORM = {
    windows: [
        ['native/include', 'plugin'],
        ['native/windows/include', 'windows'],
        ['native/third_party/include', 'third_party'],
    ],
    android: [
        ['native/include', 'plugin'],
        ['native/android/include', 'android'],
        ['native/third_party/include', 'third_party'],
    ],
};

const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function binaryPackageEntries(info) {
    const nativeManifest = support.readJson(path.join(info.pluginPath, 'native/cc_plugin.json'));
    if (nativeManifest.modules?.length !== 1 || nativeManifest.modules[0].target !== info.meta.target) {
        throw new Error('二进制导出要求 cc_plugin.json.modules 仅声明当前插件 target。');
    }
    const entries = new Map();
    const identities = new Map();
    const addFile = (relative, source, sha256 = support.hashFile(source)) => {
        const normalized = support.normalizeRelTarget(relative);
        const identity = normalized.toLowerCase();
        const previous = identities.get(identity);
        if (previous && previous.sha256 !== sha256) throw new Error(`二进制发布文件路径冲突: ${normalized}`);
        if (!previous) {
            identities.set(identity, { relative: normalized, sha256 });
            entries.set(normalized, { source, sha256 });
        }
        return previous?.relative || normalized;
    };
    const originalRuntimeSources = new Set();
    const include = (relative, item) => {
        if (!item.isDirectory() && IMPLEMENTATION.test(relative)) return false;
        if (relative === 'native') return true;
        if (relative.startsWith('native/')) {
            if (item.isDirectory()) return true;
            return /(?:^|\/)(?:licenses?|licences?|notices?|copying|copyright)(?:[\/_.-]|$)/i.test(relative);
        }
        return item.isDirectory() || !originalRuntimeSources.has(path.resolve(info.pluginPath, relative).toLowerCase());
    };
    return { nativeManifest, entries, identities, addFile, originalRuntimeSources, include };
}

function collectHeaders(info, platform) {
    const includeDirectories = [];
    const headers = [];
    for (const [relative, group] of HEADER_ROOTS_BY_PLATFORM[platform]) {
        const root = path.join(info.pluginPath, relative);
        support.noLinks(info.pluginPath, root);
        const files = support.walk(root, (rel, item) => item.isDirectory()
            ? !['.git', '.local', 'build', 'out', 'CMakeFiles'].includes(item.name)
            : !IMPLEMENTATION.test(rel) && !/\.(obj|pdb|ilk|lib|dll|a|so|o|log|tmp|bak)$/i.test(rel));
        if (files.length) includeDirectories.push(`lib/include/${group}`);
        for (const file of files) headers.push({ packagePath: `native/${platform}/lib/include/${group}/${file}`, source: path.join(root, file) });
    }
    return { includeDirectories, headers };
}

function addAndroidLibraries(info, addFile, files, options) {
    const packagedSources = new Set(files.map(file => path.resolve(file.source)));
    return support.collectAndroidNativeLibs(info.pluginPath, info.meta, options)
        .filter(library => !/\.so$/i.test(library.source) || !packagedSources.has(path.resolve(library.source)))
        .map(library => addFile(`native/third_party/android/${library.target}`, library.source, library.sha256));
}

function prepareBinaryPackage({ projectPath, info, buildType, platform = 'windows', abi }) {
    const normalizedPlatform = platform === 'android' ? 'android' : 'windows';
    const { nativeManifest, entries, identities, addFile, originalRuntimeSources, include } = binaryPackageEntries(info);
    const { includeDirectories, headers } = collectHeaders(info, normalizedPlatform);
    for (const file of headers) addFile(file.packagePath, file.source);
    const artifacts = require('./binary-artifacts.cjs').readBinaryArtifacts({
        projectPath,
        name: info.meta.name,
        buildType,
        platform: normalizedPlatform,
        abi,
        includeDirectories,
    });
    for (const file of artifacts.files) addFile(file.packagePath, file.source, file.sha256);
    if (normalizedPlatform === 'android') {
        addAndroidLibraries(info, addFile, artifacts.files, { abis: [artifacts.abi], buildType: artifacts.buildType });
    }
    const runtimeFiles = [];
    const runtimeTargets = new Map();
    const runtimes = support.collectPackageRuntimeFiles(info.pluginPath, info.meta, normalizedPlatform);
    if (normalizedPlatform === 'windows') {
        runtimes.push(...(artifacts.runtimeFiles || []).map(item => ({ ...item, platform: 'windows' })));
    }
    for (const runtime of runtimes) {
        if (IMPLEMENTATION.test(runtime.source)) throw new Error(`运行时资源包含 C++ 实现文件，不能用于二进制发布: ${runtime.source}`);
        const target = support.normalizeRelTarget(runtime.target);
        originalRuntimeSources.add(path.resolve(runtime.source).toLowerCase());
        const key = target.toLowerCase();
        if (runtimeTargets.has(key)) {
            if (runtimeTargets.get(key) !== runtime.sha256) throw new Error(`二进制发布文件路径冲突: ${target}`);
            continue;
        }
        const directory = runtime.platform === 'windows' ? 'native/windows/lib/runtime' : 'native/runtime';
        const source = addFile(`${directory}/${target}`, runtime.source, runtime.sha256);
        runtimeTargets.set(key, runtime.sha256);
        runtimeFiles.push({ source, target, ...(runtime.platform === undefined ? {} : { platform: runtime.platform }) });
    }
    const manifest = {
        ...artifacts.manifest,
        headers: includeDirectories,
        runtimeFiles,
        ...(normalizedPlatform === 'android' ? { runtimeLibs: [...entries.keys()].filter(file => /\.so$/i.test(file)) } : {}),
        files: Object.fromEntries([...identities.values()].map(item => [item.relative, item.sha256])),
    };
    entries.set('plugin-dev.json', json({
        ...info.sourceMeta,
        schemaVersion: 1,
        enabled: true,
        runtimeFiles,
        distribution: {
            type: 'binary',
            platform: normalizedPlatform,
            ...(artifacts.abi ? { abi: artifacts.abi } : {}),
            buildType: artifacts.buildType,
        },
    }));
    entries.set('native/cc_plugin.json', json({
        ...nativeManifest,
        disabled: false,
        platforms: [normalizedPlatform],
        ...(manifest.engineVersion ? { 'engine-version': manifest.engineVersion } : {}),
    }));
    entries.set(`native/${normalizedPlatform}/${info.meta.target}-config.cmake`, Buffer.from(artifacts.cmake));
    entries.set(`native/${normalizedPlatform}/binary-manifest.json`, json(manifest));
    const binaryDoc = normalizedPlatform === 'android'
        ? [
            `# ${info.meta.name} Android 二进制插件`, '',
            `本包用于 Android (${artifacts.abi})，构建配置为 ${artifacts.buildType}。构建信息及文件 SHA-256 记录在 native/android/binary-manifest.json。`, '',
            '将 ZIP 内的插件目录复制到 Creator 项目的 extensions/，启用插件并构建相同 ABI 与配置的 Android 项目。', '',
            `公开头文件位于 native/android/lib/include/；插件静态库 (.a) 位于 native/android/${artifacts.abi}/lib/。`, '',
            '更新插件时整体替换插件目录，再重新构建。CMake 会检查 Android ABI、STL、构建配置和引擎版本兼容条件。', '',
        ]
        : [
            `# ${info.meta.name} 二进制插件`, '',
            `本包用于 Windows x64，构建配置为 ${artifacts.buildType}。构建信息及文件 SHA-256 记录在 native/windows/binary-manifest.json。`, '',
            '将 ZIP 内的插件目录复制到 Creator 项目的 extensions/，启用插件并构建相同配置的 Windows 项目。项目需要 Creator 和对应的 C++ 编译工具。', '',
            '公开头文件位于 native/windows/lib/include/；插件静态库和链接依赖位于 native/windows/lib/；运行时 DLL 和资源通过插件附带的构建入口部署。', '',
            '使用 /Zi 或 /ZI 编译的静态库附带 compiler PDB，文件保存在对应静态库目录；/Z7 调试信息保存在静态库内部。调试信息包含函数符号和源码行号，源码级调试需要另行提供匹配的 C++ 源码。', '',
            '更新插件时整体替换插件目录，再重新构建。CMake 会检查构建配置和二进制兼容条件。', '',
        ];
    entries.set('BINARY.md', Buffer.from(binaryDoc.join('\n')));
    return {
        platform: normalizedPlatform,
        ...(artifacts.abi ? { abi: artifacts.abi } : {}),
        entries,
        manifest,
        buildType: artifacts.buildType,
        include,
    };
}

function collectMultiRuntimeFiles(info, multi, originalRuntimeSources) {
    const targets = new Map();
    for (const platform of multi.platforms) {
        const runtimes = support.collectPackageRuntimeFiles(info.pluginPath, info.meta, platform);
        if (platform === 'windows') runtimes.push(...multi.runtimeFiles);
        for (const runtime of runtimes) {
            if (IMPLEMENTATION.test(runtime.source)) throw new Error(`运行时资源包含 C++ 实现文件，不能用于二进制发布: ${runtime.source}`);
            originalRuntimeSources.add(path.resolve(runtime.source).toLowerCase());
            const target = support.normalizeRelTarget(runtime.target);
            const key = target.toLowerCase();
            if (!targets.has(key)) targets.set(key, new Map());
            const byPlatform = targets.get(key);
            const previous = byPlatform.get(platform);
            if (previous && previous.sha256 !== runtime.sha256) throw new Error(`二进制发布文件路径冲突: ${target}`);
            if (!previous) byPlatform.set(platform, { ...runtime, target, platform });
        }
    }
    return [...targets.values()].flatMap(byPlatform => {
        const windows = byPlatform.get('windows');
        const android = byPlatform.get('android');
        return windows && android && windows.sha256 === android.sha256
            ? [{ ...windows, platform: undefined }] : [...byPlatform.values()];
    });
}

function prepareMultiBinaryPackage({ projectPath, info, selection }) {
    const { nativeManifest, entries, addFile, originalRuntimeSources, include } = binaryPackageEntries(info);
    const headersByPlatform = Object.fromEntries((selection.platforms === 'all' ? Object.keys(HEADER_ROOTS_BY_PLATFORM) : selection.platforms)
        .map(platform => [platform, collectHeaders(info, platform)]));
    const includeDirectoriesByPlatform = Object.fromEntries(Object.entries(headersByPlatform)
        .map(([platform, { includeDirectories }]) => [platform, includeDirectories]));
    const multi = require('./binary-artifacts.cjs').readMultiBinaryArtifacts({
        projectPath, name: info.meta.name, ...selection, includeDirectoriesByPlatform,
    });
    const runtimeFiles = collectMultiRuntimeFiles(info, multi, originalRuntimeSources).map(runtime => {
        const directory = runtime.platform === 'windows' ? 'native/windows/lib/runtime' : 'native/runtime';
        const source = addFile(`${directory}/${runtime.target}`, runtime.source, runtime.sha256);
        return { source, target: runtime.target, ...(runtime.platform ? { platform: runtime.platform } : {}) };
    });
    const androidLibraries = multi.android ? addAndroidLibraries(info, addFile, multi.files, { abis: multi.android.abis }) : [];
    const distribution = { type: 'binary', platforms: multi.platforms };
    const manifests = {};
    const binaryDoc = [
        `# ${info.meta.name} 二进制插件`, '',
        '将 ZIP 内的插件目录复制到 Creator 项目的 extensions/，启用插件后使用对应的平台、ABI 和构建配置。', '',
    ];
    for (const platform of multi.platforms) {
        const { abis, buildTypes, configPath, cmake, files, manifest } = multi[platform];
        const { includeDirectories, headers } = headersByPlatform[platform];
        const platformRuntime = runtimeFiles.filter(file => !file.platform || file.platform === platform);
        const paths = [...new Set([
            ...headers.map(file => addFile(file.packagePath, file.source)),
            ...files.map(file => addFile(file.packagePath, file.source, file.sha256)),
            ...(platform === 'android' ? androidLibraries : []),
            ...platformRuntime.map(file => file.source),
        ])];
        manifests[platform] = {
            ...manifest,
            headers: includeDirectories,
            runtimeFiles: platformRuntime,
            ...(platform === 'android' ? { runtimeLibs: paths.filter(file => /\.so$/i.test(file)) } : {}),
            files: Object.fromEntries(paths.map(file => [file, entries.get(file).sha256])),
        };
        distribution[platform] = { ...(abis ? { abis } : {}), buildTypes };
        entries.set(configPath, Buffer.from(cmake));
        entries.set(`native/${platform}/binary-manifest.json`, json(manifests[platform]));
        binaryDoc.push(abis ? `- Android ABI 为 ${abis.join('、')}，构建配置为 ${buildTypes.join('、')}。`
            : `- Windows x64 的构建配置为 ${buildTypes.join('、')}。`);
    }
    entries.set('plugin-dev.json', json({ ...info.sourceMeta, schemaVersion: 1, enabled: true, runtimeFiles, distribution }));
    entries.set('native/cc_plugin.json', json({ ...nativeManifest, disabled: false, platforms: multi.platforms, 'engine-version': multi.engineVersion }));
    entries.set('BINARY.md', Buffer.from([...binaryDoc, '', '各平台的 binary-manifest.json 记录文件的 SHA-256。', ''].join('\n')));
    return { multi, entries, include, distribution, manifests };
}

module.exports = { prepareBinaryPackage, prepareMultiBinaryPackage };
