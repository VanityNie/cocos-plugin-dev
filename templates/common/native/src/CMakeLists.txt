cmake_minimum_required(VERSION 3.20)

if(NOT ENGINE_NAME OR NOT TARGET ${ENGINE_NAME})
    message(FATAL_ERROR "{{NAME}} must be configured inside a Creator-generated native project")
endif()

add_library({{TARGET}} STATIC
    "${CMAKE_CURRENT_LIST_DIR}/PluginEntry.cpp"
{{CMAKE_EXTRA}}
)
target_link_libraries({{TARGET}} PRIVATE ${ENGINE_NAME})
target_compile_definitions({{TARGET}} PRIVATE CC_PLUGIN_STATIC=1)
target_compile_features({{TARGET}} PRIVATE cxx_std_17)
set_target_properties({{TARGET}} PROPERTIES FOLDER "Plugins/{{NAME}}")
