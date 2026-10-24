# {{DISPLAY_NAME}}

TS + C++ 插件，模板：`{{TEMPLATE}}`，目标平台：Windows。

## 开发

1. 在工作台选择游戏宿主，关联此源码目录；内嵌安装的插件直接启用扩展。
2. 编辑 `runtime/` 中的 TS 和 `native/src/` 中的 C++。编辑器入口会将运行时源码同步到宿主 `assets/__plugin_dev/{{NAME}}/`，并保留已有 `.meta` UUID；请勿直接编辑该副本。
3. 在插件开发面板点击“构建并运行”。工作台自动生成测试场景并挂载 `{{CLASS}}Probe`，准备资源、编译并启动 Windows 宿主。原生注册检查通过后，示例数值接口应返回 `42`。
4. 选择 VS Code（CMake / clangd）或 Visual Studio（2022 为 `.sln`，2026 为 `.slnx`），打开该宿主的开发工作区。VS Code 支持 TS 与 C++ 断点；Visual Studio 用于 C++ 开发。可在 `{{CLASS}}Probe.start` 和 `{{CLASS}}Bridge::add` 设置断点，TS 源码断点依赖正确的 source map。

浏览器预览使用 JavaScript 回退，此时 `available === false`。Windows 日志中的 `native=true` 和 `C++ bridge ready` 表示实际进入了原生插件。

原生清单、CMake target 和 `CC_PLUGIN_ENTRY` 统一使用 `{{TARGET}}`。Creator 构建会扫描项目的 `extensions` 并将静态库链接到游戏。修改 C++ 后需要增量编译、重新链接和重启；新增源文件需加入 `native/src/CMakeLists.txt`。第三方头文件、静态库与运行时 DLL 可分别放入 `native/third_party/include`、`native/third_party/lib` 和 `native/third_party/bin`（或在 `plugin-dev.json` 的 `runtimeFiles` 中声明），构建时会自动链接并部署到宿主可执行文件目录。

`Debug` 和 `RelWithDebInfo` 提供 V8 Inspector 调试；`RelWithDebInfo` 使用优化代码和调试信息，V8 使用 Release 依赖。`Release` 关闭 Inspector。切换配置后需要完成对应配置的重新构建。

源码 `tsconfig.json` 启用装饰器，`.local/cc-default.d.ts` 提供基础类型。宿主在 `.plugin-dev/typescript/projects/` 保存独立类型项目；工作台生成的 VS Code 工作区通过完整 TypeScript SDK 和 language service plugin 加载当前宿主声明。打开工作区后，执行 **TypeScript: Select TypeScript Version → Use Workspace Version** 完成 VS Code 的版本选择。

## 启用与禁用

使用插件开发面板的启停操作，使 TS 开关与 `cc_plugin.json.disabled` 保持一致。禁用后保留 TS 接口和组件标识，原生变更需要重新构建游戏后生效。

独立源码可同时关联多个宿主。每个宿主的 `plugin-dev.host.json` 单独保存启用配置，修改其中一个宿主不会修改源码或其他宿主的状态。解除引用保留独立源码和已导入的资源 UUID。

## 安装到其他项目

共同开发时，在另一个宿主的工作台关联此源码目录。分发时使用工作台“打包”，将导出的插件目录放入目标 Creator 项目的 `extensions/` 并启用扩展。发布包通过 `contributions.builder` 注册 Windows 构建 hooks，随包提供 TS 同步、CMake Post hook 和运行时文件部署功能，目标项目无需安装开发工作台。

通过工作台 CLI 的 `package --binary --project <宿主目录> --name {{NAME}}` 可以导出已编译的 Windows x64 静态库。缺省使用宿主最近成功构建的配置，也可通过 `--build-type Debug|RelWithDebInfo|Release` 指定匹配的构建配置。源码修改后需要重新构建，检查失败会终止导出。

二进制包使用 `<name>-<version>-windows-x64-<Config>.zip` 命名。原生库和链接依赖保存到 `native/windows/lib/`，公共头文件和运行资源分别保存在其 `include/`、`runtime/` 子目录，`native/src/` 保留在开发源码中。TS 代码、编辑器入口和构建 hooks 随包分发；包内 `BINARY.md` 提供安装说明，`native/windows/binary-manifest.json` 保存版本和 ABI 信息。目标项目需要使用匹配的构建配置、引擎及 C++ ABI。

`Debug` 和 `RelWithDebInfo` 中使用 `/Zi` 或 `/ZI` 编译的静态库会随包提供对应 compiler PDB，并保持 PDB 与库位于同一目录。`/Z7` 的调试信息包含在库内。二进制包不包含 C++ 实现源码，源码级调试需要另行提供匹配源码。

JS 资源与原生 C++ 必须使用同一套引擎。通过项目的引擎配置选择版本；渲染内部接口和第三方库还需确认版本及 ABI 兼容性。

{{RENDER_README}}
