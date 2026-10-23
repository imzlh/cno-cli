# 流式 HTTP 代理内存诊断

上游和压测客户端使用 Node.js（建议 22 或更新），运行在独立进程；被测代理使用 cno。客户端逐块消费响应，不保存完整响应体。

在三个终端依次启动，命令均从仓库根目录执行：

```powershell
node scripts/diagnostics/streaming-upstream.mjs --bytes 1048576 --delay-ms 1
```

```powershell
.\build\stage\cno.exe --no-lock --inspect=127.0.0.1:9229 run scripts/diagnostics/streaming-proxy.ts
```

```powershell
node scripts/diagnostics/streaming-load.mjs --url http://127.0.0.1:8787/direct --requests 100 --concurrency 4
```

代理固定使用 `hono@4.12.27`。`/direct` 返回 fetch 得到的 Response，`/pipe` 使用 Hono 的 `stream().pipe()`，`/plain` 直接在 Deno.serve 中返回 fetch 的 Response。改变路由可以比较 Hono、流 API 和 HTTP 实现的影响。

在实际程序上测试时，把 `--url` 换成实际代理接口。`--timeout-ms` 是单个请求从发起到结束的总时限；慢速流需要适当提高时限。输出是 JSON 行，最后一行包含完成数、中断数、失败数、读取字节数和耗时。

## CDP 持续监控

另开一个终端连接已启用 `--inspect` 的被测进程：

```powershell
node scripts/diagnostics/monitor-memory-cdp.mjs --inspect=http://127.0.0.1:9229 --interval=2000 --duration=120 --gc-every=10 --output=memory.jsonl
```

每 2 秒采样，持续 120 秒，每 10 次采样执行 GC，记录到新建的 JSONL 文件。`--gc-every=0` 关闭手动 GC；对照实验可以分别记录自然 GC 和定期手动 GC 的结果。监控需要包含 `CNO.getMemoryUsage` 扩展的新版 cno；老版本会提示重建。JSONL 包含基线差值，执行 GC 的采样额外包含 `afterGC` 和回收的 VM 字节数。

## 对照场景

每轮结束后等待几秒再记录内存，并确认上游活动连接恢复到 0。首次启动会加载依赖、编译并建立缓存，应先跑一轮预热，然后比较相同负载下的多轮结果。

普通读完：

```powershell
node scripts/diagnostics/streaming-load.mjs --url http://127.0.0.1:8787/direct --requests 100 --concurrency 4
```

慢客户端：

```powershell
node scripts/diagnostics/streaming-load.mjs --url http://127.0.0.1:8787/pipe --requests 40 --concurrency 4 --slow-ms 10 --timeout-ms 60000
```

客户端读取第一块后断开；上游发出第一块后保持空闲，直到客户端断开或上游安全时限（默认 60 秒）到期。这样能检测响应读取任务被挂起时是否及时释放资源：

```powershell
node scripts/diagnostics/streaming-load.mjs --url 'http://127.0.0.1:8787/direct?idle=1' --requests 20 --concurrency 4 --abort-after-bytes 1024 --timeout-ms 5000
Invoke-RestMethod 'http://127.0.0.1:8788/stats'
```

预期压测结果 `aborted=20, failed=0`，上游 `active=0`。如果前 8 次中断后请求开始超时，通常表示被测进程的每主机 8 个 fetch 连接槽仍被空闲上游占据。随后再跑普通读完的场景，检查连接池能否继续工作。

上游参数可以通过代理 URL 转发，例如 `?bytes=33554432&chunk-bytes=16384&delay-ms=0`。`bytes` 为每个响应的字节数，`chunk-bytes` 为每块字节数，`delay-ms` 为上游块间隔。默认上游每个响应 8 MiB，本文启动命令将其设为 1 MiB。

上游响应头尚未返回时断开：

```powershell
node scripts/diagnostics/streaming-load.mjs --url 'http://127.0.0.1:8787/direct?headers-delay-ms=2000' --requests 20 --concurrency 4 --abort-after-ms 100 --timeout-ms 5000
```

压缩上游的大响应，检查解压后的数据是否遵守慢客户端的背压：

```powershell
node scripts/diagnostics/streaming-load.mjs --url 'http://127.0.0.1:8787/pipe?gzip=1&bytes=33554432&delay-ms=0' --requests 8 --concurrency 2 --slow-ms 20 --timeout-ms 120000
```

上游会持续重复字符以获得高压缩比，`bytes` 和上游统计中的 `bytes` 表示压缩前大小。代理 fetch 解压后，客户端应读取每个响应 32 MiB。直接压测 Node 上游时，压测器读取的是 gzip 压缩字节。

## 内存读数

fixture 提供 `GET /memory`，返回 cno 原生内存计数；`?gc=1` 执行两次 GC，期间留出一个事件循环轮次。

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/memory?gc=1'
```

`os.rss` 是整个进程的驻留内存，包括原生资源及工作线程；`vm.used`、`used` 和 `object.count` 来自主线程 QuickJS。GC 后这些计数每轮持续上涨更像引用未释放；仅 RSS 上涨还可能包括原生缓冲区、分配器缓存或其他线程。`buffer.used` 和 `buffer.count` 表示序列化字节码对象，不是 ArrayBuffer 的总量。

这些计数用于缩小范围，不提供对象引用链。CDP 监控能另外检查 inspector 留存的远程对象、请求体缓冲区和活动流。

## 验证诊断客户端

```powershell
node --test scripts/diagnostics/streaming-load.test.mjs
```

测试验证完整响应、慢读、第一块后断开、响应头前断开、压缩响应、空闲响应超时和非法上游参数。停止常驻服务可使用 Ctrl+C。

## devid 实际路由回归

相邻目录的 `devid/tests/proxy-memory-fixture.ts` 使用真实代理路由，省去来源发现和 FFmpeg。先完成 cno 构建并准备依赖缓存，再运行：

```powershell
node scripts/diagnostics/devid-memory-audit.mjs --devid ../devid --binary build/stage/cno.exe --cache build/audit-devid-20261023-cache --rounds 4 --output build/devid-memory-audit.jsonl
.\build\stage\cno.exe test tests/node/native-stream-read-oom.test.ts tests/webapi/abort-signal-lifetime.test.ts tests/webapi/finalization-registry-lifetime.test.ts
```

压测在 32/64 MiB 限制下覆盖完整读取、慢读、响应头前断开、空闲流断开、分片转发、错误响应、Range 和 HEAD。每批等待上游活动连接回到零，再执行 GC 并记录 VM 内存和对象数；每轮残留增长超过 64 KiB 即失败。低内存读取测试在 TS 子进程中制造八次 OOM，同时检查回调错误、缓冲区释放、读取对象回收和退出诊断。
