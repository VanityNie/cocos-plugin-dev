# Cocos Plugin Dev

Cocos Creator 的 Windows 插件开发工作台。在独立目录或游戏项目内创建 TS + C++ 插件，选择游戏宿主，完成源码同步、启停、增量构建、运行、调试配置和源码打包。

基于 Cocos 官方原生插件机制。同一份插件源码可以关联多个游戏，各宿主独立保存启用配置、资源副本和构建缓存。实现细节见 [架构说明](ARCHITECTURE.md)。

## 环境要求

- Windows x64、Cocos Creator 3.8.8；Cocos 4.0 为实验性支持。
- Node.js 18 或更新版本。
- Visual Studio C++ 桌面开发工具集、Windows SDK、CMake、Ninja。
- 可选：VS Code、C/C++ 调试扩展和 clangd。

Creator 使用的 JS 引擎与原生构建使用的 C++ 引擎必须匹配。使用自定义引擎时，在 Creator 偏好设置中同时配置两者并重启项目。

## 安装

```powershell
git clone https://github.com/VanityNie/cocos-plugin-dev.git
cd cocos-plugin-dev
npm ci
node cli.cjs install --project E:/games/MyGame
```

将示例路径替换为游戏项目路径。`npm ci` 安装工作台需要的完整 TypeScript SDK，安装命令会将该依赖一并复制到游戏项目。在 Creator 扩展管理器中扫描并启用 `cocos-plugin-dev`，打开 **开发者 → 插件开发**。

## 使用

1. 选择游戏宿主，检查 Creator、引擎和工具链路径。
2. 输入插件名称，选择原生或渲染模板及源码目录，创建插件；已有源码可直接关联。
3. 编辑插件源码目录的 `runtime/` 和 `native/src/`。
4. 点击“首次准备宿主”，生成游戏资源和 Windows 原生工程。
5. 点击“构建并运行”；需要断点调试时，打开生成的 VS Code 工作区。
6. 点击“打包”，导出源码插件目录和 ZIP。

宿主默认为当前打开的 Creator 项目，也可以在面板中选择其他项目。当前项目通过编辑器构建资源；其他宿主通过 Creator 命令行构建，准备前应关闭目标项目的 Creator。只有在对应宿主的 Creator 中启用插件扩展，才会启动实时源码监听；命令行构建会先同步最新源码。

独立源码目录与宿主目录应互不包含。项目的 `plugin-dev.host.json` 保存源码引用和启用配置；`extensions/<name>` 是自动生成的接入目录。请编辑独立源码，不要修改接入目录。C++ 直接编译独立目录中的文件，TS 同步到宿主资源目录。

将 `plugin-dev.host.json` 纳入游戏版本管理。源码路径相对游戏根目录解析，跨磁盘时使用绝对路径；其他开发机需将源码放到对应位置，或修改引用后同步。接入目录缺失时可通过“同步”或再次关联同一源码重新生成。

工作台提供“停止游戏”和“重启游戏”。重复运行会复用已有实例；重新构建前会停止本项目由工作台启动的游戏，释放可执行文件。通过 VS Code 或其他方式启动的游戏由对应工具管理。

耗时构建可点击“取消任务”，命令行可按 Ctrl+C。取消原生构建会等待子进程退出；Creator 编辑器中已开始的资源构建会先完成，再停止后续阶段。“构建并运行”进入游戏启动阶段后，使用“停止游戏”管理实例。

运行时 TS 自动同步到 `assets/__plugin_dev/<name>`，该目录由工具管理；已有 `.meta` 和 UUID 会保留，手工修改引起的冲突会阻止覆盖。

插件 TS 和启停变化会自动触发资源更新。修改普通游戏脚本、场景或资源时，保留“同时更新 TS、场景和资源”勾选。原生插件启停在重新构建并重启游戏后生效。

“解除引用”仅移除所选宿主的接入目录和引用，保留独立源码及该宿主的 TS 组件、资源 UUID，并将运行时开关关闭。重新构建后生效；重新关联可继续使用已有 UUID。内嵌插件使用“禁用”。

生成的 `PluginProbe.ts` 可挂到场景节点测试 TS → C++ 调用。浏览器预览使用 JavaScript 回退，`native=true` 表示原生接口可用。

## 命令行

```powershell
node cli.cjs --help
node cli.cjs create --plugin-path E:/plugins/my-plugin --name my-plugin --template native
node cli.cjs link --project E:/games/MyGame --source-path E:/plugins/my-plugin
node cli.cjs link --project E:/games/TestGame --source-path E:/plugins/my-plugin
node cli.cjs doctor --project E:/games/MyGame
node cli.cjs prepare --project E:/games/MyGame
node cli.cjs build --project E:/games/MyGame --refresh-assets
node cli.cjs run --project E:/games/MyGame
node cli.cjs stop --project E:/games/MyGame
node cli.cjs restart --project E:/games/MyGame
node cli.cjs debug --project E:/games/MyGame
node cli.cjs package --project E:/games/MyGame --name my-plugin --output-dir E:/exports
node cli.cjs unlink --project E:/games/TestGame --name my-plugin
```

