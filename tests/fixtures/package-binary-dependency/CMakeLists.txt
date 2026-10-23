cmake_minimum_required(VERSION 3.20)
project(cpd_runtime_math LANGUAGES CXX)
add_library(cpd_runtime_math SHARED math.cpp)
target_compile_features(cpd_runtime_math PRIVATE cxx_std_17)
set_target_properties(cpd_runtime_math PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CPD_DEPENDENCY_OUTPUT}"
    ARCHIVE_OUTPUT_DIRECTORY "${CPD_DEPENDENCY_OUTPUT}"
)
