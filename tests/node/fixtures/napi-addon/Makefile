# Build the N-API test fixture against host undefined N-API symbols (resolved by cno).
ROOT := $(abspath ../../../..)
INC  := $(ROOT)/circu.js/deps/nodeapi
OUT  := cno_napi_fixture.node

all: $(OUT)

$(OUT): addon.c
	gcc -shared -fPIC -O2 -o $@ $< -I$(INC) -Wl,--allow-shlib-undefined

clean:
	rm -f $(OUT)