`create` 同时指定 `--plugin-path` 和 `--project`，可在创建独立源码后立即关联宿主。仅指定 `--project` 时，保留在 `extensions/<name>` 内创建插件的方式。独立源码目录包含 Git 忽略规则，可以直接作为单独仓库管理。

CLI 还提供 `list`、`enable`、`disable`、`sync` 和 `configure`。进度写入标准错误，结果以 JSON 写入标准输出。

`restart` 使用现有构建；源码变化后应先执行 `build`。取消完成后，CLI 返回退出码 `130`。

CLI `prepare` 会启动 Creator，使用前先保存并关闭对应项目；项目已打开时，使用编辑器面板准备资源。

需要独立开发宿主时，可从已安装 Creator 的官方 3D 模板创建项目：

```powershell
node cli.cjs sandbox --project E:/games/PluginSandbox
node cli.cjs install --project E:/games/PluginSandbox
```

通过 `--creator-path` 指定 Creator，通过 `--engine-path` 指定匹配的引擎源码。`sandbox` 要求目标目录不存在。

## 调试与构建

原生构建缓存位于 `.plugin-dev/build/windows`。默认使用 MSVC、Ninja 和 `Debug` 配置，可通过 `--compiler clang-cl` 切换编译器，通过 `--build-type Debug|RelWithDebInfo|Release`（或面板“C++ 构建配置”）切换构建配置。

| 构建配置 | 原生编译 | V8 Inspector |
| --- | --- | --- |
| `Debug` | 调试信息与 Debug 引擎依赖。 | 开启，生成 TS 附加和组合调试配置。 |
| `RelWithDebInfo` | 优化代码、调试信息与 Release 引擎依赖。 | 开启，生成 TS 附加和组合调试配置。 |
| `Release` | Release 编译与引擎依赖。 | 关闭，工作区提供 C++ 启动配置。 |

切换构建配置会清除上次成功构建标记，完成对应配置的编译后才能运行。V8 导入库和运行时 DLL 使用相同的 CMake imported target 配置。

插件支持第三方依赖目录：`native/third_party/include` 自动加入头文件搜索，`native/third_party/lib/*.lib` 自动链接，`native/third_party/CMakeLists.txt` 自动引入子目录。需要按构建配置选择库时，在该 CMake 文件中声明具名 targets 及各配置对应的导入库和 DLL。

`native/third_party/bin/`、`native/windows/bin/` 下的文件，以及 `plugin-dev.json` 的 `runtimeFiles` 声明，均部署到宿主可执行文件目录。例如：

```json
{
  "runtimeFiles": [
    { "source": "models/upscaler.onnx", "target": "models/upscaler.onnx" }
  ]
}
```

目标路径必须位于可执行目录内，并符合 Windows 文件名规则。源文件与目标路径均检查符号链接。多插件使用相同目标时，文件内容必须相同；宿主已有文件内容不同或已部署文件被手工修改时，构建报告冲突。

`.plugin-dev/runtime-binaries.json` 按绝对输出目录记录归属、SHA-256 和引用插件。只有部署过程创建的文件可以在最后一个引用解除后清理；宿主已有的同内容文件继续保留。禁用插件或解除引用后重新构建，会检查已记录的输出目录，清理失去全部引用的受管文件。

同一项目的构建与进程操作互斥。若异常退出后报告 `PROJECT_LOCK_RECOVERY_REQUIRED`，确认上次构建进程已停止，再移除报错指出的锁目录并重试。

调试工作区位于 `.plugin-dev/plugin-dev.code-workspace`，根据构建配置生成 C++ 和 TS 调试入口。clangd 使用 CMake 生成的 `compile_commands.json`。

工作区同时包含游戏、引擎和独立插件源码，TS 路径映射指向原始 `runtime/` 文件。每个宿主生成自己的工作区和编译数据库，选择要调试的宿主对应的工作区即可。工具不修改插件源码目录的 `.clangd` 或 `.vscode`。

插件模板自带 `tsconfig.json`，启用 `experimentalDecorators`。源码目录的 `.local/cc-default.d.ts` 提供稳定的基础声明，独立创建插件后即可检查模板代码。每个宿主在 `.plugin-dev/typescript/projects/` 生成自己的 TypeScript 项目，引用所选引擎的 `bin/.declarations` 和宿主 `temp/declarations`；同名声明采用所选引擎的版本。缺少引擎及宿主声明时，宿主项目使用基础 `cc` 声明。

