# {{DISPLAY_NAME}}

Created with Cocos Plugin Development, Windows pilot. Template: **{{TEMPLATE}}**.

## Develop in the current project

1. Open the generated `runtime/` TS and `native/src/` C++ directly. The editor
   extension mirrors runtime sources into `assets/__plugin_dev/{{NAME}}/`.
   Edit the source, not the mirrored copy. Existing `.meta` UUIDs are preserved.
2. Attach the generated `{{CLASS}}Probe` component to a node in your existing scene.
3. Use the development panel to build the current project for Windows (debug).
   Put a TS breakpoint in `PluginProbe.start` and a C++ breakpoint in
   `{{CLASS}}Bridge::add`. The expected value is 42.
4. Browser preview uses an explicit JS fallback (`available === false`). A
   successful fallback does not prove the native plugin has loaded. Windows
   native logs must say `native=true` and `C++ bridge ready`.

The native manifest, CMake target and `CC_PLUGIN_ENTRY` all use `{{TARGET}}`.
The official Creator build scans `extensions/` and links this static library.
C++ changes need incremental compile, relink and process restart. New source
files must also be added to `native/src/CMakeLists.txt`.

Use the development panel's enable/disable action; disabling keeps TS APIs and
component identities available, changes `cc_plugin.json.disabled`, and requires
a fresh native configure/build. The Creator extension manager's unload action
alone does not change a statically linked native executable.

## Standalone installation

Copy this package directory under another Creator project's `extensions/` and
enable the extension. No development tool is required for runtime sync. Build a
Windows native project using a compatible engine and attach the sample component.
No project path, build cache, native binary or editor dependency is shipped.

## Toolchain and compatibility

The baseline JSB template was run with Creator 3.8.8 and compiled against
Cocos engine 4.0.0-beta.0. Selecting a different engine must be done through the
project's engine configuration; this package never silently rewrites it. Render
internals are version-sensitive and must be compiled against the selected engine.

{{RENDER_README}}
