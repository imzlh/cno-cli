# Build the N-API test fixture against host undefined N-API symbols (resolved by cno).
#
# The artifact name carries the host platform/arch because a .node is a native
# shared library: an ELF built here cannot be loaded by a Windows cno.exe. A
# stale wrong-format artifact is exactly what made process-dlopen.test.ts fail
# with "is not a valid Win32 application". Windows builds go through MSVC
# instead -- see cno.def and ensureNapiFixture() in process-dlopen.test.ts.
ROOT := $(abspath ../../../..)
INC  := $(ROOT)/circu.js/deps/nodeapi
CC   ?= gcc

UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_S),Darwin)
  PLATFORM := darwin
else
  PLATFORM := linux
endif
ifeq ($(UNAME_M),x86_64)
  ARCH := x64
else ifeq ($(UNAME_M),aarch64)
  ARCH := arm64
else ifeq ($(UNAME_M),arm64)
  ARCH := arm64
else
  ARCH := $(UNAME_M)
endif

OUT ?= cno_napi_fixture-$(PLATFORM)-$(ARCH).node

all: $(OUT)

$(OUT): addon.c
	$(CC) -shared -fPIC -O2 -o $@ $< -I$(INC) -Wl,--allow-shlib-undefined

clean:
	rm -f cno_napi_fixture*.node
