#if defined(SLOT_CONSUMER)
#include "slot.h"
static_assert(SLOT_VALUE == SLOT_EXPECTED);
static_assert(SLOT_TEXT[1] == ',' && SLOT_TEXT[3] == '>');
#ifdef __ANDROID__
extern "C" int slot_consumer() { return slot_plugin(); }
#else
int main() { return slot_plugin() == SLOT_EXPECTED + 7 ? 0 : 1; }
#endif
#elif defined(SLOT_PLUGIN)
extern "C" int slot_engine();
extern "C" int slot_dependency();
extern "C" int slot_shared();
extern "C" int slot_plugin() { return SLOT_VALUE + slot_engine() + slot_dependency() + slot_shared(); }
#elif defined(SLOT_ENGINE)
extern "C" int slot_engine() { return 1; }
#elif defined(SLOT_DEPENDENCY)
extern "C" int slot_dependency() { return 2; }
#elif defined(SLOT_WHOLE)
extern "C" int slot_whole() { return 3; }
#elif defined(SLOT_SHARED)
#ifdef _WIN32
extern "C" __declspec(dllexport) int slot_shared() {
#else
extern "C" int slot_shared() {
#endif
#ifdef NDEBUG
    return 8;
#else
    return 4;
#endif
}
#endif
