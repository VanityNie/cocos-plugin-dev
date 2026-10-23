cmake_minimum_required(VERSION 3.20)
project(runtime_deployment_probe CXX)

add_executable(runtime_deployment_probe main.cpp)
set(CC_EXECUTABLE_NAME runtime_deployment_probe)
set(RES_DIR "${CPD_PROJECT_PATH}/build/windows")
include("${CPD_RUNTIME_CMAKE}")
include("${CPD_RUNTIME_CMAKE}")

add_custom_command(TARGET runtime_deployment_probe POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "${CPD_HOST_RESOURCE}" "$<TARGET_FILE_DIR:runtime_deployment_probe>/engine.json"
    VERBATIM
)
