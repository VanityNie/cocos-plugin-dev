if(TARGET binary_symbols)
    return()
endif()
add_subdirectory("${CMAKE_CURRENT_LIST_DIR}/../src" "${CMAKE_BINARY_DIR}/plugins/binary-symbols")
