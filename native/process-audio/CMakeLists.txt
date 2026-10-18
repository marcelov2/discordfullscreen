cmake_minimum_required(VERSION 3.21)
project(harbor_process_audio LANGUAGES CXX)

add_executable(harbor-process-audio process_audio.cpp)
target_compile_features(harbor-process-audio PRIVATE cxx_std_17)
target_compile_definitions(harbor-process-audio PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(harbor-process-audio PRIVATE ole32 uuid user32 mmdevapi)

add_executable(harbor-audio-test-tone tone_test.cpp)
target_compile_features(harbor-audio-test-tone PRIVATE cxx_std_17)
target_compile_definitions(harbor-audio-test-tone PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(harbor-audio-test-tone PRIVATE winmm user32)
