# Cocos Plugin Dev

[English](README.en.md) | **简体中文**

Cocos Creator 的 Windows 原生插件开发工作台。支持在独立目录或游戏项目内创建 TS + C++ 插件，关联多个游戏宿主，完成源码同步、启停管理、增量构建、运行调试与打包分发。

基于 Cocos 官方原生插件机制实现。同一份插件源码可关联多个游戏项目，各宿主独立维护启用状态、资源副本、TypeScript 类型环境与构建缓存。架构设计见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 环境要求

- Windows x64、Cocos Creator 3.8.8（Cocos 4.0 实验性支持）
- Node.js 18+
- Visual Studio C++ 桌面开发工具集、Windows SDK、CMake、Ninja
- 可选：VS Code（CMake Tools、C/C++ 调试扩展、clangd），或 Visual Studio IDE

Creator 的 JS 引擎与原生构建的 C++ 引擎版本必须一致。若使用自定义引擎，需在 Creator 偏好设置中同时配置两者并重启编辑器。

## 安装

```powershell
git clone https://github.com/VanityNie/cocos-plugin-dev.git
cd cocos-plugin-dev
npm ci
node cli.cjs install --project E:/games/MyGame
```

安装后在 Creator **扩展管理器** 中扫描并启用 `cocos-plugin-dev`，通过顶部菜单 **开发者 → 插件开发** 打开工作台面板。

## 使用流程

1. 选择游戏宿主。工作台默认读取当前 Creator 的引擎与本机编译工具链。
2. 输入插件名称，选择模板（`native` 或 `render`）及源码目录创建插件，或直接关联已有插件源码。
3. 编辑插件源码目录中的 `runtime/`（TS）和 `native/src/`（C++）。
4. 点击 **构建并运行**。工作台自动生成测试场景，准备 TS 资源和 Windows 原生工程，编译并启动宿主；无需保存当前场景或手动挂载测试组件。
5. 选择 **VS Code · CMake / clangd** 或 **Visual Studio · 解决方案**，点击 **打开开发工作区**。VS Code 可在首次构建前打开；Visual Studio 会自动准备宿主并生成解决方案，无需先完成编译。
6. 点击 **打包**，导出可独立安装的插件目录与 ZIP 压缩包。

### 宿主与源码管理

- **独立源码与接入目录**：宿主根目录的 `plugin-dev.host.json` 记录插件源码相对路径与启用状态（建议纳入游戏版本控制）；宿主 `extensions/<name>` 为自动生成的接入目录，日常开发只需编辑独立源码目录。
- **运行时 TS 同步**：插件 `runtime/` 会自动同步至宿主 `assets/__plugin_dev/<name>` 并保留已有 `.meta` UUID。工作台在 `assets/__plugin_dev_host/` 生成专用测试场景，检查原生注册后自动挂载已启用插件的 `PluginProbe.ts`。没有探针的插件只检查原生注册，业务行为需在插件中补充测试。
- **解除引用与启停**：
  - **禁用**：同步关闭 TS 运行时开关与 `cc_plugin.json` 的 `disabled` 标记，重新构建并重启游戏后生效。
  - **解除引用**：移除所选宿主的接入目录与宿主配置引用，保留独立源码及宿主已导入资源的 UUID。
- **多宿主构建**：当前打开的 Creator 项目直接调用编辑器构建服务；操作其他宿主或使用 CLI `prepare` 时会启动无头 Creator，执行前需先关闭目标项目的编辑器窗口。

## 命令行

```powershell
node cli.cjs --help
node cli.cjs create --plugin-path E:/plugins/my-plugin --name my-plugin --template native
node cli.cjs link --project E:/games/MyGame --source-path E:/plugins/my-plugin
node cli.cjs link --project E:/games/TestGame --source-path E:/plugins/my-plugin
node cli.cjs doctor --project E:/games/MyGame
node cli.cjs build --project E:/games/MyGame --refresh-assets
node cli.cjs run --project E:/games/MyGame
node cli.cjs stop --project E:/games/MyGame
node cli.cjs restart --project E:/games/MyGame
node cli.cjs debug --project E:/games/MyGame --ide vscode
node cli.cjs debug --project E:/games/MyGame --ide visual-studio
node cli.cjs package --project E:/games/MyGame --name my-plugin --output-dir E:/exports
node cli.cjs unlink --project E:/games/TestGame --name my-plugin
```

