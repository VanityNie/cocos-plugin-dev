# Windows 验证记录与来源

日期：2026-10-22。本文分开记录独立工具仓库的迁移检查，以及拆分前在外部引擎工作区完成的完整运行验证。两者使用独立沙盒，没有使用或修改现有 `cocos-example-custom-pipeline` 项目。

## 独立仓库检查

在 `E:/code/work/cocos-plugin-dev` 执行：

1. `npm ci` 安装锁定的开发依赖。
2. `npm test`：**38 项全部通过，无跳过**，包含新增的当前编辑器引擎发现测试与 jsdom 面板测试。
3. 独立 CLI 沙盒 `.local/standalone-smoke`：安装工作台、创建渲染插件、禁用、启用和 ZIP 打包通过。
4. Windows `doctor` 工具链探测通过。

这一轮没有重新编译或启动完整游戏。下面记录的游戏运行、Inspector 与 Cocos 4.0 对象编译结果来自拆分前的源工作区，不能当作迁移后的再次运行结果。

仓库提供 GitHub Actions 配置，在 Windows 上使用 Node.js 22 和 24 运行测试。编写和提交配置不代表远端 CI 已执行；实际结果应以推送后的 Actions 运行记录为准。

## 历史版本与结论

以下验证发生在工具仍位于 `E:/code/work/cocos4/tools/plugin-dev` 时。`E:/code/work/cocos4` 是外部 Cocos 引擎工作区，**不是现在的独立工具仓库**。

| 组合 | 已验证范围 |
| --- | --- |
| Creator 3.8.8 + 同版本内置 JS/原生引擎 | 编辑器扩展加载与面板打开、资源构建、Windows 原生编译链接、启动、TS → C++、渲染回调注册、Inspector 调试。 |
| 外部 Cocos 引擎 `4.0.0-beta.0` | 独立 CMake 配置、官方插件发现、两个插件的三个 C++ 对象编译成功；没有链接或运行完整 4.0 游戏。 |
| VS 2026 Community、MSVC 19.50、CMake 3.24.3、Ninja | 全量编译及头文件依赖触发的增量构建。 |
| VS 配套 clangd 20.1.8 | 使用真实编译数据库检查 `PluginEntry.cpp` 和 `RenderProbe.cpp`，均无错误。 |

本机 PATH 另有 LLVM 12，工具探测已改为优先所选 Visual Studio 配套的 LLVM；显式环境变量仍具有最高优先级。clang-cl 可配置，但本次完整宿主编译使用 MSVC。

## 历史完整运行检查

1. 自动测试：在原引擎工作区执行 `node tools/plugin-dev/run-tests.cjs`，37 项通过。覆盖文件冲突保护、UUID、启停状态、跨进程状态写入、ZIP 分发重装、Windows 参数、构建状态、编辑器消息和面板操作。独立仓库的新测试数见上节。
2. 官方模板：复制安装版本的 `hello-3d-world` 到 `.local/windows-sandbox`，独立项目 UUID。
3. 生成：`hello-native` 和 `neural-render` 的 TS、C++、CMake、原生清单。
4. 官方构建：CLI 资源准备返回 Creator 成功码 36。真实编辑器内的 `get-context`、`Panel.open`、环境检查以及 `builder/add-task` 资源准备也通过，编辑器内构建约 8.6 秒。
5. CMake：在 `.plugin-dev/build/windows` 生成独立 Ninja 工程、编译数据库和可执行文件信息；两个插件和 `plugin_registry` 链接进入游戏。
6. 原生运行：官方 3D 场景加载后，挂在场景上的验证组件输出下述结果。验证要求 `available=true`，不接受 JavaScript 回退作为成功依据。
7. Inspector：实际连接 `127.0.0.1:6086` 的 WebSocket，通过 `Runtime.evaluate` 调用 JSB；设置构建后 JavaScript 断点，命中 `SandboxPluginValidation.start` 后成功继续执行。
8. 增量构建：修复中文 MSVC 输出编码与 Ninja 依赖前缀不一致的问题。`RenderProbe.cpp` 正确记录 881 个头依赖；只触碰 `RenderProbe.h` 后执行 5 个构建步骤，未重编译数百个引擎目标。
9. 外部 4.0 引擎源码：使用独立 `.local/engine4-check` 配置，只编译两个 `PluginEntry.cpp` 与一个 `RenderProbe.cpp`。没有生成或复用游戏 JS 资源。外部引擎原有 `native/compile_commands.json` 和 `native/build/CMakeCache.txt` 的 SHA256 保持一致。
10. 真实编辑器创建：在第二个独立沙盒中，通过工作台消息创建 `ui-smoke`，留空显示名称正常回退；扩展自动注册并启用，修改 `runtime/index.ts` 后约 0.5 秒同步；面板禁用和启用均使 TS 开关与原生清单一致。
11. 真实启停重建：禁用 `hello-native` 后不显式传 `--refresh-assets`，构建自动更新 TS，Inspector 确认原生全局接口不存在、TS `enabled/available=false`；重新启用并构建后恢复原生接口与结果 42。最终两个插件均已启用，测试进程已退出。

