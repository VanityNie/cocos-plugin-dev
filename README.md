# Cocos 插件开发工作台 · Windows

这是一个独立的 **Creator 编辑器扩展、插件项目生成器与开发工作台**。安装到游戏项目后，可从“开发者 → 插件开发”创建 TS + C++ 插件，并复用当前游戏进行同步、启停、构建、运行、调试和打包。

工具沿用 Cocos 官方的 `cc_plugin.json → find_package → plugin_registry → CC_PLUGIN_ENTRY` 原生插件链。它不实现新的编译器，也不包含 Cocos 引擎源码：Creator 处理游戏脚本和资源，CMake/Ninja/MSVC 编译原生代码，clangd 提供补全和跳转。

当前试点平台为 Windows。已在 Creator 3.8.8 与其配套引擎中验证完整流程；外部 Cocos 4.0 beta 引擎只完成插件对象编译验证。详情见 [验证记录](VALIDATION.md)，配置原理见 [架构与源码依据](ARCHITECTURE.md)。

## 安装到现有游戏

在本工具仓库根目录执行，替换游戏项目路径：

```powershell
node cli.cjs install --project E:/games/MyGame
```

安装器将工具复制到游戏项目的 `extensions/cocos-plugin-dev`。在 Creator 扩展管理器中扫描或启用它，然后打开“开发者 → 插件开发”。工具本身使用 CommonJS，安装和使用不需要运行 npm 构建或下载依赖。

首次打开面板，确认 Creator 路径和引擎路径。**编辑器生成 JS 资源所用的引擎，必须与 CMake 编译 C++ 所用的引擎一致。** 如果使用自定义引擎，在 Creator 的偏好设置中同时设置 JS 和原生引擎，并重启项目。工具会检查当前编辑器的实际路径；不能直接混用 Creator 3.8.8 的脚本资源与 4.0 引擎。

Windows 原生开发需要 Visual Studio C++ 工具集、Windows SDK、CMake、Ninja 和独立 Node.js。点击“检查环境”查看本机缺少的工具。clangd 和 VS Code 用于代码分析与调试，可以随后配置。

## 日常开发

1. **创建并启用**：输入名称，例如 `neural-render`，选择原生能力或渲染扩展模板。生成器创建 TS、C++、CMake、清单和类型声明，并加载插件的编辑器入口。
2. **编辑插件源码**：打开项目 `extensions/<name>`，修改 `runtime` 和 `native/src`。运行时 TS 自动同步到 `assets/__plugin_dev/<name>`；手动“同步”可用于检查或恢复。
3. **首次准备宿主**：面板调用当前 Creator 的构建服务，生成 Windows 游戏资源与官方原生工程。
4. **构建并运行**：使用 `.plugin-dev/build/windows` 中的独立缓存增量编译。仅修改 C++ 时，可以取消“同时更新 TS、场景和资源”。
5. **调试**：打开生成的 VS Code 工作区，对当前游戏启动 C++ 调试并附加游戏脚本调试器。
6. **打包**：导出可安装的源码插件目录和 ZIP，排除本机缓存与编译产物。

将生成的 `PluginProbe.ts` 组件挂到场景节点，可观察 TS → C++ 示例输出。浏览器预览会使用 JavaScript 回退；只有日志中的 `native=true` 才说明进入了原生插件。

面板默认更新 TS、场景和资源；工具还会检测所管理插件的 TS 和启停变更。普通游戏资产变化仍需保留该勾选，或在 CLI 构建时使用 `--refresh-assets`。**原生插件启停要在重新构建并重启游戏后生效。** 仅刷新编辑器资源不会卸载已链接到游戏中的 C++。

`assets/__plugin_dev` 是工具维护的运行时副本。编辑入口是插件的 `runtime`，已有 `.meta` 和 UUID 会保留；副本被手动改动时，工具会报告冲突。插件源码与 `.meta` 应正常提交 Git，本机 `.plugin-dev` 状态和缓存自行忽略。

## 插件结构与分发

```text
游戏项目/extensions/my-plugin/
  package.json                 Creator 编辑器扩展描述
  plugin-dev.json              插件模板、名称与启用配置
  editor/                     独立的源码同步入口
  runtime/                    可编辑的游戏运行时 TS
  native/
    cc_plugin.json            官方原生插件清单
    windows/                  平台 CMake 包配置
    src/                      CMake 目标、JSB 与 C++ 实现
```

原生模板用数值接口验证 TS 到 C++ 的调用。渲染模板增加 Custom Pass 注册入口与执行计数，不包含神经网络权重、推理后端或图像输出链；注册成功不等于执行了推理。

```powershell
node cli.cjs package --project E:/games/MyGame --name my-plugin --output-dir E:/exports
```

发布包自带编辑器同步入口。将导出的插件目录放入另一游戏的 `extensions`，在 Creator 中启用后，接收项目可沿用官方原生构建流程，无需安装整套开发工作台。接收方仍需对应平台工具链和兼容的引擎；当前分发的是源码插件，不保证跨版本二进制 ABI 兼容。

## 独立沙盒

不想改动现有游戏时，可以使用已安装 Creator 的官方 3D 模板生成一个独立项目。以下路径仅为示例：