- `create` 同时传入 `--plugin-path` 与 `--project` 时，会在创建独立源码后自动关联到该宿主；仅传 `--project` 则在宿主 `extensions/<name>` 下创建内嵌插件。
- 其他管理命令：`list`、`enable`、`disable`、`sync`、`configure`。命令进度输出至 `stderr`，JSON 结果输出至 `stdout`。
- 需要快速创建空白测试宿主时，可基于 Creator 官方 3D 模板生成沙盒项目：
  ```powershell
  node cli.cjs sandbox --project E:/games/PluginSandbox
  node cli.cjs install --project E:/games/PluginSandbox
  ```

## 调试与构建

### 构建配置

原生构建缓存位于宿主 `.plugin-dev/build/windows`。默认使用 MSVC、Ninja 与 `Debug` 配置，可通过 `--compiler clang-cl` 切换编译器，通过 `--build-type Debug|RelWithDebInfo|Release` 或面板设置切换构建配置：

| 构建配置 | 原生编译与引擎依赖 | V8 Inspector |
| --- | --- | --- |
| `Debug` | 完整调试符号，链接并部署 Debug 引擎依赖 | 开启，生成 TS 附加与 C++ 组合调试配置 |
| `RelWithDebInfo` | 优化代码与调试符号，链接并部署 Release 引擎依赖 | 开启，生成 TS 附加与 C++ 组合调试配置 |
| `Release` | 发布级优化，链接并部署 Release 引擎依赖 | 关闭，仅生成 C++ 启动调试配置 |

### 第三方依赖与运行时资源

插件模板内置第三方库约定目录：
- `native/third_party/include`：自动加入头文件搜索路径。
- `native/third_party/lib/*.lib`：自动链接导入库或静态库。
- `native/third_party/CMakeLists.txt`：存在时自动通过 `add_subdirectory` 引入，可按配置声明自定义 `IMPORTED` 目标。
- `native/third_party/bin/`、`native/windows/bin/` 及 `plugin-dev.json` 中的 `runtimeFiles`：构建时自动部署到宿主可执行文件目录，并在插件禁用或解除引用后自动清理受管文件。

`plugin-dev.json` 自定义运行时资源示例：

```json
{
  "runtimeFiles": [
    { "source": "models/upscaler.onnx", "target": "models/upscaler.onnx" }
  ]
}
```

### 断点调试与类型提示

在面板选择 IDE 后点击 **打开开发工作区**，或运行 `debug --ide vscode|visual-studio`。

| 开发环境 | 生成内容 | 构建缓存 |
| --- | --- | --- |
| VS Code | `.plugin-dev/plugin-dev.code-workspace`，CMake Tools、clangd、C++ 与 TS 调试配置 | `.plugin-dev/build/windows`（Ninja） |
| Visual Studio | `.plugin-dev/build/visual-studio/` 中的 `.sln` / `.slnx`，引擎、宿主与插件的原生目标 | `.plugin-dev/build/visual-studio`（Visual Studio） |

两种工程使用同一份插件源码、不同的 CMake 缓存。Visual Studio 解决方案按面板当前构建配置生成，切换 Debug / RelWithDebInfo / Release 后重新生成，保持资源、Inspector 与原生库配置一致。工具会选择支持已安装 Visual Studio 版本的 CMake；Creator 自带 CMake 过旧时使用该 Visual Studio 安装的 CMake。

