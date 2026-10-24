# Cocos Plugin Dev

**English** | [简体中文](README.md)

Windows native plugin development workbench for Cocos Creator. Create standalone or embedded TS + C++ plugins, link a single plugin repository to multiple game hosts, and manage source synchronization, enablement, incremental native builds, debugging workspaces, and source/binary packaging.

Built on the official Cocos native plugin mechanism. A single plugin source tree can be linked to multiple game projects; each host independently maintains its enable state, imported asset copies, isolated TypeScript declarations, and build caches. See [ARCHITECTURE.md](ARCHITECTURE.md) for design details.

## Requirements

- Windows x64, Cocos Creator 3.8.8 (Cocos 4.0 experimental support)
- Node.js 18+
- Visual Studio C++ Desktop Development workload, Windows SDK, CMake, Ninja
- Optional: VS Code (CMake Tools, C/C++ debugger, clangd), or the Visual Studio IDE

The JS engine used by Creator and the C++ engine used for native builds must match. When using a custom engine, configure both in Creator Preferences and restart the editor.

## Installation

```powershell
git clone https://github.com/VanityNie/cocos-plugin-dev.git
cd cocos-plugin-dev
npm ci
node cli.cjs install --project E:/games/MyGame
```

Scan and enable `cocos-plugin-dev` in Creator's **Extension Manager**, then open the workbench panel via **Developer → Plugin Development**.

## Workflow

1. Select a game host. The workbench detects the active Creator engine and installed toolchain.
2. Enter a plugin name, choose a template (`native` or `render`) and source directory to create a plugin, or link an existing plugin repository.
3. Edit `runtime/` (TS) and `native/src/` (C++) inside the plugin source directory.
4. Click **Build & Run**. The workbench generates a development scene, prepares TS assets and the native host, compiles, and starts the game. Saving the current scene or attaching a probe manually is unnecessary.
5. Choose **VS Code · CMake / clangd** or **Visual Studio · Solution**, then open the development workspace. VS Code can open before the first build; Visual Studio automatically prepares the host and generates its solution without compiling it first.
6. Click **Package** to export a standalone installable plugin directory and ZIP archive.

### Host & Source Management

- **Standalone Source & Host Adapter**: `plugin-dev.host.json` in the host project root records relative paths to linked plugin sources and their enable states (commit this file to game version control). `extensions/<name>` inside the host is a generated adapter directory—always edit the standalone source repository rather than the adapter.
- **Runtime TS Synchronization**: `runtime/` is automatically mirrored into `assets/__plugin_dev/<name>` while preserving existing `.meta` UUIDs. A dedicated scene in `assets/__plugin_dev_host/` checks native registration and attaches each enabled plugin's `PluginProbe.ts`. Plugins without a probe receive registration checks only; add a probe to test their business behavior.
- **Enable / Disable & Unlink**:
  - **Disable**: Updates both the TS runtime flag and `cc_plugin.json` `disabled` field; takes effect after rebuilding and restarting the game.
  - **Unlink**: Removes the host adapter directory and reference from the selected host while keeping the standalone source repository and imported asset UUIDs intact.
- **Multi-Host Builds**: When the selected host is currently open in Creator, asset builds run through the editor's build service; for other hosts or CLI `prepare`, headless Creator is launched (close any open Creator window for that project beforehand).

## Command Line

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

- Passing both `--plugin-path` and `--project` to `create` creates a standalone repository and immediately links it to the host; passing only `--project` creates an embedded plugin under `extensions/<name>`.
- Additional commands: `list`, `enable`, `disable`, `sync`, `configure`. Progress is written to `stderr` and JSON output to `stdout`.
- Create a clean sandbox host project from Creator's official 3D template:
  ```powershell
  node cli.cjs sandbox --project E:/games/PluginSandbox
  node cli.cjs install --project E:/games/PluginSandbox
  ```

## Debugging & Build

### Build Configurations

Native build caches live in `.plugin-dev/build/windows`. Defaults to MSVC, Ninja, and `Debug`. Switch compilers with `--compiler clang-cl` and build configurations with `--build-type Debug|RelWithDebInfo|Release` (or via the panel settings):

| Configuration | Native Compilation & Engine Dependencies | V8 Inspector |
| --- | --- | --- |
| `Debug` | Full debug symbols, links and deploys Debug engine libraries | Enabled; generates TS attach and C++ compound launch configs |
| `RelWithDebInfo` | Optimized code with debug symbols, links and deploys Release engine libraries | Enabled; generates TS attach and C++ compound launch configs |
| `Release` | Release optimizations, links and deploys Release engine libraries | Disabled; generates C++ launch config only |

### Third-Party Dependencies & Runtime Files

Plugin templates provide standard third-party integration directories:
- `native/third_party/include`: Automatically added to header search paths.
- `native/third_party/lib/*.lib`: Automatically linked.
- `native/third_party/CMakeLists.txt`: Included via `add_subdirectory` when present, allowing custom per-configuration `IMPORTED` targets.
- `native/third_party/bin/`, `native/windows/bin/`, and `runtimeFiles` in `plugin-dev.json`: Automatically deployed to the host executable directory on build and cleaned up when the plugin is disabled or unlinked.

Example `runtimeFiles` declaration in `plugin-dev.json`:

```json
{
  "runtimeFiles": [
    { "source": "models/upscaler.onnx", "target": "models/upscaler.onnx" }
  ]
}
```

### Breakpoint Debugging & TypeScript Declarations

Choose an IDE in the panel, or run `debug --ide vscode|visual-studio`:

