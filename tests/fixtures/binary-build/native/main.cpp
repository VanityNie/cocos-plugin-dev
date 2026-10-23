#include <cstdio>
#include <cstring>
#include <cpd_api.hpp>
#ifndef CPD_PUBLIC_VALUE
#error CPD_PUBLIC_VALUE is required
#endif
#ifndef FOO
#error FOO is required
#endif
int binary_plugin_value();
int main() {
    const int result = binary_plugin_value() + CPD_PUBLIC_VALUE + CPD_HEADER_VALUE;
    std::printf("Binary result=%d\n", result);
    return result == 220 && std::strcmp(CPD_ESCAPED, "a\\b") == 0 ? 0 : 1;
}