Visual Studio 2022 生成 `.sln`；Visual Studio 2026 生成可直接打开的 `.slnx`。格式沿用 [CMake 官方生成器](https://github.com/Kitware/CMake/commit/e6aa7742b0cc611377cfb4d54415bc4862fc5e1f)，不自行转换解决方案。

- **VS Code CMake 与 clangd**：CMake Tools 使用与工作台一致的源码目录、Ninja 缓存、编译环境和配置参数。clangd 读取 `.plugin-dev/build/windows/compile_commands.json`，CMake 配置后即可获得真实头文件路径和宏定义；首次未配置时仍可编辑源码和使用 TS 类型提示。工作区关闭自动配置，资源同步与完整构建由面板 **构建并运行** 执行；CMake Tools 可用于已准备宿主的原生目标开发。
- **Visual Studio C++ 调试**：生成的解决方案以宿主可执行目标作为启动项目，调试工作目录指向实际输出目录。在 Visual Studio 中构建和启动，或使用 **附加到进程** 调试工作台已启动的游戏。修改 TS 或资源后先在工作台重新构建资源，再生成解决方案。
- **工作台 C++ 调试**：游戏已运行时，VS Code 提供对当前 PID 的附加配置；已有构建的启动配置只启动该可执行文件。修改 C++ 后重新编译并重启游戏。
- **TypeScript 断点调试**：先启动游戏实例，再附加 V8 Inspector（默认端口 `6086`），源码映射直接指向独立插件的 `runtime/` 目录。
- **多宿主 TypeScript 类型隔离**：每个宿主在 `.plugin-dev/typescript/` 下生成独立的类型项目与本地 TypeScript SDK。首次在 VS Code 打开工作区时，执行 **TypeScript: Select TypeScript Version → Use Workspace Version**，即可为插件源码加载当前宿主与引擎的 `cc` 类型声明。

Visual Studio 解决方案负责原生 C++ 开发；TS 断点使用 VS Code 的 V8 Inspector 附加。二进制打包读取工作台 Ninja 构建的成功记录，Visual Studio 中单独编译不会替换此记录。

可通过环境变量覆盖默认工具路径：`COCOS_CREATOR_PATH`、`COCOS_PLUGIN_NODE`、`COCOS_PLUGIN_CMAKE`、`COCOS_PLUGIN_NINJA`、`COCOS_PLUGIN_CLANGD`、`COCOS_PLUGIN_CLANG_CL`、`VSWHERE_PATH`。若构建异常中断导致残留锁报错 `PROJECT_LOCK_RECOVERY_REQUIRED`，确认无后台构建进程后删除报错提示的锁目录即可。

## 模板与打包分发

| 模板 | 说明 |
| --- | --- |
| `native` | 基础 TS API、JSB 绑定与 C++ 数值调用示例 |
| `render` | 在 `native` 基础上增加 `NativePipeline` 的 `CustomComputePass` 注册与执行计数探针 |

通过 `package` 导出的插件包内含当前源码快照、资源 UUID 种子及 `contributions.builder` 构建钩子。将导出的插件目录放入其他 Creator 项目的 `extensions/` 并启用后，直接使用 Creator 正常构建 Windows 平台即可自动完成 TS 同步、CMake 挂载与运行时 DLL／资源部署，目标项目无需安装本工作台。

需要分发已编译的原生库时，使用 `package --binary`：

```powershell
node cli.cjs package --project E:/games/MyGame --name my-plugin --binary --output-dir E:/exports
node cli.cjs package --project E:/games/MyGame --name my-plugin --binary --build-type RelWithDebInfo --output-dir E:/exports
```

二进制打包缺省使用该宿主最近成功构建的配置。显式 `--build-type` 必须与已完成的构建匹配；源码修改后需要重新构建。`--binary` 仅用于 `package`，`package --build-type` 必须同时指定 `--binary`。界面保存的构建配置不会改变此次打包的选择。

导出对象是 `plugin-dev.json.target` 对应的单个 `STATIC_LIBRARY`，`cc_plugin.json.modules` 必须仅包含这个 target。其第三方静态库、DLL import library 和公开编译设置会根据 CMake 的完整链接关系一同收集。

输出名称为 `<name>-<version>-windows-x64-<Config>.zip`，每个包包含一种构建配置。原生静态库及链接依赖位于 `native/windows/lib/`，公共头文件位于其 `include/{plugin,windows,third_party}/`，运行 DLL 和模型位于其 `runtime/`；`native/src/` 保留在开发源码中。TS 运行代码、编辑器入口与构建 hooks 随包分发。`native/windows/binary-manifest.json` 记录构建版本、ABI 和文件信息，安装说明见包内 `BINARY.md`。

`Debug` 与 `RelWithDebInfo` 使用 `/Zi` 或 `/ZI` 编译时，打包会将 compiler PDB 按原文件名放在对应静态库同目录，以便目标项目链接完整调试符号。使用 `/Z7` 编译时，调试信息包含在库内。二进制包不包含 C++ 实现源码；源码级调试需要开发者另行提供匹配的源码。

目标项目使用包内 CMake 配置链接库，构建配置、引擎或 C++ ABI 不匹配时立即报错。发布前应将 ZIP 安装到独立 Creator 项目，完成相应配置的构建、游戏启动、TS → JSB → C++ 调用与运行资源检查。

## 仓库开发

```powershell
npm ci
npm test
```

| 目录 | 职责 |
| --- | --- |
| `main.js`、`panels/` | Creator 扩展入口与工作台面板 |
| `cli.cjs` | 命令行入口 |
| `lib/` | 插件管理、Windows 构建与调试工作区生成 |
| `templates/` | 插件模板、CMake 脚本与编辑器构建扩展支持 |
| `tests/` | 单元与集成测试套件 |

## 许可证

[MIT](LICENSE)
