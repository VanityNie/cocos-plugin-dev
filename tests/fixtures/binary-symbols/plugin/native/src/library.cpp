#include <library.h>

extern "C" int binary_symbols_dependency_value();

extern "C" __declspec(noinline) int binary_symbols_value() {
    volatile int value = 40;
    return value + binary_symbols_dependency_value();
}