| IDE | Generated project | Build cache |
| --- | --- | --- |
| VS Code | `.plugin-dev/plugin-dev.code-workspace`, CMake Tools, clangd, native and TS debugger configurations | `.plugin-dev/build/windows` (Ninja) |
| Visual Studio | `.sln` / `.slnx` under `.plugin-dev/build/visual-studio/`, including host, engine, and native plugin targets | `.plugin-dev/build/visual-studio` (Visual Studio) |

Both projects reference the original plugin sources and use separate CMake caches. The Visual Studio solution uses the selected build configuration; regenerate after switching Debug / RelWithDebInfo / Release so assets, Inspector settings, and native dependencies stay consistent. The workbench selects a CMake that supports the installed Visual Studio version, preferring that installation's bundled CMake over an older Creator copy.

Visual Studio 2022 generates `.sln`; Visual Studio 2026 generates `.slnx`. Both open directly in their corresponding IDE. The format follows the [official CMake generator](https://github.com/Kitware/CMake/commit/e6aa7742b0cc611377cfb4d54415bc4862fc5e1f), without a custom conversion step.

- **VS Code CMake & clangd**: CMake Tools uses the workbench's source directory, Ninja cache, compiler environment, and configure arguments. clangd reads `.plugin-dev/build/windows/compile_commands.json` after CMake configuration. Before configuration, source editing and TS declarations remain available. Automatic configuration is disabled; use **Build & Run** for asset synchronization and the complete build, or CMake Tools for native targets in an already prepared host.
- **Visual Studio C++ Debugging**: The solution selects the game executable as its startup project and its output directory as the debugging working directory. Build and launch inside Visual Studio, or attach to the game started by the workbench. After TS or asset changes, rebuild resources in the workbench and regenerate the solution.
- **Workbench C++ Debugging**: When the game is running, VS Code receives an attach configuration for its PID. The launch configuration starts the existing executable. Rebuild and restart after C++ changes.
- **TypeScript Debugging**: Launch the game instance first, then attach the V8 Inspector (default port `6086`). Source maps point directly to the standalone `runtime/` directory.
- **Host-Isolated TypeScript Declarations**: Each host generates an isolated TypeScript project and local TypeScript SDK under `.plugin-dev/typescript/`. When opening the workspace in VS Code, run **TypeScript: Select TypeScript Version → Use Workspace Version** to load the active host's and engine's `cc` declarations for the shared plugin source.

The Visual Studio solution handles native C++ development; TS breakpoints use VS Code's V8 Inspector attachment. Binary packaging uses the workbench's successful Ninja build record; compiling in Visual Studio does not replace that record.

Override default tool paths via environment variables: `COCOS_CREATOR_PATH`, `COCOS_PLUGIN_NODE`, `COCOS_PLUGIN_CMAKE`, `COCOS_PLUGIN_NINJA`, `COCOS_PLUGIN_CLANGD`, `COCOS_PLUGIN_CLANG_CL`, `VSWHERE_PATH`. If an interrupted build leaves `PROJECT_LOCK_RECOVERY_REQUIRED`, verify no background build process is active and remove the reported lock directory.

## Templates & Distribution

| Template | Description |
| --- | --- |
| `native` | Baseline TS API, JSB bindings, and C++ numeric call probe |
| `render` | Extends `native` with a `NativePipeline` `CustomComputePass` registration and execution count probe |

### Source Distribution

Packages exported via `package` bundle a source snapshot, asset UUID seeds, and `contributions.builder` hooks. Copy the exported folder into another Creator project's `extensions/` directory and enable it—standard Creator Windows builds will automatically synchronize TS sources, install CMake hooks, and deploy runtime DLLs/assets without requiring the workbench.

### Binary Distribution

Use `package --binary` to distribute precompiled native static libraries without C++ source files:

```powershell
node cli.cjs package --project E:/games/MyGame --name my-plugin --binary --output-dir E:/exports
node cli.cjs package --project E:/games/MyGame --name my-plugin --binary --build-type RelWithDebInfo --output-dir E:/exports
```

- Defaults to the host's most recent successful build configuration. An explicit `--build-type` must match the completed build; rebuild first if sources changed. `--binary` applies only to `package`, and `package --build-type` requires `--binary`.
- Exports the single `STATIC_LIBRARY` target specified by `plugin-dev.json.target` (`cc_plugin.json.modules` must contain only this target), along with its linked third-party static libraries, DLL import libraries, and public compile settings resolved by CMake.
- Produces `<name>-<version>-windows-x64-<Config>.zip` per configuration:
  - Static libraries and link dependencies: `native/windows/lib/`
  - Public headers: `native/windows/lib/include/{plugin,windows,third_party}/`
  - Runtime DLLs and models: `native/windows/lib/runtime/`
  - Build & ABI metadata: `native/windows/binary-manifest.json` and `BINARY.md` (`native/src/` is excluded).
- For `Debug` and `RelWithDebInfo` libraries compiled with `/Zi` or `/ZI`, the compiler PDB is placed next to its corresponding `.lib` so consumer projects link full debug symbols (`/Z7` embeds symbols directly inside the `.lib`).
- Consumer projects link the package via the generated CMake config, which verifies build configuration, engine version, compiler toolset, and MSVC runtime ABI at build time.

## Repository Development

```powershell
npm ci
npm test
```

| Directory | Purpose |
| --- | --- |
| `main.js`, `panels/` | Creator extension entry and workbench UI panel |
| `cli.cjs` | Command-line interface |
| `lib/` | Plugin management, Windows build orchestration, binary packaging, and workspace generation |
| `templates/` | Plugin scaffolding templates, CMake scripts, and editor build hooks |
| `tests/` | Unit and integration test suite |

## License

[MIT](LICENSE)
