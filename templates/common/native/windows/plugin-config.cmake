# Loaded by official plugins_parser.js -> find_package({{TARGET}}).
if(NOT TARGET {{TARGET}})
    add_subdirectory(
        "${CMAKE_CURRENT_LIST_DIR}/../src"
        "${CMAKE_BINARY_DIR}/plugins/{{NAME}}"
    )
endif()
