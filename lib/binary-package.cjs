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

function prepareBinaryPackage({ projectPath, info, buildType, platform = 'windows', abi }) {
    const normalizedPlatform = platform === 'android' ? 'android' : 'windows';
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
    const includeDirectories = [];
    for (const [relative, group] of HEADER_ROOTS_BY_PLATFORM[normalizedPlatform]) {
        const root = path.join(info.pluginPath, relative);
        support.noLinks(info.pluginPath, root);
        const files = support.walk(root, (rel, item) => item.isDirectory()
            ? !['.git', '.local', 'build', 'out', 'CMakeFiles'].includes(item.name)
            : !IMPLEMENTATION.test(rel) && !/\.(obj|pdb|ilk|lib|dll|a|so|o|log|tmp|bak)$/i.test(rel));
        if (files.length) includeDirectories.push(`lib/include/${group}`);
        for (const file of files) addFile(`native/${normalizedPlatform}/lib/include/${group}/${file}`, path.join(root, file));
    }
    const artifacts = require('./binary-artifacts.cjs').readBinaryArtifacts({
        projectPath,
        name: info.meta.name,
        buildType,
        platform: normalizedPlatform,
        abi,
        includeDirectories,
    });
    for (const file of artifacts.files) addFile(file.packagePath, file.source, file.sha256);
    const runtimeFiles = [];
    const originalRuntimeSources = new Set();
    const runtimes = [...support.collectRuntimeFiles(info.pluginPath, info.meta), ...(artifacts.runtimeFiles || [])];
    for (const runtime of runtimes) {
        if (IMPLEMENTATION.test(runtime.source)) throw new Error(`运行时资源包含 C++ 实现文件，不能用于二进制发布: ${runtime.source}`);
        const target = support.normalizeRelTarget(runtime.target);
        const source = addFile(`native/${normalizedPlatform}/lib/runtime/${target}`, runtime.source, runtime.sha256);
        if (!runtimeFiles.some(item => item.target.toLowerCase() === target.toLowerCase())) runtimeFiles.push({ source, target });
        originalRuntimeSources.add(path.resolve(runtime.source).toLowerCase());
    }
    const manifest = {
        ...artifacts.manifest,
        headers: includeDirectories,
        runtimeFiles,
        files: Object.fromEntries([...identities.values()].map(item => [item.relative, item.sha256])),
    };
    const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
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
        include(relative, item) {
            if (!item.isDirectory() && IMPLEMENTATION.test(relative)) return false;
            if (relative === 'native') return true;
            if (relative.startsWith('native/')) {
                if (item.isDirectory()) return true;
                return /(?:^|\/)(?:licenses?|licences?|notices?|copying|copyright)(?:[\/_.-]|$)/i.test(relative);
            }
            return item.isDirectory() || (!IMPLEMENTATION.test(relative)
                && !originalRuntimeSources.has(path.resolve(info.pluginPath, relative).toLowerCase()));
        },
    };
}

module.exports = { prepareBinaryPackage };
