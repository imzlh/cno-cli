# TODO

记录检查 evbus 接线过程中发现的问题与原因。已修复的条目保留原委，供后续追溯；
未解决条目按影响排列。复核方式：跑对应测试文件即可复现/确认。

## 未解决

### 1. cli-stage.test.ts 贴着文件级 60s 预算，负载稍高就整体超时
- 现象：整文件 71 个测试以 ~0.85s/个均匀推进，无单点挂死；`cno eval` 启动
  ~0.55s。总耗时 ~60.4s，撞上 test runner 的 `runOne` 60000ms 文件预算，
  报 "test worker timed out without reporting a result"（后 16 个测试没跑）。
- 原因：该文件每个用例都 spawn 子进程且预算按文件计；后台负载（如本会话的
  常驻进程）把它推过线。与接线迁移无关（节奏均匀、单测全部单独通过）。
- 建议：把文件拆成 2~3 个，或给 runner 增加按文件覆盖超时的参数。

### 2. `scheduler.postTask` 从未被安装，测试长期失败
- 现象：`tests/webapi/scheduler.test.ts` 断言 `globalThis.scheduler` 存在，
  实际 `undefined`。
- 原因：`cno/src/webapi/scheduler.ts` 自 v2.9.2 起没有任何 bootstrap 路径
  import 它（webapi/index.ts、deno/index.ts 均无引用），属于断线的功能模块。
- 建议：要么在 webapi bootstrap 挂上（lazy 安装即可），要么删除模块和测试。

### 3. structuredClone 对视图克隆报 `RangeError: invalid offset`
- 现象：`tests/webapi/basic.test.ts` 的 "built-in clones use internal slots"
  在 `cloneView`（`<core>:52836`）抛 RangeError。
- 原因：structured-clone 的 ArrayBufferView 克隆路径对 offset/length 组合
  计算有误（`cno/src/node/_internal/structured-clone.ts` 一带），与接线无关。
- 建议：以该测试为回归用例修 cloneView 的 offset 处理。

### 4. CDP Network 的 responseReceived 在重定向后上报 pre-redirect URL
- 现象：`tests/node/cdp-network-lifecycle.test.ts` "EXPECTED-RED" 用例拿到
  重定向前的 URL 与 200 状态的配对，服务器从未发过该组合。
- 原因：`cno/src/webapi/fetch/perform.ts:441` 对 onResponse 钩子始终传
  发起请求的 `url.href`，未用重定向后最终 URL。
- 建议：onResponse 时改传当前（最后一次）请求 URL；注意 connect/upgrade 路径。

### 5. async_hooks 的 AsyncLocalStorage 跨 promise/timer 边界丢失
- 现象：`tests/node/async-hooks*.test.ts` propagation 用例拿到 `undefined`。
- 原因：ALS 传播依赖的 async hook 装载/续接点缺失，属于 async_hooks 域，
  与 evbus 接线无关。
- 建议：在 promise job 与 uv timer 的续接处补 store 传递。

### 6. 其余 tests/cts、tests/webapi 的预先存在失败（与接线无关，均为进行中的
    Bun/npm/dns 改动引入）
- `tests/cts/linker.test.ts` — "store-read-only contract"：npm-mode linker
  向 store 包内写了 node_modules，违反存储只读契约。
- `tests/cts/http-core.test.ts` — dns-cache 字面量地址命中时仍触达缓存。
- `tests/cts/kernel-lifecycle.test.ts` — `src/kernel.ts:139` 解构
  `kernel.modules` 为 undefined（openKernelRuntime 在部分路径下未填充 modules）。
- `tests/cts/require-resolve-no-fetch.test.ts` /
  `precache-compile-policy.test.ts` — 结构断言测试：源码里被依赖的注释/早退
  分支被后续编辑移除（这两个测试本质是源码形状的回归钉，改代码时要同步改钉）。
- `tests/cts/resource-limits.test.ts` — 两个纯内存分配用例（"refuses
  allocation past the cap"、"OOM is a catchable exception"）行为变化。
- `tests/cts/cache-command.test.ts`、`task-shell.test.ts` — 超时类，随机器
  负载波动，需复核是否真实回归。
- `tests/webapi/` — h1/h2-body-cap、locks-broadcast（BroadcastChannel 跨
  worker 消息超时）、abort-signal-lifetime、console-upstream、
  finalization-registry-lifetime、proxy-env-precedence、streams-terminal-lifetime。
  多为 lifetime/timing 类，建议逐个与 Node oracle 差分后定性。

