# CFNext Customized — Pages Native

本仓库是 **PAICNI/CFNext 的定制维护分支**。生产部署采用 **Cloudflare Pages Advanced Mode**，而不是独立 Worker 作为正式入口。

> 上游：`PAICNI/CFNext`  
> 定制仓库：`wenxin1221-design/CFNext`  
> 本地补丁集：`stable-bestip-v1`  
> 生产项目：`cfnext-pages`  
> 生产域名：`cfnext.851221.xyz`  
> 生产分支：`main`

---

## 1. 当前生产架构

```text
PAICNI/CFNext
      │
      │ 每日检查上游 main
      ▼
wenxin1221-design/CFNext
      │
      ├── custom/patch.mjs
      ├── custom/verify.mjs
      └── CFNext 明文版.js
      │
      │ git push / merge → main
      ▼
Cloudflare Pages: cfnext-pages
      │
      │ Build command: npm run build:pages
      │ Output directory: dist
      ▼
dist/_worker.js
      │
      ▼
Pages Advanced Mode
      │
      ▼
https://cfnext.851221.xyz
```

生产流量以 **cfnext-pages** 为准。

仓库历史上还存在一个独立 Cloudflare Worker `cfnext`。它不是生产域名 `cfnext.851221.xyz` 的正式入口；在 Pages-native 架构验证稳定后，应停止它的自动构建与 Cron，暂不急于删除，以便短期回退。

---

## 2. 继承自哪里

本仓库继承：

- 上游仓库：`PAICNI/CFNext`
- 上游分支：`main`
- 上游核心源码：`CFNext 明文版.js`
- 上游版本号：继续使用上游 `VERSION`
- 当前上游提交：记录在 `UPSTREAM_COMMIT`

本仓库**不伪造一个新的上游版本号**。

例如：

```text
VERSION = 2.3.0
CUSTOM_PATCHSET = stable-bestip-v1
```

含义是：

```text
上游能力版本：CFNext 2.3.0
本地差异版本：stable-bestip-v1
```

这样可以同时回答两个问题：

1. 当前基于上游哪个版本？
2. 当前又叠加了哪些本地修改？

---

## 3. 我们自己修改了什么

所有本地差异必须可追踪，详细记录见：

```text
CUSTOM_CHANGELOG.md
```

当前主要修改如下。

### 3.1 可重复应用的补丁层

不把长期修改只写死在生成后的 `CFNext 明文版.js` 中。

本地修改的源头是：

```text
custom/patch.mjs
```

流程：

```text
上游 CFNext 明文版.js
        ↓
custom/patch.mjs
        ↓
定制 CFNext 明文版.js
        ↓
custom/verify.mjs
        ↓
允许构建
```

如果上游代码结构发生变化，导致补丁锚点失效，补丁脚本会报错停止，不能静默丢失本地定制。

这是 **Fail-Closed**。

### 3.2 更新检查改为本仓库

面板内更新来源由上游仓库改为：

```text
wenxin1221-design/CFNext
```

避免面板更新时直接拿上游原版覆盖本地定制。

### 3.3 稳定优先的 CF-EDGE 策略

默认：

```text
loadBalance = false
optimizer.count = 5
```

职责分工：

- CFNext：生成小而稳定的候选池；
- OpenClash / Mihomo：负责客户端实际健康检查与故障切换。

不让 CFNext 每次刷新订阅都随机洗牌。

### 3.4 Stateful Best-IP

自动优选不再简单执行：

```text
每次测速 → Top N → 全量覆盖
```

而是：

```text
现有优选池
    +
新候选池
    ↓
共同复测
    ↓
现有节点仍健康且差距很小？
    ├── 是 → 保留
    └── 否 → 才替换
```

默认：

```text
BESTIP_POOL_SIZE = 5
BESTIP_HYSTERESIS_MS = 25
```

测量失败时：

```text
不清空 preferredIPs
不强制替换
保留上一版 KV
```

### 3.5 定制版本身份

生产面板可以明确区分“上游原版”和“本地定制版”。

`/version` 返回类似：

```json
{
  "version": "2.3.0",
  "patchset": "stable-bestip-v1",
  "repo": "wenxin1221-design/CFNext",
  "upstream": "PAICNI/CFNext"
}
```

