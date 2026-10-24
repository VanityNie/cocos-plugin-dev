'use strict';

const fs = require('node:fs');
const path = require('node:path');

const slash = (value) => value.replace(/\\/g, '/');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function normalizeIDE(value = 'vscode') {
    if (!['vscode', 'visual-studio'].includes(value)) throw new Error(`Unsupported IDE: ${value}. Use vscode or visual-studio.`);
    return value;
}

function developerEnvironment(environment = {}) {
    // Capture compiler search paths, never the editor's full environment (which
    // can contain unrelated credentials). These are local, ignored IDE files.
    const keys = new Set(['path', 'include', 'lib', 'libpath', 'windowssdkdir', 'windowssdkversion',
        'vcinstalldir', 'vctoolsinstalldir', 'vctoolsversion', 'vsinstalldir', 'vslang', 'ucrtversion', 'universalcrtsdkdir']);
    return Object.fromEntries(Object.entries(environment).filter(([key]) => keys.has(key.toLowerCase())));
}

function vscodeIntegration(state, environment = {}, configureArguments = []) {
    const buildDir = state.buildDir || path.join(state.projectPath, '.plugin-dev/build/windows');
    const buildType = state.buildType || 'Debug';
    const settings = {
        'cmake.configureOnOpen': false,
        'cmake.buildBeforeRun': false,
        'cmake.useCMakePresets': 'never',
        'cmake.generator': 'Ninja',
        'cmake.buildDirectory': slash(buildDir),
        'cmake.defaultVariants': { buildType: { default: buildType,
            choices: { [buildType]: { short: buildType, long: 'Current plugin development host configuration', buildType } } } },
        'clangd.arguments': [`--compile-commands-dir=${slash(buildDir)}`, '--background-index'],
        'C_Cpp.intelliSenseEngine': 'disabled',
    };
    if (state.nativeSourceDir) settings['cmake.sourceDirectory'] = slash(state.nativeSourceDir);
    if (state.tools?.cmake) settings['cmake.cmakePath'] = state.tools.cmake;
    if (state.tools?.clangd) settings['clangd.path'] = state.tools.clangd;
    // -S/-B/-G belong to the corresponding extension settings. Preserve every
    // explicit -D option from the same configure command the workbench uses.
    if (configureArguments.length) settings['cmake.configureArgs'] = configureArguments.filter((value) => value.startsWith('-D'));
    const compilerEnvironment = developerEnvironment(environment);
    if (Object.keys(compilerEnvironment).length) {
        settings['cmake.configureEnvironment'] = compilerEnvironment;
        settings['cmake.buildEnvironment'] = compilerEnvironment;
    }
    return { settings, extensions: { recommendations: ['ms-vscode.cmake-tools', 'llvm-vs-code-extensions.vscode-clangd', 'ms-vscode.cpptools'] } };
}

