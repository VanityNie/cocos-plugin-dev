if(MSVC AND TARGET v8)
    # CMake imported target 同时决定导入库与运行时 DLL 的配置。
    set(plugin_dev_v8_targets v8 v8_libbase v8_libplatform)
    get_target_property(plugin_dev_v8_release v8 IMPORTED_LOCATION)
    get_target_property(plugin_dev_v8_debug v8 IMPORTED_LOCATION_DEBUG)
    get_filename_component(plugin_dev_v8_release_dir "${plugin_dev_v8_release}" DIRECTORY)
    get_filename_component(plugin_dev_v8_debug_dir "${plugin_dev_v8_debug}" DIRECTORY)
    foreach(plugin_dev_v8_file IN LISTS V8_DLLS)
        get_filename_component(plugin_dev_v8_name "${plugin_dev_v8_file}" NAME_WE)
        if(TARGET ${plugin_dev_v8_name})
            list(APPEND plugin_dev_v8_targets ${plugin_dev_v8_name})
        else()
            get_filename_component(plugin_dev_v8_filename "${plugin_dev_v8_file}" NAME)
            set(plugin_dev_v8_release_file "${plugin_dev_v8_release_dir}/${plugin_dev_v8_filename}")
            set(plugin_dev_v8_debug_file "${plugin_dev_v8_debug_dir}/${plugin_dev_v8_filename}")
            if(NOT EXISTS "${plugin_dev_v8_release_file}" OR NOT EXISTS "${plugin_dev_v8_debug_file}")
                message(FATAL_ERROR "Missing Windows V8 runtime configuration: ${plugin_dev_v8_filename}")
            endif()
            string(MAKE_C_IDENTIFIER "cpd_v8_runtime_${plugin_dev_v8_name}" plugin_dev_v8_target)
            add_library(${plugin_dev_v8_target} SHARED IMPORTED)
            set_target_properties(${plugin_dev_v8_target} PROPERTIES
                IMPORTED_LOCATION "${plugin_dev_v8_release_file}"
                IMPORTED_LOCATION_DEBUG "${plugin_dev_v8_debug_file}"
            )
            list(APPEND plugin_dev_v8_targets ${plugin_dev_v8_target})
        endif()
    endforeach()
    list(REMOVE_DUPLICATES plugin_dev_v8_targets)
    set(V8_DLLS)
    foreach(plugin_dev_v8_target IN LISTS plugin_dev_v8_targets)
        if(NOT TARGET ${plugin_dev_v8_target})
            message(FATAL_ERROR "Missing Windows V8 imported target: ${plugin_dev_v8_target}")
        endif()
        add_custom_command(TARGET ${CC_EXECUTABLE_NAME} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "$<TARGET_FILE:${plugin_dev_v8_target}>"
                "$<TARGET_FILE_DIR:${CC_EXECUTABLE_NAME}>/$<TARGET_FILE_NAME:${plugin_dev_v8_target}>"
            VERBATIM
        )
    endforeach()
endif()

include("${CMAKE_CURRENT_LIST_DIR}/runtime-build.cmake")

if(CMAKE_BUILD_TYPE STREQUAL "RelWithDebInfo" AND USE_V8_DEBUGGER AND USE_V8_DEBUGGER_FORCE)
    # 官方 Game.cpp 通过 CC_DEBUG 启动 Inspector；引擎继续使用当前构建配置。
    set(plugin_dev_game_source "${CC_PROJECT_DIR}/../common/Classes/Game.cpp")
    if(NOT EXISTS "${plugin_dev_game_source}")
        message(FATAL_ERROR "Cannot enable Inspector: missing host Game.cpp at ${plugin_dev_game_source}")
    endif()
    set_property(SOURCE "${plugin_dev_game_source}" APPEND PROPERTY COMPILE_DEFINITIONS CC_DEBUG=1)
endif()