面板左下角显示类似：

```text
v2.3.0 明文版 · Custom v1
```

---

## 4. 为什么改成 Pages-native

此前 `cfnext-pages` 的构建命令是：

```bash
mkdir -p dist && unzip -p 'CFNext 混淆Pages版.zip' _worker.js > dist/_worker.js
```

这个流程的问题是：

```text
GitHub 中的定制 CFNext 明文版.js
          ×
没有进入生产
```

Pages 实际发布的是上游 ZIP 中旧的 `_worker.js`。

所以即使 GitHub `main` 已经更新，生产域名仍可能显示旧逻辑。

新的生产构建命令统一为：

```bash
npm run build:pages
```

构建过程：

```text
CFNext 明文版.js
    ↓
verify:custom
    ↓
scripts/build-pages.mjs
    ↓
dist/_worker.js
    ↓
scripts/verify-pages.mjs
```

Cloudflare Pages 直接部署 `dist/_worker.js`，使用 Pages Advanced Mode。

---

## 5. Cloudflare Pages 生产配置

当前正式项目：

```text
cfnext-pages
```

正式域名：

```text
cfnext.851221.xyz
```

Git：

```text
Repository: wenxin1221-design/CFNext
Production branch: main
Output directory: dist
Build command: npm run build:pages
```

### 5.1 生产环境必须保留

Cloudflare Pages Dashboard 中：

- 环境变量 `U`：已配置；
- KV Binding `K`：绑定现有 `CFNEXT` 命名空间；
- Compatibility Date：保持现有生产设置。

**不要把 `U`、管理密码、Token 等私密配置提交进公开仓库。**

### 5.2 Preview 环境

当前 Preview 环境没有生产的 `U` 与 `K`。

因此 Preview 部署主要用于验证：

- 构建是否成功；
- `dist/_worker.js` 是否生成；
- Pages Functions 是否能部署。

不能把 Preview 上的“面板无法完整登录/配置无法持久化”直接判定为生产代码故障。

如以后需要完整预览环境，应单独给 Preview 配置测试用变量与测试 KV，不要直接复用生产秘密。

---

## 6. Best-IP 在 Pages 中如何定时运行

Cloudflare Pages 与独立 Worker 的 Cron Trigger 不是同一个部署模型。

因此生产 Pages **不依赖旧 Worker 的 `triggers.crons`**。

代码提供受保护入口：

```text
POST /_ops/bestip-refresh
Authorization: Bearer <BESTIP_CRON_TOKEN>
```

需要同时配置：

### Cloudflare Pages Production

```text
BESTIP_AUTO=1
BESTIP_POOL_SIZE=5
BESTIP_HYSTERESIS_MS=25
BESTIP_CRON_TOKEN=<随机秘密>
```

### GitHub Actions Secret

```text
BESTIP_CRON_TOKEN=<与 Pages 相同>
```

定时任务：

```text
.github/workflows/bestip-refresh.yml
```

默认每 6 小时调用一次生产刷新接口。

如果 GitHub Secret 未配置，工作流会安全跳过，不会带空 Token 请求生产接口。

---

## 7. 上游每天更新时怎么处理

上游检查工作流：

```text
.github/workflows/sync-upstream.yml
```

当前每天执行一次，也可以手动触发。

完整流程：

```text
PAICNI/CFNext main
        ↓
读取上游 CFNext 明文版.js
        ↓
记录 UPSTREAM_COMMIT
        ↓
应用 custom/patch.mjs
        ↓
custom/verify.mjs
        ↓
npm run build:pages
        ↓
verify-pages
        ↓
全部成功？
   ┌────┴────┐
   │         │
  YES       NO
   │         │
提交 main   停止
   │         │
Pages自动部署  保持旧生产版本
```

---

## 8. 如果上游只是普通升级

例如：

```text
2.3.0 → 2.4.0
```

如果补丁锚点仍兼容：

```text
自动拉取
→ 自动套补丁
→ 自动验证
→ 自动生成 Pages artifact
→ 自动提交 main
→ Pages 自动部署
```

无需人工处理。

---

## 9. 如果上游重构导致补丁失败

例如上游：