async function selectVisualStudioCMake(tools, execute, options) {
    if (!tools.vswhere || !tools.vsDevCmd) throw new Error('Visual Studio C++ x64 tools and vswhere are required to generate a solution.');
    const installationPath = path.resolve(path.dirname(tools.vsDevCmd), '../..');
    const result = await execute(tools.vswhere, ['-all', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json'], options);
    const instance = JSON.parse(result.output).find((item) => samePath(item.installationPath, installationPath));
    if (!instance) throw new Error(`Selected Visual Studio installation was not returned by vswhere: ${installationPath}`);
    const major = Number(instance.installationVersion.split('.')[0]);
    const bundled = path.join(installationPath, 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe');
    const candidates = [...new Set([bundled, tools.cmake].filter((file) => file && fs.existsSync(file)))];
    const checked = [];
    for (const cmakePath of candidates) {
        const capabilities = JSON.parse((await execute(cmakePath, ['-E', 'capabilities'], options)).output);
        const generator = capabilities.generators.find((item) => new RegExp(`^Visual Studio ${major} `).test(item.name));
        checked.push(`${cmakePath} (${capabilities.version.string})`);
        // CMake's VS 2026 generator writes SLNX; VS 2022 and earlier write SLN.
        // The format is determined by that generator, not a user cache option.
        if (generator) return { cmakePath, generator: generator.name, installationPath, solutionExtension: major >= 18 ? '.slnx' : '.sln' };
    }
    throw new Error(`No installed CMake supports Visual Studio ${major}. Checked: ${checked.join(', ') || 'none'}. Install the CMake tools component for this Visual Studio installation.`);
}

function visualStudioArguments(state, selected, buildDir) {
    const buildType = state.buildType || 'Debug';
    if (!['Debug', 'RelWithDebInfo', 'Release'].includes(buildType)) throw new Error(`Unsupported buildType: ${buildType}`);
    const args = ['-S', state.nativeSourceDir, '-B', buildDir, '-G', selected.generator, '-A', 'x64',
        `-DCMAKE_GENERATOR_INSTANCE:PATH=${slash(selected.installationPath)}`,
        // The host resource/debug settings are produced for one configuration.
        // Do not expose configurations with a mismatched Inspector or runtime.
        `-DCMAKE_CONFIGURATION_TYPES:STRING=${buildType}`, `-DCMAKE_BUILD_TYPE:STRING=${buildType}`,
        `-DRES_DIR:PATH=${slash(state.resourceDir)}`, `-DCOCOS_X_PATH:PATH=${slash(path.join(state.enginePath, 'native'))}`,
        `-DNODE_EXECUTABLE:FILEPATH=${slash(state.tools.node)}`, '-DUSE_PLUGINS:BOOL=ON',
        `-DUSE_V8_DEBUGGER:BOOL=${buildType === 'Release' ? 'OFF' : 'ON'}`,
        `-DUSE_V8_DEBUGGER_FORCE:BOOL=${buildType === 'RelWithDebInfo' ? 'ON' : 'OFF'}`,
        `-DCMAKE_PROJECT_INCLUDE:FILEPATH=${slash(path.join(__dirname, 'cmake/ide-visual-studio.cmake'))}`];
    if (state.compiler === 'clang-cl') args.push('-T', 'ClangCL');
    return args;
}

async function generateVisualStudioSolution(state, { execute, env, onOutput, signal }) {
    const projectPath = state.projectPath;
    for (const key of ['nativeSourceDir', 'resourceDir', 'enginePath']) {
        if (!state[key]) throw new Error(`Cannot generate Visual Studio solution without ${key}; prepare the Windows development host first.`);
    }
    if (!state.tools?.node) throw new Error('Node.js is required to generate the Visual Studio plugin registry.');
    const options = { cwd: projectPath, env, signal };
    const selected = await selectVisualStudioCMake(state.tools, execute, options);
    const buildDir = path.join(projectPath, '.plugin-dev/build/visual-studio');
    const query = path.join(buildDir, '.cmake/api/v1/query/codemodel-v2');
    fs.mkdirSync(path.dirname(query), { recursive: true });
    fs.writeFileSync(query, '');
    const logPath = path.join(projectPath, '.plugin-dev/logs/visual-studio-configure.log');
    if (onOutput) onOutput(`Generating ${selected.generator} (${state.buildType || 'Debug'}).\nBuild: ${buildDir}\nLog: ${logPath}\n`);
    await execute(selected.cmakePath, visualStudioArguments(state, selected, buildDir), { ...options, onOutput, logPath });
    const solutions = fs.readdirSync(buildDir).filter((name) => name.endsWith(selected.solutionExtension));
    if (solutions.length !== 1) throw new Error(`Expected one Visual Studio solution in ${buildDir}; found ${solutions.length}.`);
    const solutionPath = path.join(buildDir, solutions[0]);
    return { ide: 'visual-studio', workspacePath: solutionPath, solutionPath, buildDir,
        cmakePath: selected.cmakePath, generator: selected.generator, solutionFormat: selected.solutionExtension, buildType: state.buildType || 'Debug' };
}

module.exports = { normalizeIDE, vscodeIntegration, generateVisualStudioSolution,
    _internal: { developerEnvironment, selectVisualStudioCMake, visualStudioArguments } };
