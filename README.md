# Cocos Plugin Dev

Cocos Creator 的 Windows 插件开发工作台。在编辑器中创建 TS + C++ 插件，完成源码同步、启停、增量构建、运行、调试配置和源码打包。

基于 Cocos 官方原生插件机制，使用当前游戏项目作为运行宿主。实现细节见 [架构说明](ARCHITECTURE.md)。

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

1. 检查 Creator、引擎和工具链路径。
2. 输入插件名称，选择原生或渲染模板，创建并启用插件。
3. 编辑 `extensions/<name>/runtime` 和 `extensions/<name>/native/src`。
4. 点击“首次准备宿主”，生成游戏资源和 Windows 原生工程。
5. 点击“构建并运行”；需要断点调试时，打开生成的 VS Code 工作区。
6. 点击“打包”，导出源码插件目录和 ZIP。

运行时 TS 自动同步到 `assets/__plugin_dev/<name>`，该目录由工具管理；已有 `.meta` 和 UUID 会保留，手工修改引起的冲突会阻止覆盖。

插件 TS 和启停变化会自动触发资源更新。修改普通游戏脚本、场景或资源时，保留“同时更新 TS、场景和资源”勾选。原生插件启停在重新构建并重启游戏后生效。

生成的 `PluginProbe.ts` 可挂到场景节点测试 TS → C++ 调用。浏览器预览使用 JavaScript 回退，`native=true` 表示原生接口可用。

## 命令行

```powershell
node cli.cjs --help
node cli.cjs create --project E:/games/MyGame --name my-plugin --template native
node cli.cjs doctor --project E:/games/MyGame
node cli.cjs prepare --project E:/games/MyGame
node cli.cjs build --project E:/games/MyGame --refresh-assets
node cli.cjs run --project E:/games/MyGame
node cli.cjs debug --project E:/games/MyGame
node cli.cjs package --project E:/games/MyGame --name my-plugin --output-dir E:/exports
```

CLI 还提供 `list`、`enable`、`disable`、`sync` 和 `configure`。进度写入标准错误，结果以 JSON 写入标准输出。

CLI `prepare` 会启动 Creator，使用前先保存并关闭对应项目；项目已打开时，使用编辑器面板准备资源。

需要独立开发宿主时，可从已安装 Creator 的官方 3D 模板创建项目：

```powershell
node cli.cjs sandbox --project E:/games/PluginSandbox
node cli.cjs install --project E:/games/PluginSandbox
```

通过 `--creator-path` 指定 Creator，通过 `--engine-path` 指定匹配的引擎源码。`sandbox` 要求目标目录不存在。

## 调试与构建

原生构建缓存位于 `.plugin-dev/build/windows`。默认使用 MSVC 和 Ninja，可通过 `--compiler clang-cl` 切换编译器。

调试工作区位于 `.plugin-dev/plugin-dev.code-workspace`，包含 C++ 启动和 V8 Inspector 附加配置。clangd 使用 CMake 生成的 `compile_commands.json`。

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
