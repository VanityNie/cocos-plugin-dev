#include <string>
#include "bindings/sebind/sebind.h"
#include "engine/EngineEvents.h"
#include "plugins/Plugins.h"
{{CPP_INCLUDE}}

namespace {
class {{CLASS}}Bridge final {
public:
    // Put a native breakpoint here, then run PluginProbe.start() from the game.
    static std::string ping() { return "{{NAME}}: C++ bridge ready"; }
    static std::string version() { return "0.1.0"; }
    static double add(double left, double right) { return left + right; }
{{CPP_METHODS}}
};

bool registerBridge(se::Object* global) {
    sebind::class_<{{CLASS}}Bridge> bridge("{{NATIVE_CLASS}}");
    bridge.staticFunction("ping", &{{CLASS}}Bridge::ping)
        .staticFunction("version", &{{CLASS}}Bridge::version)
        .staticFunction("add", &{{CLASS}}Bridge::add)
{{CPP_BINDINGS}}
        .install(global);
    return true;
}

void loadPlugin() {
    // BaseGame calls plugin entry before ScriptEngine::start(). JSB classes must
    // be registered after the VM is initialized, and re-registered after restart.
    static cc::events::ScriptEngine::Listener listener;
    listener.bind([](cc::ScriptEngineEvent event) {
        if (event == cc::ScriptEngineEvent::AFTER_INIT) {
            se::ScriptEngine::getInstance()->addRegisterCallback(registerBridge);
        }
    });
}
} // namespace

// Must match modules[].target and the CMake target exactly.
CC_PLUGIN_ENTRY({{TARGET}}, loadPlugin)