```powershell
node cli.cjs sandbox --project E:/games/PluginSandbox --creator-path C:/ProgramData/cocos/editors/Creator/3.8.8/CocosCreator.exe
node cli.cjs install --project E:/games/PluginSandbox
node cli.cjs create --project E:/games/PluginSandbox --name hello-native --template native
node cli.cjs doctor --project E:/games/PluginSandbox
node cli.cjs prepare --project E:/games/PluginSandbox
node cli.cjs configure --project E:/games/PluginSandbox
node cli.cjs build --project E:/games/PluginSandbox
node cli.cjs run --project E:/games/PluginSandbox
node cli.cjs debug --project E:/games/PluginSandbox
```

`sandbox` 拒绝覆盖已有目录，并给项目分配独立 UUID。首次导入、授权登录和引擎全量编译可能耗时，后续复用同一缓存。

编辑器已打开该项目时，使用面板准备资源；CLI `prepare` 会启动 Creator，应先保存并关闭该项目，避免两个实例同时操作资源数据库。直接启动 Creator 时，以游戏目录为工作目录，避免其他仓库的 Babel 配置影响脚本编译。

## 调试与工具链

- clangd 使用真实 CMake 生成的 `compile_commands.json`，无需手工维护另一套宏和头文件路径。
- Windows 默认使用 MSVC 与 Ninja；可选 `--compiler clang-cl`，仍需匹配的 Windows SDK、MSVC 工具集及兼容的第三方库。
- C++ 使用原生调试器；游戏 TS 使用 V8 Inspector 和 source map。两套会话针对同一游戏，不提供跨语言统一单步。
- 编辑器扩展的 JavaScript 使用 Creator 开发者工具调试。
- 修改 C++ 后重新链接并重启游戏，不提供 DLL 热替换。

工具生成独立 `.plugin-dev/plugin-dev.code-workspace`，不覆盖项目现有 `.vscode`。C++ 启动后再附加脚本调试器较容易排查问题；如果组合启动时 Inspector 尚未监听，可以重试附加。TS 源码断点依赖正确的 source map 路径，当前实测范围包括 Inspector 求值和构建后 JavaScript 断点，尚未通过 VS Code 界面验证所有 TS/C++ 断点配置。

可以通过环境变量覆盖工具路径：`COCOS_CREATOR_PATH`、`COCOS_PLUGIN_NODE`、`COCOS_PLUGIN_CMAKE`、`COCOS_PLUGIN_NINJA`、`COCOS_PLUGIN_CLANGD`、`COCOS_PLUGIN_CLANG_CL`、`VSWHERE_PATH`。默认优先使用发现的 Visual Studio 配套 LLVM，避免 PATH 中旧 clangd 误报新 MSVC 头文件。

## 命令行与测试

面板和 CLI 共用核心函数。CLI 的进度写入标准错误，最终 JSON 写入标准输出。

```powershell
node cli.cjs --help
node cli.cjs disable --project E:/games/MyGame --name hello-native
node cli.cjs enable --project E:/games/MyGame --name hello-native
node cli.cjs sync --project E:/games/MyGame --name hello-native
node cli.cjs build --project E:/games/MyGame --refresh-assets
npm ci
npm test
```

开发本工具需要 Node.js 18 或更新版本。先执行 `npm ci` 安装锁定的测试依赖，再运行 `npm test`；亦可直接执行 `node run-tests.cjs`。`jsdom` 用于真实 DOM 面板测试，普通用户安装扩展、生成插件和运行 CLI 无需下载这些开发依赖。独立仓库本机验证为 38 项全部通过，历史“37 项通过”来自拆分前的环境。仓库还提供 Windows、Node.js 22/24 的 GitHub Actions 测试配置；远端执行结果以推送后的 Actions 记录为准。

## 本仓库结构

```text
cocos-plugin-dev/
  package.json, main.js         Creator 扩展声明与消息入口
  panels/default/             中文开发工作台
  cli.cjs                     命令行入口
  lib/core.cjs                插件生成、安装、打包
  lib/windows.cjs             Windows 工具探测、宿主构建与调试配置
  templates/                  原生/渲染模板及可分发同步模块
  tests/, run-tests.cjs        自动测试
  ARCHITECTURE.md             官方机制与外部引擎源码依据
  VALIDATION.md               历史实测范围和验证边界
```

游戏项目、Cocos 引擎源码和工具仓库可以放在三个独立目录。引擎源码路径是开发配置，不是本仓库的子模块。新仓库不携带历史 `.local` 沙盒、编译缓存、游戏产物或包含本机绝对路径的测试证据。

## 推送到自己的 GitHub

先在 GitHub 创建一个空仓库，不自动添加 README、许可证或 `.gitignore`。在本地仓库根目录执行，将引号中的地址替换成自己的仓库地址：

```powershell
git remote add origin "https://github.com/你的用户名/cocos-plugin-dev.git"
git push -u origin master
```

本地默认分支为 `master`。远端需要自己的访问权限。这些命令仅说明发布步骤，不代表远端仓库已经创建或代码已经推送。

## 官方参考

- [Cocos 4.0 原生插件教程](https://docs.cocos.com/creator/4.0/manual/zh/advanced-topics/native-plugins/tutorial.html)
- [原生插件说明](https://docs.cocos.com/creator/4.0/manual/zh/advanced-topics/native-plugins/brief.html)
- [编辑器菜单扩展](https://docs.cocos.com/creator/4.0/manual/zh/editor/extension/contributions-menu.html)
- [构建扩展](https://docs.cocos.com/creator/4.0/manual/zh/editor/publish/custom-build-plugin.html)

编辑器内资源构建使用实际核对并运行过的 `engine/query-info` 和 `builder/add-task`。后者是版本相关的 protected 接口；升级后不兼容时，工作台会报出错误并给出保存、关闭项目后的 CLI 回退步骤。
