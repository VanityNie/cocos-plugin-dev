# {{DISPLAY_NAME}}

TS + C++ 插件，模板：`{{TEMPLATE}}`，目标平台：Windows。

## 开发

1. 在工作台选择游戏宿主，关联此源码目录；内嵌安装的插件直接启用扩展。
2. 编辑 `runtime/` 中的 TS 和 `native/src/` 中的 C++。编辑器入口会将运行时源码同步到宿主 `assets/__plugin_dev/{{NAME}}/`，并保留已有 `.meta` UUID；请勿直接编辑该副本。
3. 将 `{{CLASS}}Probe` 组件挂到场景节点。
4. 在插件开发面板准备 Windows 宿主，构建并运行。示例数值接口应返回 `42`。
5. 使用该宿主生成的调试工作区，可在 `{{CLASS}}Probe.start` 和 `{{CLASS}}Bridge::add` 设置断点。TS 源码断点需要正确的 source map。

浏览器预览使用 JavaScript 回退，此时 `available === false`。Windows 日志中的 `native=true` 和 `C++ bridge ready` 表示实际进入了原生插件。

原生清单、CMake target 和 `CC_PLUGIN_ENTRY` 统一使用 `{{TARGET}}`。Creator 构建会扫描项目的 `extensions` 并将静态库链接到游戏。修改 C++ 后需要增量编译、重新链接和重启；新增源文件需加入 `native/src/CMakeLists.txt`。第三方头文件、静态库与运行时 DLL 可分别放入 `native/third_party/include`、`native/third_party/lib` 和 `native/third_party/bin`（或在 `plugin-dev.json` 的 `runtimeFiles` 中声明），构建时会自动链接并部署到宿主可执行文件目录。

`Debug` 和 `RelWithDebInfo` 提供 V8 Inspector 调试；`RelWithDebInfo` 使用优化代码和调试信息，V8 使用 Release 依赖。`Release` 关闭 Inspector。切换配置后需要完成对应配置的重新构建。

源码 `tsconfig.json` 启用装饰器，`.local/cc-default.d.ts` 提供基础类型。宿主在 `.plugin-dev/typescript/projects/` 保存独立类型项目；工作台生成的 VS Code 工作区通过完整 TypeScript SDK 和 language service plugin 加载当前宿主声明。打开工作区后，执行 **TypeScript: Select TypeScript Version → Use Workspace Version** 完成 VS Code 的版本选择。各宿主的同步保持类型环境独立，原始 `runtime/` 是编辑入口。`.local/` 含有 Git 忽略规则，并从发布包排除。

`runtimeFiles` 的 `source` 相对插件根目录，`target` 相对宿主可执行文件目录。运行资源按输出目录记录 SHA-256 和引用插件，只有部署创建的受管文件可在最后一个引用解除后清理。宿主原有的同内容文件保留，内容冲突和手工修改会使部署报告错误。

## 启用与禁用

使用插件开发面板的启停操作，使 TS 开关与 `cc_plugin.json.disabled` 保持一致。禁用后保留 TS 接口和组件标识，原生变更需要重新构建游戏后生效。仅在扩展管理器卸载编辑器入口，不会改变已构建的原生程序。

独立源码可同时关联多个宿主。每个宿主的 `plugin-dev.host.json` 单独保存启用配置，修改其中一个宿主不会修改源码或其他宿主的状态。解除引用保留独立源码和已导入的资源 UUID。

## 安装到其他项目

共同开发时，在另一个宿主的工作台关联此源码目录。分发时使用工作台“打包”，将导出的插件目录放入目标 Creator 项目的 `extensions/` 并启用扩展。发布包通过 `contributions.builder` 注册 Windows 构建 hooks，随包提供 TS 同步、CMake Post hook、DLL／模型部署和清理功能。目标项目通过 Creator 完成 Windows 构建，无需安装开发工作台或访问开发机源码路径。

JS 资源与原生 C++ 必须使用同一套引擎。通过项目的引擎配置选择版本；渲染内部接口和第三方库还需确认版本及 ABI 兼容性。

发布前使用最终安装包在全新宿主验证三种构建配置、真实 TS → JSB → C++ 调用、DLL 加载和模型读取；验证升级、禁用、解除引用及共享依赖清理。记录引擎与编译器版本、DLL／PDB 配置、许可证和 SHA-256。根据逐版本安装与运行结果设置 `engine-version`，并为插件 API 明确资源所有权、线程要求、释放时机和错误处理。

{{RENDER_README}}
