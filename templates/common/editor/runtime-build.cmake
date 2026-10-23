include_guard(GLOBAL)

if(NOT CPD_PROJECT_PATH OR NOT IS_DIRECTORY "${CPD_PROJECT_PATH}")
    message(FATAL_ERROR "插件运行时部署需要 CPD_PROJECT_PATH。")
endif()
if(NOT CC_EXECUTABLE_NAME OR NOT TARGET ${CC_EXECUTABLE_NAME})
    message(FATAL_ERROR "插件运行时部署需要 Creator 的可执行文件 target。")
endif()
if(NOT NODE_EXECUTABLE OR NOT EXISTS "${NODE_EXECUTABLE}")
    message(FATAL_ERROR "插件运行时部署需要 NODE_EXECUTABLE。")
endif()
get_target_property(CPD_TARGET_TYPE ${CC_EXECUTABLE_NAME} TYPE)
if(NOT CPD_TARGET_TYPE STREQUAL "EXECUTABLE")
    message(FATAL_ERROR "CC_EXECUTABLE_NAME 必须指向可执行文件 target。")
endif()

set_property(GLOBAL PROPERTY CPD_RUNTIME_TARGET "${CC_EXECUTABLE_NAME}")
set_property(GLOBAL PROPERTY CPD_RUNTIME_PROJECT "${CPD_PROJECT_PATH}")
set_property(GLOBAL PROPERTY CPD_RUNTIME_NODE "${NODE_EXECUTABLE}")
set_property(GLOBAL PROPERTY CPD_RUNTIME_SCRIPT "${CMAKE_CURRENT_LIST_DIR}/deploy-runtime.cjs")
set_property(GLOBAL PROPERTY CPD_RUNTIME_RESOURCES "${RES_DIR}")

function(cpd_finalize_runtime_deployment)
    get_property(CPD_TARGET GLOBAL PROPERTY CPD_RUNTIME_TARGET)
    get_property(CPD_PROJECT GLOBAL PROPERTY CPD_RUNTIME_PROJECT)
    get_property(CPD_NODE GLOBAL PROPERTY CPD_RUNTIME_NODE)
    get_property(CPD_SCRIPT GLOBAL PROPERTY CPD_RUNTIME_SCRIPT)
    get_property(CPD_RESOURCES GLOBAL PROPERTY CPD_RUNTIME_RESOURCES)
    if(TARGET cpd_runtime_deploy)
        message(FATAL_ERROR "cpd_runtime_deploy target 名称已被使用。")
    endif()
    # 在 Creator 完成依赖复制后部署插件文件。
    add_custom_command(TARGET ${CPD_TARGET} POST_BUILD
        COMMAND "${CPD_NODE}" "${CPD_SCRIPT}" "${CPD_PROJECT}" "$<TARGET_FILE:${CPD_TARGET}>"
        VERBATIM
    )
    add_custom_target(cpd_runtime_deploy ALL
        COMMAND "${CPD_NODE}" "${CPD_SCRIPT}" "${CPD_PROJECT}" "$<TARGET_FILE:${CPD_TARGET}>"
        DEPENDS ${CPD_TARGET}
        VERBATIM
    )
    string(SHA256 CPD_BUILD_KEY "${CMAKE_BINARY_DIR}")
    set(CPD_METADATA_DIRECTORY "${CPD_PROJECT}/.plugin-dev/native-build/metadata")
    file(MAKE_DIRECTORY "${CPD_METADATA_DIRECTORY}")
    string(REPLACE "\\" "/" CPD_PROJECT_JSON "${CPD_PROJECT}")
    string(REPLACE "\\" "/" CPD_RESOURCES_JSON "${CPD_RESOURCES}")
    file(GENERATE
        OUTPUT "${CPD_METADATA_DIRECTORY}/${CPD_BUILD_KEY}-$<CONFIG>.json"
        CONTENT "{\n  \"schemaVersion\": 1,\n  \"projectPath\": \"${CPD_PROJECT_JSON}\",\n  \"buildDirectory\": \"${CMAKE_BINARY_DIR}\",\n  \"resourceDirectory\": \"${CPD_RESOURCES_JSON}\",\n  \"configuration\": \"$<CONFIG>\",\n  \"executable\": \"$<TARGET_FILE:${CPD_TARGET}>\"\n}\n"
    )
endfunction()

cmake_language(DEFER CALL cpd_finalize_runtime_deployment)
