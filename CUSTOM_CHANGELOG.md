# CUSTOM CHANGELOG

本文件只记录 **wenxin1221-design/CFNext** 相对于上游 **PAICNI/CFNext** 的本地差异。

## stable-bestip-v1

- 新增可重复应用的本地补丁层：`custom/patch.mjs`。
- 新增定制项验证：`custom/verify.mjs`。
- 面板内“检查更新”改为检查本仓库，避免一键更新回退成未经定制的上游原版。
- `loadBalance` 默认值由 `true` 改为 `false`，保持订阅节点顺序稳定；运行期故障转移交给 OpenClash/Mihomo。
- 优选器默认数量由 20 改为 5，形成小而可观测的 CF-EDGE 池。
- `BESTIP_AUTO` 定时刷新改为状态化优选：
  - 当前节点与新候选共同复测；
  - 默认保留 3-5 个长期健康入口；
  - 默认 25 ms 防抖窗口；
  - 仅在现有节点失效或新候选有实质优势时替换；
  - 本轮测量失败时不覆盖 KV（Fail-Closed）。
- 新增环境变量：
  - `BESTIP_POOL_SIZE`：自动优选池大小，1-20，建议 3-5；
  - `BESTIP_HYSTERESIS_MS`：保留当前健康节点的延迟容忍窗口，默认 25 ms。
- 上游同步流程改为：拉取上游临时文件 → 应用本地补丁 → 验证定制项 → Wrangler dry-run → 提交。

> 上游 `VERSION` 不改名、不另起版本号。本地差异由 `CUSTOM_PATCHSET` 和本文件标识，便于判断“上游版本”和“本地补丁版本”两个维度。
