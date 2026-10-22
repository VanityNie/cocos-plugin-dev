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
node cli.cjs install --project E:/games/MyGame
```

将示例路径替换为游戏项目路径。在 Creator 扩展管理器中扫描并启用 `cocos-plugin-dev`，打开 **开发者 → 插件开发**。安装和使用无需下载 npm 依赖。

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

原生构建缓存位于 `.plugin-dev/build/windows`。默认使用 MSVC 和 Ninja，可通过 `--compiler clang-cl` 切换编译器。

同一项目的构建与进程操作互斥。若异常退出后报告 `PROJECT_LOCK_RECOVERY_REQUIRED`，确认上次构建进程已停止，再移除报错指出的锁目录并重试。

调试工作区位于 `.plugin-dev/plugin-dev.code-workspace`，包含 C++ 启动和 V8 Inspector 附加配置。clangd 使用 CMake 生成的 `compile_commands.json`。

工作区同时包含游戏、引擎和独立插件源码，TS 路径映射指向原始 `runtime/` 文件。每个宿主生成自己的工作区和编译数据库，选择要调试的宿主对应的工作区即可。工具不修改插件源码目录的 `.clangd` 或 `.vscode`。

独立源码的 TS 编辑器类型环境需在插件自己的 `tsconfig.json` 中配置；工作区暂不自动关联宿主的 `cc` 类型声明。此限制影响源码中的类型检查与补全，运行资源仍由宿主 Creator 构建。

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

发布包自带编辑器同步入口。将导出的插件目录放入目标游戏的 `extensions` 并启用，即可使用官方原生构建流程。目标项目需要兼容的引擎与 Windows 工具链。

开发关联和源码发布用途不同：开发关联持续读取本地源码；发布包包含当前源码快照，不依赖开发机上的源码路径。工作台目前没有 Git 下载或包版本解析功能。

## 开发

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
