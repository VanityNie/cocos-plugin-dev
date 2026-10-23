#include <fstream>
#include <iostream>

int main() {
    std::ifstream input("settings.json");
    if (!input) return 1;
    std::cout << input.rdbuf();
    return input.bad() ? 1 : 0;
}
