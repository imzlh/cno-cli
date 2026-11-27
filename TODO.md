# TODO

## 当前状态（2026-11-27）

本文件只记录当前工作区的收口事项；历史审查记录不再作为当前状态依据。

### 已提交并验证

- 根仓 OXC decorators/Bun bundle 测试与锁文件：`6cf6d92`；`ext-oxc`：`471575f`。
- `circu.js` native teardown、asyncfs、streams、process 等改动：`1b98fca`。
- `ext-quic` handshake/socket cleanup 与跨 runtime class ID：`d1ce8ec`；独立 runtime-class 测试已通过。
- 根与 CTS type-check、根 CTest 15/15、Deno QUIC 集成测试通过。
- Bun CLI cache 测试（显式延长超时）及 fs errno parity 测试通过。

### 待收口工作区

- 仅待根仓提交 `circu.js`、`ext-quic` gitlink 更新、Bun core-runtime 断言和 QUIC worker fixture。
- OOM fixture headroom 未通过 32/64 MB 复现，已撤回，不纳入提交。

### 提交与验证规则

1. 先提交并验证嵌套仓，再更新根仓 gitlink。
2. 只暂存所属批次；保留无关 dirty 改动，不重置、不清理、不提交生成物。
3. native 构建保持单一 owner，最多使用 `-j2`；测试结果需对应当前源码和新鲜产物。
4. 最终检查根仓及全部嵌套仓状态、`git diff --check`，确认没有遗漏未跟踪测试或混入无关文件。