- 删除或改名 `loadBalance`；
- 重写 `DEFAULT_CONFIG`；
- 重写 `handleScheduled()`；
- 修改面板状态区；
- 修改版本检查结构。

那么：

```text
custom/patch.mjs
找不到唯一锚点
      ↓
Action 失败
      ↓
不提交 main
      ↓
Cloudflare Pages 不发布坏版本
```

人工处理步骤：

1. 查看上游新版本变更；
2. 查看 `CUSTOM_CHANGELOG.md`；
3. 判断现有定制是否仍需要；
4. 修改 `custom/patch.mjs`；
5. 必要时修改 `custom/verify.mjs`；
6. 执行 `npm run check`；
7. 在非生产分支验证 Pages Preview 构建；
8. 合并到 `main`；
9. 检查生产 `/version`；
10. 检查面板与订阅。

---

## 10. 哪些文件应该修改

长期维护时优先修改：

```text
custom/patch.mjs
custom/verify.mjs
scripts/build-pages.mjs
scripts/verify-pages.mjs
CUSTOM_CHANGELOG.md
README.md
.github/workflows/*.yml
package.json
```

`CFNext 明文版.js` 是：

> 上游源码 + 本地补丁后的可部署源码。

新增长期功能时，不能只手改生成文件而不更新补丁层。

---

## 11. 仓库结构

```text
CFNext/
├── CFNext 明文版.js
├── CFNext 混淆Pages版.zip       # 仅保留上游制品，不再作为生产构建入口
├── CFNext 混淆版.js
├── UPSTREAM_COMMIT
│
├── README.md
├── CUSTOM_CHANGELOG.md
├── package.json
├── package-lock.json
│
├── custom/
│   ├── patch.mjs
│   └── verify.mjs
│
├── scripts/
│   ├── build-pages.mjs
│   └── verify-pages.mjs
│
└── .github/
    └── workflows/
        ├── sync-upstream.yml
        ├── validate-custom.yml
        └── bestip-refresh.yml
```

生产构建产生：

```text
dist/
├── _worker.js
└── build-meta.json
```

`dist/` 不提交 Git。

---

## 12. 发布前验证

### 仓库侧

```bash
npm ci
npm run check
```

必须通过：

- custom invariant；
- Pages artifact 构建；
- Pages artifact 结构校验。

### Cloudflare 侧

合并 `main` 后确认：

```text
cfnext-pages
→ Production deployment
→ commit 与 GitHub main 一致
```

### 线上

访问：

```text
https://cfnext.851221.xyz/version
```

必须能看到：

```json
{
  "version": "...",
  "patchset": "stable-bestip-v1",
  "repo": "wenxin1221-design/CFNext",
  "upstream": "PAICNI/CFNext"
}
```

然后检查面板左下角是否出现：

```text
Custom v1
```

最后检查原订阅地址是否仍可正常刷新。

---

## 13. 回滚

### 代码回滚

如果新版本异常：

1. 回退 GitHub `main` 到上一个已知正常提交；
2. Pages 自动重新部署；
3. 验证 `/version`；
4. 验证订阅和面板。

### 上游 / 本地问题隔离

`UPSTREAM_COMMIT` 用于定位当前上游基线。

如果怀疑本地补丁：

```text
同一 UPSTREAM_COMMIT
├── 原始上游代码
└── 应用 stable-bestip-v1 后的代码
```

对比即可判断故障来自上游还是本地修改。

### 独立 Worker

在 Pages-native 生产验证完成前，旧 `cfnext` Worker 暂时保留作为短期回退参考。

确认 Pages 连续稳定后：

- 关闭旧 Worker 的 Git 自动部署；
- 关闭旧 Worker Cron；
- 不再把它作为生产维护对象。

删除资源应作为单独操作，不和本次迁移混在一起。

---

## 14. 上游版权与致谢

本仓库不是独立原创项目。

核心协议、面板、代理与订阅能力来自：

`PAICNI/CFNext`

本仓库维护的是：

- 可重复应用的本地补丁；
- 稳定 Best-IP 策略；
- OpenClash 配合策略；
- Pages-native 构建与部署链；
- 自动同步、验证与回滚规范。

上游：

https://github.com/PAICNI/CFNext
