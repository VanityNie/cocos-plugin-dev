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
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/../include")
    target_include_directories({{TARGET}} PUBLIC "${CMAKE_CURRENT_LIST_DIR}/../include")
endif()
if(WIN32 AND EXISTS "${CMAKE_CURRENT_LIST_DIR}/../windows/include")
    target_include_directories({{TARGET}} PUBLIC "${CMAKE_CURRENT_LIST_DIR}/../windows/include")
elseif(ANDROID AND EXISTS "${CMAKE_CURRENT_LIST_DIR}/../android/include")
    target_include_directories({{TARGET}} PUBLIC "${CMAKE_CURRENT_LIST_DIR}/../android/include")
endif()
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/../third_party/include")
    target_include_directories({{TARGET}} PRIVATE "${CMAKE_CURRENT_LIST_DIR}/../third_party/include")
endif()
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/../third_party/lib")
    if(WIN32)
        file(GLOB CPD_THIRD_PARTY_LIBS CONFIGURE_DEPENDS "${CMAKE_CURRENT_LIST_DIR}/../third_party/lib/*.lib")
    elseif(ANDROID)
        file(GLOB CPD_THIRD_PARTY_LIBS CONFIGURE_DEPENDS
            "${CMAKE_CURRENT_LIST_DIR}/../third_party/lib/${ANDROID_ABI}/*.a"
            "${CMAKE_CURRENT_LIST_DIR}/../third_party/lib/${ANDROID_ABI}/*.so"
            "${CMAKE_CURRENT_LIST_DIR}/../third_party/lib/*.a"
        )
    endif()
    if(CPD_THIRD_PARTY_LIBS)
        target_link_libraries({{TARGET}} PRIVATE ${CPD_THIRD_PARTY_LIBS})
    endif()
endif()
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/../third_party/CMakeLists.txt")
    add_subdirectory(
        "${CMAKE_CURRENT_LIST_DIR}/../third_party"
        "${CMAKE_BINARY_DIR}/plugins/{{NAME}}/third_party"
    )
endif()
set_target_properties({{TARGET}} PROPERTIES FOLDER "Plugins/{{NAME}}")
