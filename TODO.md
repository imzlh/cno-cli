# TODO

## 当前状态（2026-11-27）

本文件只记录当前工作区的收口事项；历史审查记录不再作为当前状态依据。

### 已提交并验证

- 根仓 OXC decorators/Bun bundle 测试与锁文件：`6cf6d92`；`ext-oxc`：`471575f`。
- `circu.js` native teardown、asyncfs、streams、process 等改动：`1b98fca`。
- OXC Rust 测试 12/12、定向 decorators/Bun 测试、根与 CTS type-check 通过。
- 根 native binary 已重建；根 CTest 15/15 通过。
- Deno QUIC 集成测试、Bun CLI cache 测试（显式延长超时）通过。

### 待收口工作区

- `circu.js` 子仓已干净；根仓仍需单独提交 `circu.js` gitlink 更新。
- `ext-quic` 子仓仍有 `CMakeLists.txt`、`native.c`、`native.h` 和 `tests/` 改动；需先完成审计与测试，再提交子仓及根仓 gitlink。
- `tests/deno/fixtures/quic-worker.ts` 是现有 QUIC 测试依赖，必须随 QUIC 批次保留。
- `tests/node/fs-errno-parity.test.ts` 的 `fchmod` 契约修改需与对应 native gitlink 一起提交；不能单独提交测试契约。
- `tests/bun/cli-cache.test.ts` 的超时预算调整待确认是否作为测试稳定性修复提交。
- `tests/node/fixtures/stream-read-oom.ts` 的 headroom 修改未通过 32/64 MB 复现，不提交。

### 提交与验证规则

1. 先提交并验证嵌套仓，再更新根仓 gitlink。
2. 只暂存所属批次；保留无关 dirty 改动，不重置、不清理、不提交生成物。
3. native 构建保持单一 owner，最多使用 `-j2`；测试结果需对应当前源码和新鲜产物。
4. 最终检查根仓及全部嵌套仓状态、`git diff --check`，确认没有遗漏未跟踪测试或混入无关文件。