```json
{
  "helloNative": true,
  "helloResult": 42,
  "helloPing": "hello-native: C++ bridge ready",
  "renderNative": true,
  "renderResult": 13,
  "renderRegistered": true,
  "renderExecuted": 0
}
```

`renderExecuted: 0` 是预期结果：渲染模板注册了回调，没有插入会执行的图节点，也没有推理或图像输出。

## 历史证据的位置

原机器的游戏沙盒为 `E:/code/work/cocos4/tools/plugin-dev/.local/windows-sandbox`。它与下面的日志、缓存和产物均留在原工作区，**没有复制到独立仓库，也不随 Git 克隆提供**。在新机器复现，请按照 [README](README.md) 生成自己的游戏沙盒。

下面的路径都相对于历史源目录 `E:/code/work/cocos4/tools/plugin-dev`，仅用于记录来源：

- `.local/tests-final.log`：自动测试。
- `.local/windows-sandbox/.plugin-dev/editor-integration.json`：真实 Creator API 和宿主准备。
- `.local/ui-create-sandbox/.plugin-dev/editor-create-summary.json`：真实创建、自动加载、源码监听与启停。
- `.local/windows-sandbox/.plugin-dev/logs/`：资源、CMake、原生构建与运行日志。
- `.local/windows-sandbox/.plugin-dev/native-validation.json`：Inspector、增量依赖与原生启停往返验证。
- `.local/windows-sandbox/.plugin-dev/plugin-dev.code-workspace`：独立调试工作区。
- `.local/engine4-check/.plugin-dev/validation.json`：外部 4.0 引擎对象编译结果和原缓存未变验证。
- `.local/clangd-check.log`、`.local/clangd-render-check.log`：语言服务检查。

这些包含本机绝对路径的证据不进入发布包；可移植的测试和源码已保留。新工具仓库测试生成的 `.local/standalone-smoke` 同样属于本机忽略目录，不能作为克隆后预置的沙盒。

复现编辑器测试时，直接从终端启动 Creator 应以游戏项目为工作目录。从引擎仓库根目录启动，曾导致引擎仓库的 Babel 配置影响沙盒编辑器脚本编译；改为游戏目录并重建沙盒编程缓存后恢复，未改动引擎 Babel 配置。

## 实际边界

- 没有完成 4.0 beta 全游戏端到端运行；3.8.8 的运行成功不能替代该验证。
- 没有通过 VS Code 界面实际命中 C++ 断点，也没有证明所有 Creator source map 都能直接映射为 TS 源码断点；已验证原生 Inspector 的连接、求值和生成 JavaScript 断点。
- `builder/add-task` 是版本相关的 protected 接口。本机 3.8.8 实际成功；其他版本需验证，不兼容时会给出 CLI 回退步骤。
- 没有神经网络模型、推理后端或 GPU 输出互操作实现；渲染模板提供开发入口。
- 首版为 Windows 源码插件，静态链接到游戏；不包含 Android/iOS 适配、二进制 ABI 兼容保证或 DLL 热替换。
