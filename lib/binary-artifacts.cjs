'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const support = require('../templates/common/editor/plugin-support.cjs');

const slash = value => value.replace(/\\/g, '/');
const identity = value => slash(value).toLowerCase();
const json = file => support.readJson(file);
const proofPath = project => path.join(project, '.plugin-dev/binary-build.json');
const androidProofPath = (project, abi) => path.join(project, '.plugin-dev', `binary-build-android-${abi}.json`);
const present = file => fs.existsSync(file) && fs.statSync(file).isFile();

function difference(values, common) {
    const counts = new Map();
    for (const value of common) counts.set(value, (counts.get(value) || 0) + 1);
    return values.filter(value => {
        const key = value;
        if (!counts.get(key)) return true;
        counts.set(key, counts.get(key) - 1);
        return false;
    });
}

function tokenize(state, groups) {
    const directory = path.join(state.buildDir, '.plugin-dev/binary-metadata');
    const input = path.join(directory, 'fragments.json');
    const output = path.join(directory, 'tokens.json');
    support.noLinks(state.projectPath, input);
    support.noLinks(state.projectPath, output);
    support.writeJson(input, groups);
    const result = cp.spawnSync(state.tools.cmake, [`-DCPD_INPUT=${slash(input)}`, `-DCPD_OUTPUT=${slash(output)}`, '-P', path.join(__dirname, 'cmake/tokenize-fragments.cmake')], { encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`CMake 参数解析失败: ${result.stderr || result.stdout}`);
    return json(output);
}

function readTargets(state) {
    const reply = path.join(state.buildDir, '.cmake/api/v1/reply');
    const indexes = fs.readdirSync(reply).filter(file => /^index-.*\.json$/.test(file)).sort().reverse();
    if (!indexes.length) throw new Error('CMake File API 未生成构建记录。');
    const reference = json(path.join(reply, indexes[0])).reply['codemodel-v2'];
    const model = json(path.join(reply, reference.jsonFile));
    const configuration = model.configurations.find(item => item.name === state.buildType);
    if (!configuration) throw new Error(`CMake File API 缺少 ${state.buildType} 配置。`);
    return new Map(configuration.targets.map(item => [item.name, json(path.join(reply, item.jsonFile))]));
}

function fileRecord(source) {
    const resolved = path.resolve(source);
    support.noLinks(path.parse(resolved).root, resolved);
    if (!present(resolved)) throw new Error(`二进制构建产物不存在: ${resolved}`);
    return { source: resolved, sha256: support.hashFile(resolved) };
}

function fragments(target, role) {
    return (target.link?.commandFragments || []).filter(item => item.role === role).map(item => item.fragment);
}

function compileGroups(target) {
    return (target.compileGroups || []).filter(group => ['C', 'CXX'].includes(group.language)).map(group => (group.compileCommandFragments || []).map(item => item.fragment));
}

function compileFragments(target) {
    return compileGroups(target).flat();
}

function definitions(target) {
    return (target.compileGroups || []).flatMap(group => (group.defines || []).map(item => item.define));
}

function within(root, file) {
    const relative = path.relative(root, file);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parseAndroidLibraryTokens(tokens) {
    const result = [];
    let wholeArchive = false;
    let staticMode = false;
    const stateStack = [];
    const applyLinkerFlag = (flag) => {
        if (flag === '--push-state') {
            stateStack.push({ wholeArchive, staticMode });
            return true;
        }
        if (flag === '--pop-state') {
            if (stateStack.length) ({ wholeArchive, staticMode } = stateStack.pop());
            else { wholeArchive = false; staticMode = false; }
            return true;
        }
        if (flag === '--whole-archive') {
            wholeArchive = true;
            return true;
        }
        if (flag === '--no-whole-archive') {
            wholeArchive = false;
            return true;
        }
        if (flag === '-Bstatic' || flag === '--Bstatic' || flag === '-dn' || flag === '-non_shared') {
            staticMode = true;
            return true;
        }
        if (flag === '-Bdynamic' || flag === '--Bdynamic' || flag === '-dy' || flag === '-call_shared') {
            staticMode = false;
            return true;
        }
        return false;
    };
    const emitLibraryToken = (raw) => {
        let token = raw;
        if (staticMode && /^-l/.test(token)) token = `BSTATIC:${token}`;
        if (wholeArchive) token = `WHOLE_ARCHIVE:${token}`;
        result.push(token);
    };
    for (let i = 0; i < tokens.length; i++) {
        const value = tokens[i];
        if (value === '-Xlinker' && i + 1 < tokens.length) {
            const next = tokens[++i];
            if (!applyLinkerFlag(next)) emitLibraryToken(next);
            continue;
        }
        if (value.startsWith('-Xlinker=')) {
            const arg = value.slice('-Xlinker='.length);
            if (!applyLinkerFlag(arg)) emitLibraryToken(arg);
            continue;
        }
        if (value.startsWith('-Wl,')) {
            const parts = value.slice(4).split(',').filter(Boolean);
            for (const part of parts) {
                if (!applyLinkerFlag(part)) emitLibraryToken(part);
            }
            continue;
        }
        if (applyLinkerFlag(value)) continue;
        if (/^-L.+/.test(value)) continue;
        emitLibraryToken(value);
    }
    return result;
}

function resolveLibrary(value, directories, state, systemDirectories, isAndroid = false, preferStatic = false) {
    if (isAndroid) {
        const shortLib = /^-l([A-Za-z0-9_.+-]+)$/.exec(value);
        if (shortLib) {
            const libName = shortLib[1];
            const candidateNames = preferStatic ? [`lib${libName}.a`] : [`lib${libName}.so`, `lib${libName}.a`];
            const searchDirs = [...directories, state.buildDir];
            for (const dir of searchDirs) {
                for (const candidateName of candidateNames) {
                    const candidate = path.resolve(dir, candidateName);
                    if (!present(candidate)) continue;
                    if (systemDirectories.some(sys => within(sys, candidate))) {
                        return { system: libName };
                    }
                    return fileRecord(candidate);
                }
            }
            return { error: `无法定位链接库 ${value}，请使用 CMake target 或准确库路径。` };
        }
    }
    const candidates = path.isAbsolute(value) ? [value] : [path.resolve(state.buildDir, value), ...directories.map(directory => path.resolve(directory, value))];
    const source = candidates.find(present);
    if (!source) return { error: `无法定位链接库 ${value}，请使用 CMake target 或准确库路径。` };
    if (systemDirectories.some(directory => within(directory, source))) {
        const base = path.basename(source);
        return { system: isAndroid ? base.replace(/^lib(.+)\.(?:so|a)$/i, '$1') : base };
    }
    return fileRecord(source);
}

function librarySymbols(state, file, target, flagGroups, isAndroid = false) {
    if (isAndroid || !file.source) return [];
    if (target) {
        if (!flagGroups.some(flags => /^[-/]Z[iI]$/.test(flags.findLast(value => /^[-/]Z[iI7]$/.test(value)) || ''))) return [];
        const metadataFile = path.join(state.buildDir, '.plugin-dev/binary-metadata', state.buildType, `compiled-${target.name}.json`);
        if (!present(metadataFile)) return { error: `静态库 ${target.name} 缺少 compiler PDB 记录，请重新配置并构建。` };
        const metadata = json(metadataFile);
        const compilePdb = metadata.compilePdb && path.resolve(state.buildDir, target.paths.build, metadata.compilePdb);
        if (!compilePdb || !present(compilePdb)) return { error: `静态库 ${target.name} 使用 /Zi 或 /ZI，但 compiler PDB 不存在，请重新构建。` };
        return [fileRecord(compilePdb)];
    }
    return fs.readdirSync(path.dirname(file.source)).filter(name => /\.pdb$/i.test(name)).map(name => fileRecord(path.join(path.dirname(file.source), name)));
}

function snapshotPlugin(state, record, metadata, toolchain, targets) {
    if (metadata.error) return { error: metadata.error };
    const isAndroid = toolchain.systemName === 'Android';
    const target = targets.get(record.target);
    const probe = targets.get(metadata.probe);
    const baseline = targets.get(toolchain.baselineProbe);
    if (!target || !probe || !baseline) return { error: 'CMake 未生成完整插件链接记录，请重新构建。' };
    const groups = tokenize(state, [fragments(probe, 'libraries'), fragments(baseline, 'libraries'), fragments(probe, 'flags'), fragments(baseline, 'flags'), fragments(probe, 'libraryPath'), compileFragments(probe), compileFragments(baseline), ...compileGroups(target)]);
    const [libraries, commonLibraries, flags, commonFlags, searchFlags, publicFlags, commonPublicFlags, ...mainFlagGroups] = groups;
    const defaults = toolchain.libraryDirectories.filter(Boolean).map(directory => path.resolve(directory));
    const systemDirectories = toolchain.systemDirectories.filter(Boolean).map(directory => path.resolve(directory));
    const extraSearchDirs = isAndroid
        ? [...libraries, ...flags].filter(value => /^-L.+/.test(value)).map(value => path.resolve(state.buildDir, value.slice(2)))
        : [];
    const directories = [
        ...searchFlags.map(value => value.replace(/^(?:[-/]LIBPATH:|-L)/i, '')).filter(Boolean).map(directory => path.resolve(state.buildDir, directory)),
        ...extraSearchDirs,
        ...defaults,
    ];
    const links = [];
    let removedMain = false;
    const normalizedLibraries = isAndroid ? parseAndroidLibraryTokens(libraries) : libraries;
    const normalizedCommonLibraries = isAndroid ? parseAndroidLibraryTokens(commonLibraries) : commonLibraries;
    for (const rawValue of difference(normalizedLibraries, normalizedCommonLibraries)) {
        const prefixed = /^([-/]WHOLEARCHIVE:|WHOLE_ARCHIVE:)(.+)$/i.exec(rawValue);
        const rest = prefixed ? prefixed[2] : rawValue;
        const staticPrefixed = isAndroid ? /^BSTATIC:(.+)$/.exec(rest) : null;
        const targetValue = staticPrefixed ? staticPrefixed[1] : rest;
        const library = resolveLibrary(targetValue, directories, state, systemDirectories, isAndroid, Boolean(staticPrefixed));
        if (library.error) return library;
        if (!removedMain && library.source && identity(library.source) === identity(metadata.artifact)) { removedMain = true; continue; }
        links.push(prefixed ? { prefix: prefixed[1], ...library } : library);
    }
    if (!removedMain) return { error: 'CMake 链接记录缺少插件主静态库。' };
    const options = [];
    for (const value of difference(flags, commonFlags)) {
        if (isAndroid && /^-L.+/.test(value)) continue;
        const wholeArchive = /^([-/]WHOLEARCHIVE:)(.+)$/i.exec(value);
        if (wholeArchive) {
            const library = resolveLibrary(wholeArchive[2], directories, state, systemDirectories, isAndroid);
            if (library.error) return library;
            options.push({ prefix: wholeArchive[1], ...library });
        } else if (/^[-/](?:DEF|MANIFESTINPUT|ORDER|PDB|PDBALTPATH|IMPLIB|OUT|PGD|WINMDINPUT|NATVIS|LIBPATH):/i.test(value) || /[A-Za-z]:[\\/]|\\\\|\$</.test(value)) {
            return { error: `链接选项包含无法发布的本机路径或表达式: ${value}` };
        } else options.push({ value });
    }
    let runtime = null;
    if (!isAndroid) {
        const runtimes = [...new Set(mainFlagGroups.map(values => values.findLast(value => /^[-/]M[DT]d?$/.test(value))?.slice(1)))];
        if (runtimes.length !== 1 || !runtimes[0]) return { error: '无法确定插件统一的 MSVC runtime 配置。' };
        runtime = runtimes[0];
    }
    const exportedOptions = difference(publicFlags, commonPublicFlags);
    const exportedDefinitions = difference(definitions(probe), definitions(baseline)).filter(value => value !== `${metadata.probe}_EXPORTS`);
    for (const value of [...exportedOptions, ...exportedDefinitions]) {
        if (/[A-Za-z]:[\\/]|(?:^|[="'])[/\\]{2}[^/\\]+[/\\]|\$</.test(value)) return { error: `公开编译设置包含无法发布的本机路径或表达式: ${value}` };
    }
    const publicRoots = [
        ['native/include', 'plugin'],
        ['native/windows/include', 'windows'],
        ['native/android/include', 'android'],
        ['native/third_party/include', 'third_party'],
    ];
    const includePaths = targetData => (targetData.compileGroups || []).flatMap(group => (group.includes || []).map(item => item.path));
    const includeDirectories = [];
    for (const directory of difference(includePaths(probe), includePaths(baseline))) {
        const mapped = publicRoots.find(([relative]) => within(path.join(record.sourcePath, relative), directory));
        if (!mapped) return { error: `公开 include 目录未包含在发布头文件目录中: ${directory}` };
        const relative = slash(path.relative(path.join(record.sourcePath, mapped[0]), directory));
        includeDirectories.push(`lib/include/${mapped[1]}${relative ? `/${relative}` : ''}`);
    }
    const dependencySources = new Set([...links, ...options].filter(item => item.source).map(item => identity(item.source)));
    const dependencyTargets = [...targets.values()].filter(item => item.type === 'STATIC_LIBRARY' && (item.artifacts || []).some(artifact => dependencySources.has(identity(path.resolve(state.buildDir, artifact.path)))));
    const dependencyFragments = dependencyTargets.map(compileGroups);
    const dependencyTokens = dependencyTargets.length ? tokenize(state, dependencyFragments.flat()) : [];
    let groupOffset = 0;
    const dependencyFlagGroups = dependencyFragments.map(group => {
        const values = dependencyTokens.slice(groupOffset, groupOffset + group.length);
        groupOffset += group.length;
        return values;
    });
    const artifact = fileRecord(metadata.artifact);
    artifact.symbols = librarySymbols(state, artifact, target, mainFlagGroups, isAndroid);
    if (artifact.symbols.error) return artifact.symbols;
    for (const file of [...links, ...options]) {
        if (!file.source) continue;
        const index = dependencyTargets.findIndex(item => (item.artifacts || []).some(itemArtifact => identity(path.resolve(state.buildDir, itemArtifact.path)) === identity(file.source)));
        file.symbols = librarySymbols(state, file, dependencyTargets[index], dependencyFlagGroups[index], isAndroid);
        if (file.symbols.error) return file.symbols;
    }
    const runtimeFiles = isAndroid ? [] : difference((metadata.runtimeDlls || []).filter(Boolean), (toolchain.runtimeDlls || []).filter(Boolean)).map(source => ({ ...fileRecord(source), target: path.basename(source) }));
    const interproceduralOptimization = isAndroid
        ? [...mainFlagGroups, ...dependencyFlagGroups.flat()].some(values => /^-flto(?:=|$)/.test(values.findLast(value => /^-(?:fno-lto|flto(?:=.*)?)$/.test(value)) || '')) || flags.some(value => /^-flto(?:=|$)/.test(value))
        : [...mainFlagGroups, ...dependencyFlagGroups.flat()].some(values => /^[-/]GL$/i.test(values.findLast(value => /^[-/]GL-?$/i.test(value)) || '')) || flags.some(value => /^[-/]LTCG(?::|$)/i.test(value));
    return {
        artifact,
        links,
        options,
        runtimeFiles,
        ...(isAndroid ? { androidStl: toolchain.androidStl || state.androidStl || 'c++_static' } : { runtime }),
        symbolsVersion: 1,
        compileOptions: exportedOptions,
        compileDefinitions: exportedDefinitions,
        includeDirectories,
        interproceduralOptimization,
    };
}

function recordBinaryBuild(state, records) {
    const directory = path.join(state.buildDir, '.plugin-dev/binary-metadata', state.buildType);
    const toolchainFile = path.join(directory, 'toolchain.json');
    const proof = { schemaVersion: 1, builtAt: state.builtAt, buildType: state.buildType, plugins: {} };
    if (!present(toolchainFile)) {
        proof.error = 'CMake 未生成二进制发布元数据，请重新配置并构建宿主。';
    } else {
        proof.toolchain = json(toolchainFile);
        proof.engineVersion = json(path.join(state.enginePath, 'package.json')).version;
        const targets = readTargets(state);
        for (const [name, record] of Object.entries(records)) {
            if (!record.enabled || record.detached || !record.target) continue;
            const file = path.join(directory, `${record.target}.json`);
            proof.plugins[name] = { target: record.target, sourcePath: record.sourcePath, nativeFingerprint: record.nativeFingerprint,
                ...(present(file) ? snapshotPlugin(state, record, json(file), proof.toolchain, targets) : { error: 'CMake 未登记该插件的二进制产物。' }) };
        }
    }
    support.noLinks(state.projectPath, proofPath(state.projectPath));
    support.writeJson(proofPath(state.projectPath), proof);
}

function recordAndroidBinaryBuild(state, records) {
    const abi = state.abi || 'arm64-v8a';
    const directory = path.join(state.buildDir, '.plugin-dev/binary-metadata', state.buildType);
    const toolchainFile = path.join(directory, 'toolchain.json');
    const proof = {
        schemaVersion: 1,
        platform: 'android',
        abi,
        builtAt: state.builtAt,
        buildType: state.buildType,
        ndkVersion: state.ndkVersion,
        androidPlatform: state.androidPlatform,
        androidStl: state.androidStl,
        plugins: {},
    };
    if (!present(toolchainFile)) {
        proof.error = 'CMake 未生成 Android 二进制发布元数据，请重新配置并构建。';
    } else {
        proof.toolchain = json(toolchainFile);
        proof.engineVersion = json(path.join(state.enginePath, 'package.json')).version;
        const targets = readTargets(state);
        for (const [name, record] of Object.entries(records)) {
            if (!record.enabled || record.detached || !record.target) continue;
            const file = path.join(directory, `${record.target}.json`);
            proof.plugins[name] = {
                target: record.target,
                sourcePath: record.sourcePath,
                nativeFingerprint: record.nativeFingerprint,
                ...(present(file) ? snapshotPlugin(state, record, json(file), proof.toolchain, targets) : { error: 'CMake 未登记该插件的 Android 二进制产物。' }),
            };
        }
    }
    const targetProofFile = androidProofPath(state.projectPath, abi);
    support.noLinks(state.projectPath, targetProofFile);
    support.writeJson(targetProofFile, proof);
}

function cmakeString(value) {
    if (/[\r\n\x00;]/.test(value)) throw new Error(`CMake 发布值包含不支持的字符: ${value}`);
    return `"${value.replace(/\\/g, '\\\\').replace(/\$/g, '\\$').replace(/"/g, '\\"')}"`;
}

function importedCmake({ target, buildType, toolchain, snapshot, artifact, linkItems, options, includeDirectories, engineVersion }) {
    const local = relative => `"\${CMAKE_CURRENT_LIST_DIR}/${relative}"`;
    const runtimeNames = { MD: 'MultiThreadedDLL', MDd: 'MultiThreadedDebugDLL', MT: 'MultiThreaded', MTd: 'MultiThreadedDebug' };
    const compatibility = toolchain.compilerId === 'MSVC' && !snapshot.interproceduralOptimization
        ? `if(CMAKE_CXX_COMPILER_VERSION VERSION_LESS "${toolchain.compilerVersion}" OR NOT CMAKE_CXX_COMPILER_VERSION VERSION_LESS "20")`
        : `if(NOT CMAKE_CXX_COMPILER_VERSION VERSION_EQUAL "${toolchain.compilerVersion}")`;
    const values = items => items.map(item => {
        const location = item.relative ? `\${CMAKE_CURRENT_LIST_DIR}/${item.relative}` : item.system || item.value;
        if (item.prefix) return `"$<LINK_LIBRARY:WHOLE_ARCHIVE,${location}>"`;
        return item.relative ? local(item.relative) : cmakeString(location);
    }).join(' ');
    const content = [
        '# 由 cocos-plugin-dev 生成的二进制插件入口。',
        'if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)',
        '    message(FATAL_ERROR "二进制插件要求 Windows x64")', 'endif()',
        `if(NOT CMAKE_CXX_COMPILER_ID STREQUAL "${toolchain.compilerId}" OR NOT CMAKE_CXX_COMPILER_ARCHITECTURE_ID STREQUAL "${toolchain.architecture}")`,
        '    message(FATAL_ERROR "二进制插件的编译器或架构不匹配")', 'endif()',
        compatibility, '    message(FATAL_ERROR "二进制插件的编译器版本不兼容")', 'endif()',
        'if(NOT EXISTS "${COCOS_X_PATH}/../package.json")',
        '    message(FATAL_ERROR "二进制插件需要 Cocos 引擎的 package.json")', 'endif()',
        'file(READ "${COCOS_X_PATH}/../package.json" cpd_binary_engine_package)',
        'string(JSON cpd_binary_engine_version GET "${cpd_binary_engine_package}" version)',
        `if(NOT cpd_binary_engine_version STREQUAL "${engineVersion}")`,
        '    message(FATAL_ERROR "二进制插件要求相同的 Cocos 引擎版本")', 'endif()',
        `if(TARGET ${target})`, '    return()', 'endif()',
        `add_library(${target} STATIC IMPORTED GLOBAL)`,
        `set_target_properties(${target} PROPERTIES IMPORTED_LOCATION ${local(artifact)})`,
        `target_link_libraries(${target} INTERFACE \${ENGINE_NAME}${linkItems.length ? ` ${values(linkItems)}` : ''})`,
    ];
    if (options.length) content.push(`target_link_options(${target} INTERFACE ${options.map(item => item.relative ? `"${item.prefix}\${CMAKE_CURRENT_LIST_DIR}/${item.relative}"` : cmakeString(item.value || `${item.prefix}${item.system}`)).join(' ')})`);
    if (includeDirectories.length) content.push(`target_include_directories(${target} INTERFACE ${includeDirectories.map(local).join(' ')})`);
    if (snapshot.compileOptions.length) content.push(`target_compile_options(${target} INTERFACE ${snapshot.compileOptions.map(cmakeString).join(' ')})`);
    if (snapshot.compileDefinitions.length) content.push(`target_compile_definitions(${target} INTERFACE ${snapshot.compileDefinitions.map(cmakeString).join(' ')})`);
    content.push(
        'set(cpd_binary_runtime "${CMAKE_MSVC_RUNTIME_LIBRARY}")',
        'if(NOT cpd_binary_runtime)', '    set(cpd_binary_runtime "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")', 'endif()',
        `set(cpd_binary_check "\${CMAKE_CURRENT_BINARY_DIR}/${target}-binary-check-$<CONFIG>.cmake")`,
        'file(GENERATE OUTPUT "${cpd_binary_check}" CONTENT',
        `    "if(NOT \\\"$<CONFIG>\\\" STREQUAL \\\"${buildType}\\\")\\n    message(FATAL_ERROR \\\"二进制插件要求 ${buildType} 构建配置\\\")\\nendif()\\nif(NOT \\\"\${cpd_binary_runtime}\\\" STREQUAL \\\"${runtimeNames[snapshot.runtime]}\\\")\\n    message(FATAL_ERROR \\\"二进制插件的 MSVC runtime 不匹配\\\")\\nendif()\\n")`,
        `add_custom_target(${target}_binary_check COMMAND "\${CMAKE_COMMAND}" -P "\${cpd_binary_check}" VERBATIM)`,
        `add_dependencies(${target} ${target}_binary_check)`, '',
    );
    return content.join('\n');
}

function importedAndroidCmake({ target, abi, buildType, toolchain, snapshot, artifact, linkItems, options, includeDirectories, engineVersion }) {
    const local = relative => `"\${CMAKE_CURRENT_LIST_DIR}/${relative}"`;
    const androidStl = snapshot.androidStl || toolchain.androidStl || 'c++_static';
    const values = items => items.map(item => {
        const location = item.relative ? `\${CMAKE_CURRENT_LIST_DIR}/${item.relative}` : item.system || item.value;
        if (item.prefix) return `"$<LINK_LIBRARY:WHOLE_ARCHIVE,${location}>"`;
        return item.relative ? local(item.relative) : cmakeString(location);
    }).join(' ');
    const content = [
        '# 由 cocos-plugin-dev 生成的 Android 二进制插件入口。',
        'if(NOT ANDROID)',
        '    message(FATAL_ERROR "二进制插件要求 Android 平台")', 'endif()',
        `if(NOT ANDROID_ABI STREQUAL "${abi}")`,
        `    message(FATAL_ERROR "二进制插件要求 Android ABI ${abi}")`, 'endif()',
        `if(NOT CMAKE_CXX_COMPILER_ID STREQUAL "${toolchain.compilerId}")`,
        '    message(FATAL_ERROR "二进制插件的编译器不匹配")', 'endif()',
        ...(snapshot.interproceduralOptimization
            ? [`if(NOT CMAKE_CXX_COMPILER_VERSION VERSION_EQUAL "${toolchain.compilerVersion}")`, '    message(FATAL_ERROR "启用 LTO 的二进制插件要求完全相同的编译器版本")', 'endif()']
            : []),
        `if(ANDROID_STL AND NOT ANDROID_STL STREQUAL "${androidStl}")`,
        `    message(FATAL_ERROR "二进制插件要求 ANDROID_STL=${androidStl}")`, 'endif()',
        'if(NOT EXISTS "${COCOS_X_PATH}/../package.json")',
        '    message(FATAL_ERROR "二进制插件需要 Cocos 引擎的 package.json")', 'endif()',
        'file(READ "${COCOS_X_PATH}/../package.json" cpd_binary_engine_package)',
        'string(JSON cpd_binary_engine_version GET "${cpd_binary_engine_package}" version)',
        `if(NOT cpd_binary_engine_version STREQUAL "${engineVersion}")`,
        '    message(FATAL_ERROR "二进制插件要求相同的 Cocos 引擎版本")', 'endif()',
        `if(TARGET ${target})`, '    return()', 'endif()',
        `add_library(${target} STATIC IMPORTED GLOBAL)`,
        `set_target_properties(${target} PROPERTIES IMPORTED_LOCATION ${local(artifact)})`,
        `target_link_libraries(${target} INTERFACE \${ENGINE_NAME}${linkItems.length ? ` ${values(linkItems)}` : ''})`,
    ];
    if (options.length) content.push(`target_link_options(${target} INTERFACE ${options.map(item => item.relative ? `"${item.prefix}\${CMAKE_CURRENT_LIST_DIR}/${item.relative}"` : cmakeString(item.value || `${item.prefix}${item.system}`)).join(' ')})`);
    if (includeDirectories.length) content.push(`target_include_directories(${target} INTERFACE ${includeDirectories.map(local).join(' ')})`);
    if (snapshot.compileOptions.length) content.push(`target_compile_options(${target} INTERFACE ${snapshot.compileOptions.map(cmakeString).join(' ')})`);
    if (snapshot.compileDefinitions.length) content.push(`target_compile_definitions(${target} INTERFACE ${snapshot.compileDefinitions.map(cmakeString).join(' ')})`);
    content.push(
        `set(cpd_binary_check "\${CMAKE_CURRENT_BINARY_DIR}/${target}-binary-check-$<CONFIG>.cmake")`,
        'file(GENERATE OUTPUT "${cpd_binary_check}" CONTENT',
        `    "if(NOT \\\"$<CONFIG>\\\" STREQUAL \\\"${buildType}\\\")\\n    message(FATAL_ERROR \\\"二进制插件要求 ${buildType} 构建配置\\\")\\nendif()\\n")`,
        `add_custom_target(${target}_binary_check COMMAND "\${CMAKE_COMMAND}" -P "\${cpd_binary_check}" VERBATIM)`,
        `add_dependencies(${target} ${target}_binary_check)`, '',
    );
    return content.join('\n');
}

function readAndroidBinaryArtifacts({ projectPath, name, buildType, abi, includeDirectories = [] }) {
    const android = require('./android.cjs');
    buildType = android._internal.normalizeBuildType(buildType);
    const project = path.resolve(projectPath);
    const stateFile = path.join(project, '.plugin-dev/android.json');
    support.noLinks(project, stateFile);
    if (!present(stateFile)) throw new Error('请先成功构建 Android 插件后再导出 Android 二进制包。');
    const state = json(stateFile);
    const resolvedAbi = android._internal.normalizeAbi(abi) || android._internal.normalizeAbi(state.abi) || android.DEFAULT_ABI;
    const proofFile = androidProofPath(project, resolvedAbi);
    support.noLinks(project, proofFile);
    if (!present(proofFile)) throw new Error(`请先成功构建 Android (${resolvedAbi}) 插件后再导出二进制包。`);
    const proof = json(proofFile);
    const abiState = (state.abis && state.abis[resolvedAbi]) || (state.abi === resolvedAbi ? state : {});
    if (proof.error) throw new Error(proof.error);
    if (!abiState.builtAt || proof.builtAt !== abiState.builtAt || proof.buildType !== abiState.buildType) {
        throw new Error(`Android (${resolvedAbi}) 二进制产物记录与当前构建状态不匹配，请重新构建。`);
    }
    if (buildType && buildType !== proof.buildType) {
        throw new Error(`最近成功构建配置为 ${proof.buildType}，请构建 ${buildType} 后导出。`);
    }
    const snapshot = proof.plugins[name];
    if (!snapshot) throw new Error(`最近 Android (${resolvedAbi}) 构建没有启用插件 ${name}。`);
    if (snapshot.error) throw new Error(`插件 ${name} 无法导出 Android 二进制包: ${snapshot.error}`);
    if (!Array.isArray(snapshot.includeDirectories)) throw new Error('Android 二进制构建记录缺少公开头文件信息，请重新构建。');
    const record = support.readState(project).plugins[name];
    if (!record || !record.enabled || record.detached || identity(record.sourcePath) !== identity(snapshot.sourcePath)
        || record.target !== snapshot.target || record.nativeFingerprint !== snapshot.nativeFingerprint
        || support.nativeFingerprint(record.sourcePath) !== snapshot.nativeFingerprint) {
        throw new Error(`插件 ${name} 已发生变化，请重新构建 Android (${resolvedAbi}) 后导出。`);
    }
    if (proof.toolchain.systemName !== 'Android' || (proof.toolchain.androidAbi && proof.toolchain.androidAbi !== resolvedAbi)) {
        throw new Error(`二进制发布要求 Android (${resolvedAbi}) 构建产物。`);
    }
    const files = new Map();
    const register = (file, main = false) => {
        if (!file.source) return file;
        const checked = fileRecord(file.source);
        if (checked.sha256 !== file.sha256) throw new Error(`构建产物已发生变化，请重新构建: ${file.source}`);
        const existing = files.get(identity(file.source));
        if (existing) return { ...file, relative: existing.relative };
        const relative = main
            ? `${resolvedAbi}/lib/${path.basename(file.source)}`
            : `${resolvedAbi}/lib/dependencies/${file.sha256.slice(0, 16)}/${path.basename(file.source)}`;
        files.set(identity(file.source), { ...checked, relative, packagePath: `native/android/${relative}` });
        return { ...file, relative };
    };
    const artifact = register(snapshot.artifact, true);
    const links = snapshot.links.map(file => register(file));
    const options = snapshot.options.map(file => register(file));
    for (const directory of includeDirectories) support.normalizeRelTarget(directory);
    const effectiveIncludes = [...new Set([...includeDirectories, ...snapshot.includeDirectories])];
    const toolchain = proof.toolchain;
    const manifest = {
        schemaVersion: 1,
        platform: 'android',
        abi: resolvedAbi,
        architecture: resolvedAbi,
        androidPlatform: proof.androidPlatform || toolchain.androidPlatform || 'android-21',
        androidStl: snapshot.androidStl || proof.androidStl || toolchain.androidStl || 'c++_static',
        ndkVersion: proof.ndkVersion || toolchain.ndkVersion || '',
        buildType: proof.buildType,
        engineVersion: proof.engineVersion,
        target: snapshot.target,
        compiler: {
            id: toolchain.compilerId,
            version: toolchain.compilerVersion,
            frontendVariant: toolchain.frontendVariant,
        },
        interproceduralOptimization: snapshot.interproceduralOptimization,
        compileOptions: snapshot.compileOptions,
        compileDefinitions: snapshot.compileDefinitions,
        systemLibraries: links.filter(item => item.system).map(item => item.system),
        files: Object.fromEntries([...files.values()].map(file => [file.packagePath, file.sha256])),
    };
    const cmake = importedAndroidCmake({
        target: snapshot.target,
        abi: resolvedAbi,
        buildType: proof.buildType,
        toolchain,
        snapshot,
        artifact: artifact.relative,
        linkItems: links,
        options,
        includeDirectories: effectiveIncludes,
        engineVersion: proof.engineVersion,
    });
    return {
        platform: 'android',
        abi: resolvedAbi,
        files: [...files.values()].map(({ relative, ...file }) => file),
        cmake,
        buildType: proof.buildType,
        manifest,
        runtimeFiles: [],
    };
}

function readBinaryArtifacts({ projectPath, name, buildType, platform = 'windows', abi, includeDirectories = [] }) {
    if (platform === 'android') {
        return readAndroidBinaryArtifacts({ projectPath, name, buildType, abi, includeDirectories });
    }
    buildType = require('./windows.cjs')._internal.normalizeBuildType(buildType);
    const project = path.resolve(projectPath);
    support.noLinks(project, proofPath(project));
    if (!present(proofPath(project))) throw new Error('请成功构建 Windows 宿主后导出二进制插件。');
    const proof = json(proofPath(project));
    const state = json(path.join(project, '.plugin-dev/windows.json'));
    if (proof.error) throw new Error(proof.error);
    if (!state.builtAt || proof.builtAt !== state.builtAt || proof.buildType !== state.buildType) throw new Error('二进制产物记录与当前构建状态不匹配，请重新构建。');
    if (buildType && buildType !== proof.buildType) throw new Error(`最近成功构建配置为 ${proof.buildType}，请构建 ${buildType} 后导出。`);
    const snapshot = proof.plugins[name];
    if (!snapshot) throw new Error(`最近构建没有启用插件 ${name}。`);
    if (snapshot.error) throw new Error(`插件 ${name} 无法导出二进制包: ${snapshot.error}`);
    if (!Array.isArray(snapshot.includeDirectories)) throw new Error('二进制构建记录缺少公开头文件信息，请重新构建。');
    if (snapshot.symbolsVersion !== 1) throw new Error('二进制构建记录缺少 compiler PDB 信息，请重新构建。');
    const record = support.readState(project).plugins[name];
    if (!record || !record.enabled || record.detached || identity(record.sourcePath) !== identity(snapshot.sourcePath) || record.target !== snapshot.target || record.nativeFingerprint !== snapshot.nativeFingerprint || support.nativeFingerprint(record.sourcePath) !== snapshot.nativeFingerprint) throw new Error(`插件 ${name} 已发生变化，请重新构建后导出。`);
    if (proof.toolchain.systemName !== 'Windows' || proof.toolchain.pointerSize !== 8 || !/^x64$/i.test(proof.toolchain.architecture)) throw new Error('二进制发布要求 Windows x64 构建产物。');
    const files = new Map();
    const symbolFiles = new Map();
    const register = (file, main = false) => {
        if (!file.source) return file;
        const checked = fileRecord(file.source);
        if (checked.sha256 !== file.sha256) throw new Error(`构建产物已发生变化，请重新构建: ${file.source}`);
        const existing = files.get(identity(file.source));
        if (existing) return { ...file, relative: existing.relative };
        const relative = main ? `lib/${path.basename(file.source)}` : `lib/dependencies/${file.sha256.slice(0, 16)}/${path.basename(file.source)}`;
        files.set(identity(file.source), { ...checked, relative, packagePath: `native/windows/${relative}` });
        for (const symbol of file.symbols) {
            const checkedSymbol = fileRecord(symbol.source);
            if (checkedSymbol.sha256 !== symbol.sha256) throw new Error(`compiler PDB 已发生变化，请重新构建: ${symbol.source}`);
            const packagePath = `native/windows/${path.posix.dirname(relative)}/${path.basename(symbol.source)}`;
            const previous = symbolFiles.get(identity(packagePath));
            if (previous && previous.sha256 !== symbol.sha256) throw new Error(`compiler PDB 发布路径冲突: ${packagePath}`);
            symbolFiles.set(identity(packagePath), { ...checkedSymbol, packagePath });
        }
        return { ...file, relative };
    };
    const artifact = register(snapshot.artifact, true);
    const links = snapshot.links.map(file => register(file));
    const options = snapshot.options.map(file => register(file));
    const runtimeFiles = snapshot.runtimeFiles.map(file => {
        if (fileRecord(file.source).sha256 !== file.sha256) throw new Error(`运行时 DLL 已发生变化，请重新构建: ${file.source}`);
        return file;
    });
    for (const directory of includeDirectories) support.normalizeRelTarget(directory);
    const effectiveIncludes = [...new Set([...includeDirectories, ...snapshot.includeDirectories])];
    const toolchain = proof.toolchain;
    const manifest = { schemaVersion: 1, platform: 'windows', architecture: 'x64', buildType: proof.buildType, engineVersion: proof.engineVersion, target: snapshot.target,
        compiler: { id: toolchain.compilerId, version: toolchain.compilerVersion, frontendVariant: toolchain.frontendVariant, cmakeMsvcToolset: toolchain.msvcToolset },
        msvcRuntime: snapshot.runtime, interproceduralOptimization: snapshot.interproceduralOptimization,
        compileOptions: snapshot.compileOptions, compileDefinitions: snapshot.compileDefinitions,
        systemLibraries: links.filter(item => item.system).map(item => item.system),
        files: Object.fromEntries([...files.values(), ...symbolFiles.values()].map(file => [file.packagePath, file.sha256])) };
    const cmake = importedCmake({ target: snapshot.target, buildType: proof.buildType, toolchain, snapshot, artifact: artifact.relative, linkItems: links, options, includeDirectories: effectiveIncludes, engineVersion: proof.engineVersion });
    return { platform: 'windows', files: [...files.values(), ...symbolFiles.values()].map(({ relative, ...file }) => file), cmake, buildType: proof.buildType, manifest, runtimeFiles };
}

module.exports = {
    recordBinaryBuild,
    recordAndroidBinaryBuild,
    readBinaryArtifacts,
    _internal: {
        parseAndroidLibraryTokens,
        resolveLibrary,
        importedAndroidCmake,
    },
};
