#include <cstdio>
#include <v8.h>

bool inspectorGameFlag();

int main() {
    std::printf("V8=%s Inspector=%d\n", v8::V8::GetVersion(), inspectorGameFlag() ? 1 : 0);
    return 0;
}
