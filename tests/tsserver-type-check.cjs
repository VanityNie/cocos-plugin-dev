'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const [root, packageRoot, sourceFile] = process.argv.slice(2);
const ts = require(path.join(packageRoot, 'lib', 'typescript.js'));
const logFile = path.join(root, 'tsserver.log');
const log = value => fs.appendFileSync(logFile, `${value}\n`);
const service = new ts.server.ProjectService({
    host: {
        ...ts.sys, setImmediate, clearImmediate,
        require(initialPath, moduleName) { return { module: createRequire(path.join(initialPath, 'loader.cjs'))(moduleName), error: undefined }; },
    },
    logger: {
        close() { log('close'); }, hasLevel: () => true, loggingEnabled: () => true,
        perftrc: log, info: log, startGroup() { log('startGroup'); }, endGroup() { log('endGroup'); }, msg: log,
        getLogFileName: () => logFile,
    },
    cancellationToken: ts.server.nullCancellationToken,
    useSingleInferredProject: false,
    useInferredProjectPerProjectRoot: true,
    typingsInstaller: ts.server.nullTypingsInstaller,
    pluginProbeLocations: [],
    allowLocalPluginLoads: false,
    session: undefined,
});
service.openClientFile(sourceFile, undefined, undefined, path.dirname(path.dirname(sourceFile)));
const project = service.getDefaultProjectForFile(ts.server.toNormalizedPath(sourceFile), true);
const language = project.getLanguageService();
const source = fs.readFileSync(sourceFile, 'utf8');
const result = {
    typescriptVersion: ts.version,
    projectName: project.getProjectName(),
    diagnostics: language.getSemanticDiagnostics(sourceFile).map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
    definitions: language.getDefinitionAtPosition(sourceFile, source.indexOf('Component') + 1),
    files: language.getProgram().getSourceFiles().map(file => file.fileName),
};
process.stdout.write(JSON.stringify(result), () => process.exit(0));
