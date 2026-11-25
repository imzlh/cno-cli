if(NOT UNIX)
    message(FATAL_ERROR "The pinned quicly backend requires POSIX. Configure with -DCNO_EMBED_EXT_QUIC=OFF on this platform.")
endif()

set(_QUICLY "${CMAKE_CURRENT_SOURCE_DIR}/ext-quic/deps/quicly")
set(_PICOTLS "${_QUICLY}/deps/picotls")
if(NOT EXISTS "${_QUICLY}/lib/quicly.c" OR NOT EXISTS "${_PICOTLS}/lib/picotls.c"
    OR NOT EXISTS "${_QUICLY}/deps/klib/khash.h")
    message(FATAL_ERROR "QUIC sources are missing. Run git submodule update --init --recursive ext-quic "
        "or configure with -DCNO_EMBED_EXT_QUIC=OFF.")
endif()

if(CNO_STATIC_LINK)
    set(OPENSSL_USE_STATIC_LIBS TRUE)
endif()
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)

add_library(cno_quic_transport STATIC
    "${_QUICLY}/lib/cc-cubic.c"
    "${_QUICLY}/lib/cc-pico.c"
    "${_QUICLY}/lib/cc-reno.c"
    "${_QUICLY}/lib/defaults.c"
    "${_QUICLY}/lib/frame.c"
    "${_QUICLY}/lib/local_cid.c"
    "${_QUICLY}/lib/loss.c"
    "${_QUICLY}/lib/quicly.c"
    "${_QUICLY}/lib/ranges.c"
    "${_QUICLY}/lib/rate.c"
    "${_QUICLY}/lib/recvstate.c"
    "${_QUICLY}/lib/remote_cid.c"
    "${_QUICLY}/lib/sendstate.c"
    "${_QUICLY}/lib/sentmap.c"
    "${_QUICLY}/lib/streambuf.c"
    "${_PICOTLS}/lib/hpke.c"
    "${_PICOTLS}/lib/openssl.c"
    "${_PICOTLS}/lib/pembase64.c"
    "${_PICOTLS}/lib/picotls.c")
target_include_directories(cno_quic_transport SYSTEM PUBLIC "${_QUICLY}/include" "${_PICOTLS}/include")
target_include_directories(cno_quic_transport PRIVATE "${_QUICLY}/deps/klib")
target_compile_definitions(cno_quic_transport PRIVATE $<$<PLATFORM_ID:Linux>:_GNU_SOURCE>)
target_link_libraries(cno_quic_transport PUBLIC OpenSSL::Crypto Threads::Threads m ${CMAKE_DL_LIBS})
set_target_properties(cno_quic_transport PROPERTIES
    C_STANDARD 11 C_STANDARD_REQUIRED ON POSITION_INDEPENDENT_CODE ON)
