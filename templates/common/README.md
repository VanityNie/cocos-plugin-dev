# {{DISPLAY_NAME}}

TS + C++ 插件，模板：`{{TEMPLATE}}`，目标平台：Windows。

## 开发

1. 在工作台选择游戏宿主，关联此源码目录；内嵌安装的插件直接启用扩展。
2. 编辑 `runtime/` 中的 TS 和 `native/src/` 中的 C++。编辑器入口会将运行时源码同步到宿主 `assets/__plugin_dev/{{NAME}}/`，并保留已有 `.meta` UUID；请勿直接编辑该副本。
3. 将 `{{CLASS}}Probe` 组件挂到场景节点。
4. 在插件开发面板准备 Windows 宿主，构建并运行。示例数值接口应返回 `42`。
5. 使用该宿主生成的调试工作区，可在 `{{CLASS}}Probe.start` 和 `{{CLASS}}Bridge::add` 设置断点。TS 源码断点需要正确的 source map。

浏览器预览使用 JavaScript 回退，此时 `available === false`。Windows 日志中的 `native=true` 和 `C++ bridge ready` 表示实际进入了原生插件。

原生清单、CMake target 和 `CC_PLUGIN_ENTRY` 统一使用 `{{TARGET}}`。Creator 构建会扫描项目的 `extensions` 并将静态库链接到游戏。修改 C++ 后需要增量编译、重新链接和重启；新增源文件需加入 `native/src/CMakeLists.txt`。

## 启用与禁用

使用插件开发面板的启停操作，使 TS 开关与 `cc_plugin.json.disabled` 保持一致。禁用后保留 TS 接口和组件标识，原生变更需要重新构建游戏后生效。仅在扩展管理器卸载编辑器入口，不会改变已构建的原生程序。

独立源码可同时关联多个宿主。每个宿主的 `plugin-dev.host.json` 单独保存启用配置，修改其中一个宿主不会修改源码或其他宿主的状态。解除引用保留独立源码和已导入的资源 UUID。

## 安装到其他项目

共同开发时，在另一个宿主的工作台关联此源码目录。分发时使用工作台“打包”，将导出的插件目录放入目标 Creator 项目的 `extensions/` 并启用扩展。发布包自带运行时源码同步功能，无需安装开发工作台或访问开发机源码路径。使用兼容引擎构建 Windows 游戏，并按需挂载示例组件。

JS 资源与原生 C++ 必须使用同一套引擎。通过项目的引擎配置选择版本；渲染内部接口和第三方库还需确认版本及 ABI 兼容性。

{{RENDER_README}}