### 7. node 宿主测试没有跳过机制，`cno test` 会误扫并报失败
- 现象：`tests/cts/evbus-exit-code.test.mjs`、`evbus-module-bridge.test.mjs`、
  `event-mux-realms.test.mjs` 头部注明 `node --test`，但 cno runner 的
  `TEST_RE` 扫所有 `[._]test.[jt]sx?`，在 cno 宿主下因宿主能力差异失败
  （esbuild 需 worker_threads 的 MessagePort 转移；`node:vm` 上下文在 cno
  下映射为只有 BaseObjects+Eval 的 Sandbox，无 RegExp/Map/Set）。
- 建议：给 runner 加 skip 约定（如文件头 `@cno-host: false` 或目录约定），
  并在 AGENT.md 的 lane 说明处链接。

## 本轮已修复（保留原因，防回归）

### 8. bridge.ts 在沙箱 realm 使用 `Set`（真回归）
- 现象：`tests/cts/evbus-module-bridge-native.test.mjs` 在 node 与 cno 双宿主
  失败，报 `Set is not defined`。
- 原因：`cts/src/compile/bridge.ts` 的 `installInternalBridge` 新增
  `[...new Set([...builtinModuleNames(), ...BUN_MODULES])]`，而
  `engine.Sandbox` 只加 BaseObjects+Eval intrinsic（`mod_engine.c:540`），
  桥必须在沙箱内可安装。
- 修复：改为无 Set 的 `includes` 合并。该测试就是防此约束的，改 bridge 时
  必须保持沙箱安全。

### 9. 陈旧 polyfill 缓存与二进制混合 → process 事件双桥
- 现象：`tests/cts/process-event-bridge.test.ts` 每个 process 事件触发两次
  （`2 !== 1`），且 `getEventMux().has('node-process')` 为 true。
- 原因：`~/.cts/node/process/mod.ts` 是 10-29 的旧版（经 CTS mux 注册
  `'node-process'` 角色），与新二进制里直连 evbus 的新版同时存活，形成两个
  桥。修复手段是 `cno setup` 刷新缓存。
- 教训：Node polyfill 编辑后必须 `setup`；"混合版本故障看起来像接线 bug"
  已写入 AGENT.md。

### 10. CTS rejection 桥是冗余接线（已删除）
- 原因：旧设计里 `process` 懒加载、bridge 靠 `retryEventBridge` 补装，CTS
  需要经 `Symbol.for('cno.node.process.default')` 全局槽探测 node emitter
  兜底。`inject.ts` 改为急切安装 `process` 后，CNO 的桥必然先于任何事件
  订阅，CTS 副本使每个 rejection 被投递两次、靠 `ctx.rejectionEmitted`
  去重，并构成分层违规（cts 感知 node 对象）。
- 修复：删除 `installNodeProcessRejectionBridge` 与探测路径；rejection
  投递由 `cno/src/node/process/mod.ts` 独占。返回极性文档已移入
  `event-mux.d.ts`（UNHANDLED_REJECTION `false`=不中止，与 JOB_EXCEPTION
  相反，曾因写反发过真 bug）。

### 11. 跨子模块接线残留全局对象 / C 模块对象（已全部收归 evbus）
- 清单（迁移前）：裸全局 `__mainScript`、`__cno_worker_runtime_config`、
  `__cno_resolve_blob_url`、`__cno_applyLocation`；C 模块对象通道
  `http.__cno`、`debug.__cnoNetworkHooks`、`os.__cno_args` /
  `os.__cno_process_args_refresh`；legacy 双写槽
  `Symbol.for('cno.runtime.requestExitCode')`、`Symbol.for('cts.internal')`；
  死接线 `cno.node.process.lazy`（无写入方）、`cno.runtime.inTeardown`
  （注释称 CLI 读取，实际无读者，HEAD 亦然）。
- 现契约：全部走 evbus 值通道（`cno.runtime` / `cno.inspector` / `cno.node` /
  `cno.args` / `cts.internal`），无 globalThis/Symbol 回退；版本偏差靠
  `cno setup` 纪律。契约表在 AGENT.md "evbus" 一节，新增通道须先入表。

### 12. internal-registry 无 bus 时身份不稳定
- 原因：`ensureInternalBridge` 在 evbus 缺失分支每次返回新 `{}`，同一 realm
  两次调用得到不同桥对象，下游 `nodeModuleInterop` 判定失效。
- 修复：补模块级 `localBridge` 回退，缺失 bus 时退化为 realm 内单例。

### 13. 裸 CJS 无法解析 `import.meta`（测试踩坑，非运行时 bug）
- 现象：worker-runtime-config 测试的 `worker.cjs` 用 `import.meta.use` 读
  配置，worker 报 `SyntaxError: import.meta only valid in module code`。
- 原因：polyfill 源码经 CTS transform 重写 `import.meta.use`，而用户侧裸
  .cjs 文件不走该重写。
- 修复：测试 worker 改用 ESM（.mjs / eval ESM）。给用户侧代码写文档时
  注意：`import.meta.*` 只能出现在模块源，不能出现在裸 CJS。
