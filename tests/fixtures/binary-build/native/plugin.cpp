int binary_base_value();
int binary_static_value();
int binary_whole_value();
int binary_link_whole_value();
int binary_external_value();
extern "C" __declspec(dllimport) int binary_math_value();
int binary_plugin_value() {
    return binary_base_value() + binary_static_value() + binary_whole_value() + binary_math_value() + binary_link_whole_value() + binary_external_value();
}
