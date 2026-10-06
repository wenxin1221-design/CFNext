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
- 面板增加运行版本身份标识：
  - 左下角显示 `v<上游版本> <部署形态> · Custom <本地补丁简称>`；
  - “运行状态”和“面板设置”显示完整 `CUSTOM_PATCHSET`、本仓库与上游仓库；
  - `/version` 与 `/api/status` 返回 `patchset/repo/upstream`，便于人工及自动巡检确认当前运行的是定制版。

> 上游 `VERSION` 不改名、不另起版本号。本地差异由 `CUSTOM_PATCHSET` 和本文件标识，便于判断“上游版本”和“本地补丁版本”两个维度。


## Deployment architecture: pages-native-v2

- 正式生产入口统一为 Cloudflare Pages 项目 `cfnext-pages`。
- 正式域名统一为 `cfnext.851221.xyz`。
- Pages 构建入口由“解压 `CFNext 混淆Pages版.zip`”改为 `npm run build:pages`。
- `scripts/build-pages.mjs` 从已应用本地补丁的 `CFNext 明文版.js` 生成 `dist/_worker.js`。
- `scripts/verify-pages.mjs` 校验 Pages Advanced Mode 产物。
- 删除根目录 Worker 专用 `wrangler.jsonc`，防止误把独立 Worker 当生产部署入口。
- Pages 生产继续沿用现有 `U` 环境变量和 `K -> CFNEXT` KV 绑定，不把敏感配置提交到公开仓库。
- Best-IP 自动刷新改为 Pages 可用模式：
  - 复用 `refreshBestIPs()`；
  - 受保护入口 `POST /_ops/bestip-refresh`；
  - 使用 `BESTIP_CRON_TOKEN` Bearer Token；
  - GitHub Actions `bestip-refresh.yml` 每 6 小时触发一次；
  - 未配置 Token 时安全跳过。
- 旧独立 Worker `cfnext` 暂时保留为迁移期回退参考，Pages 验证稳定后再关闭其自动部署和 Cron。