生成调试工作区时，工作台将完整 TypeScript SDK 复制到该宿主的 `.plugin-dev/typescript/node_modules/typescript`，工作区的 `typescript.tsdk` 指向此 SDK。打开工作区后，在 VS Code 执行 **TypeScript: Select TypeScript Version → Use Workspace Version**。VS Code 的信任与版本选择机制要求用户完成此确认；工作区配置启用了对应提示。使用原生 TypeScript Go 语言服务的工作区需要切换回 TypeScript SDK。

该 SDK 通过标准 TypeScript language service plugin 为原始 `runtime/` 加入当前宿主的声明。每个宿主分别保存声明、SDK 和项目配置，后台同步不会改变其他宿主的声明。命令行检查可通过 `tsc --project <宿主生成的 tsconfig.json>` 指定对应项目。独立、内嵌和发布包安装后生成的 `.local/` 均包含 Git 忽略规则，源码打包排除全部 `.local/` 内容。

- 先启动游戏，再附加 TS 调试器；组合启动时可能需要重试附加。
- Inspector 默认端口为 `6086`，被占用时以游戏日志中的实际端口为准。
- TS 断点依赖 Creator 的 source map；无法绑定时可先调试构建后的 JavaScript。
- C++ 修改需要重新链接并重启游戏。

可用环境变量覆盖工具路径：`COCOS_CREATOR_PATH`、`COCOS_PLUGIN_NODE`、`COCOS_PLUGIN_CMAKE`、`COCOS_PLUGIN_NINJA`、`COCOS_PLUGIN_CLANGD`、`COCOS_PLUGIN_CLANG_CL`、`VSWHERE_PATH`。

## 模板与分发

| 模板 | 功能 |
| --- | --- |
| `native` | TS API、JSB 绑定与 C++ 数值调用示例。 |
| `render` | 在原生模板上增加 Custom Pass 注册接口与执行计数；渲染图节点、推理后端和图像输出由插件实现。 |

发布包通过 `contributions.builder` 注册 `editor/builder.js`，包含编辑器同步入口和 Windows 构建 hooks。将导出的插件目录放入目标游戏的 `extensions` 并启用扩展，Creator 构建会同步 TS、安装项目的 CMake Post hook，并在原生编译后部署 DLL 和模型资源。目标项目需要兼容的引擎与 Windows 工具链。

部署支持文件保存在宿主 `.plugin-dev/native-build`，CMake 的可执行目标和默认构建目标均执行部署检查。最后一个插件禁用或解除引用后，宿主仍然保留运行资源清理入口。发布包使用这套入口完成普通 Creator 构建，无需安装开发工作台。

公共 `editor` 支持文件由当前工作台版本提供，导出过程保留插件源码与自定义编辑器入口。

开发关联和源码发布用途不同：开发关联持续读取本地源码；发布包包含当前源码快照，不依赖开发机上的源码路径。工作台目前没有 Git 下载或包版本解析功能。

## 开发

正式发布应以最终安装包完成以下验收，并保存对应引擎版本、编译器、配置、构建日志和程序输出：

- 在全新 Creator 项目安装导出包，通过 Creator 完成资源构建和三种 Windows 原生构建，启动场景并验证真实 TS → JSB → C++ 调用结果。
- 核对每种配置的 `.lib`、DLL、PDB、MSVC runtime 和架构，确认运行进程实际加载的依赖文件；为模型和 DLL 记录版本、许可证及 SHA-256。
- 验证多个插件共享依赖、内容冲突、升级、禁用、解除引用及多个输出目录，确认宿主原有文件和其他插件仍在使用的文件得到保留。
- 验证对象所有权、线程使用、资源释放和错误处理；渲染或推理插件需要验证实际图像输出、模型加载、GPU 同步和输入尺寸变化。
- 对每个支持的 Creator／引擎版本执行安装与运行测试，再设置 `cc_plugin.json` 的 `engine-version` 范围；多宿主项目分别检查 TypeScript 类型与调试源码路径。

这些项目是插件发布的验收条件。单元测试、CMake 配置成功和示例回调注册分别覆盖对应阶段。

```powershell
npm ci
npm test
```

| 目录 | 职责 |
| --- | --- |
| `main.js`、`panels/` | Creator 扩展入口与工作台面板。 |
| `cli.cjs` | 命令行入口。 |
| `lib/` | 插件管理、Windows 构建与调试配置。 |
| `templates/` | 插件模板与运行时源码同步模块。 |
| `tests/` | 自动测试。 |

## 许可证

[MIT](LICENSE)
