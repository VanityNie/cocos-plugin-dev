#include <cstdio>
#include <library.h>

int main() {
    const int value = binary_symbols_value();
    std::printf("Binary symbols value=%d\n", value);
    return value == 42 ? 0 : 1;
}
