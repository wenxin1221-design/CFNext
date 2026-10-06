# CFNext Customized

本仓库是 **CFNext 的定制维护分支**。目标不是脱离上游，而是在保留上游快速演进能力的同时，增加适合本项目使用场景的稳定优选与可维护升级机制。

> 当前上游：**PAICNI/CFNext**  
> 当前本地补丁集：**stable-bestip-v1**  
> 定制仓库：**wenxin1221-design/CFNext**

---

## 1. 继承关系

本仓库继承自：

- 上游项目：`PAICNI/CFNext`
- 上游主分支：`main`
- 上游核心文件：`CFNext 明文版.js`
- 上游版本号：沿用上游 `VERSION`，不自造版本号
- 本地差异版本：使用 `CUSTOM_PATCHSET` 标记

也就是说：

```
PAICNI/CFNext
      │
      │  拉取上游 main
      ▼
上游 CFNext 明文版.js
      │
      │  custom/patch.mjs
      ▼
wenxin1221-design/CFNext
定制 CFNext 明文版.js
      │
      │  custom/verify.mjs
      │  wrangler dry-run
      ▼
允许进入 main / 部署
```

### 为什么不直接长期魔改单文件

如果直接修改 `CFNext 明文版.js`，上游更新时很容易出现两种问题：

1. 自动同步覆盖本地改动；
2. 人工合并后漏掉某一项定制。

因此本仓库采用 **“上游原版 + 可重复应用补丁层”**：

- 上游代码是基础；
- 本地定制集中在 `custom/patch.mjs`；
- 本地约束集中在 `custom/verify.mjs`；
- 差异说明集中在 `CUSTOM_CHANGELOG.md`。

---

## 2. 本仓库自己修改了什么

当前补丁集：`stable-bestip-v1`。

### 2.1 更新来源改为本仓库

上游代码里的面板更新检查默认指向：

```
PAICNI/CFNext
```

本仓库改为：

```
wenxin1221-design/CFNext
```

原因是：如果面板直接拉取上游代码，会绕过本地补丁层，导致本地定制消失。

### 2.2 默认关闭订阅随机洗牌

上游默认：

```
loadBalance = true
```

本仓库默认：

```
loadBalance = false
```

原因：

- CFNext 负责生成稳定候选池；
- OpenClash / Mihomo 负责运行期健康检查、延迟检测和故障切换；
- 不希望每次刷新订阅时都改变节点顺序。

如确实需要上游行为，仍可在面板手动重新开启。

### 2.3 优选池默认从 20 个收敛到 5 个

本仓库默认：

```
optimizer.count = 5
```

目标是构建小而稳定的 CF-EDGE 池，避免：

- 节点过多；
- 客户端探测噪声；
- 订阅体积膨胀；
- 因为微小延迟变化导致节点频繁漂移。

建议范围：

```
3 ~ 5
```

### 2.4 自动优选改为状态化优选

上游自动优选逻辑更偏向：

```
每次测量
→ 排名
→ 取 Top N
→ 覆盖 preferredIPs
```

本仓库改为：

```
现有优选池
      +
新候选池
      ↓
共同复测
      ↓
当前节点仍健康？
      │
      ├─ 是，且性能仍在容忍窗口内 → 保留
      │
      └─ 否 → 用新节点替换
      ↓
最终保持 3~5 个稳定节点
```

默认防抖阈值：

```
25 ms
```

也就是说，新节点只是比现有节点快几毫秒时，不触发替换。

### 2.5 自动优选 Fail-Closed

如果某次自动任务出现：

- 外部候选源不可达；
- 测速失败；
- 结果为空；
- 代码异常；

则：

```
保留上一版 preferredIPs
不写空池
不强制切换
```

这与本项目“稳定优先、可回退”的原则一致。

### 2.6 新增环境变量

| 变量 | 默认 | 说明 |
|---|---:|---|
| `BESTIP_AUTO` | 关闭 | `1` / `true` 时启用 Worker 定时自动优选 |
| `BESTIP_POOL_SIZE` | 5 | 优选池大小，允许 1-20，建议 3-5 |
| `BESTIP_HYSTERESIS_MS` | 25 | 当前健康节点的延迟容忍窗口 |
| `YXURL` | 空 | 自定义候选优选数据源 |
| `YX` | 空 | 手工优选 IP 列表 |

### 2.7 Worker Cron Trigger

`wrangler.jsonc` 中声明：

```
43 */6 * * *
```

即每 6 小时触发一次 Worker `scheduled()`。

注意：

- GitHub Actions 每 6 小时：负责**检查上游代码是否更新**；
- Worker Cron 每 6 小时：负责**运行期优选 IP 刷新**。

这是两个完全不同的任务。

如果 `BESTIP_AUTO` 未设置为 `1` / `true`，Worker Cron 会触发，但不会改写优选池。

---

## 3. 上游每次改变时，我们怎么做

这是本仓库最重要的维护规则。

### 3.1 正常自动流程

GitHub Actions：

`.github/workflows/sync-upstream.yml`

每 6 小时执行一次：

```
1. fetch PAICNI/CFNext main
2. 读取上游 CFNext 明文版.js
3. 记录上游 commit 到 UPSTREAM_COMMIT
4. 应用 custom/patch.mjs
5. 执行 custom/verify.mjs
6. 执行 wrangler deploy --dry-run
7. 全部成功
8. 才允许 commit 到本仓库 main
```

### 3.2 如果上游只是普通版本升级

例如：

```
2.3.0 → 2.4.0
```

而代码结构仍兼容：

```
自动拉取
→ 自动套补丁
→ 自动验证
→ 自动 dry-run
→ 自动提交
```

不需要人工处理。

### 3.3 如果上游改了关键代码结构

例如：

- 删除 `loadBalance`；
- 修改 `DEFAULT_CONFIG`；
- 重写 `handleScheduled()`；
- 改掉更新检查结构；

那么 `custom/patch.mjs` 找不到预期锚点时会直接失败。

结果：

```
上游新版
   ↓
补丁失败
   ↓
Action 失败
   ↓
不提交
   ↓
main 保持上一版可用代码
```

这是有意设计的 **Fail-Closed**。

不能为了“同步成功”而静默丢掉定制项。

### 3.4 人工处理冲突的标准流程

当 Action 因上游结构变化失败时：

1. 查看上游新版本变更；
2. 对照 `CUSTOM_CHANGELOG.md`；
3. 判断我们的定制是否仍然需要；
4. 修改 `custom/patch.mjs`；
5. 必要时修改 `custom/verify.mjs`；
6. 生成新的 `CFNext 明文版.js`；
7. 执行：

```bash
npm ci
npm run verify:custom
npm run check
```

8. 检查订阅生成；
9. 检查优选池；
10. 检查 OpenClash 导入；
11. 再合并到 `main`。

---

## 4. 哪些文件可以改，哪些不要直接改

### 应该修改

```
custom/patch.mjs
custom/verify.mjs
CUSTOM_CHANGELOG.md
README.md
.github/workflows/sync-upstream.yml
wrangler.jsonc
package.json
```

### 不建议把人工修改直接写进

```
CFNext 明文版.js
```

因为它应该被视为：

> 上游源码 + 本地补丁后的生成结果。

如果需要新增功能，原则上应该：

```
先修改 custom/patch.mjs
→ 再重新生成 CFNext 明文版.js
```

而不是反过来。

---

## 5. 当前仓库结构

```
CFNext/
├── CFNext 明文版.js
├── CFNext 混淆Pages版.zip
├── UPSTREAM_COMMIT
├── README.md
├── CUSTOM_CHANGELOG.md
├── package.json
├── wrangler.jsonc
│
├── custom/
│   ├── patch.mjs
│   └── verify.mjs
│
└── .github/
    └── workflows/
        └── sync-upstream.yml
```

### 文件职责

| 文件 | 职责 |
|---|---|
| `UPSTREAM_COMMIT` | 当前定制版基于哪个上游提交 |
| `custom/patch.mjs` | 所有本地代码修改的单一来源 |
| `custom/verify.mjs` | 防止本地定制在同步过程中丢失 |
| `CUSTOM_CHANGELOG.md` | 记录本地差异 |
| `README.md` | 维护规范和使用说明 |
| `CFNext 明文版.js` | 可部署生成物 |
| `sync-upstream.yml` | 上游同步与验证流程 |

---

## 6. 自动优选架构

推荐整体关系：

```
              外部候选数据源
      ┌────────┼─────────┐
      │        │         │
   WeTest    BestCF   HostMonit
      │        │         │
      └────────┼─────────┘
               ▼
        CFNext Candidate Pool
               │
               ▼
         TCP 延迟 / 可用性
               │
               ▼
       Stateful Best-IP
        3~5 个稳定节点
               │
               ▼
         preferredIPs / KV
               │
               ▼
             CFNext
               │
               ▼
          OpenClash Provider
               │
               ▼
       url-test / fallback
               │
               ▼
            CF-EDGE
```

职责边界：

- **CFNext**：候选汇聚、定时优选、订阅生成；
- **KV**：保存当前稳定优选池；
- **OpenClash**：客户端运行期探测、选择和故障切换；
- **AI-PINNED**：仍应优先使用固定自建出口，不应把 CF-EDGE 作为账号连续性敏感业务的主要出口。

---

## 7. 推荐参数

对于当前使用方式：

```
BESTIP_AUTO=1
BESTIP_POOL_SIZE=5
BESTIP_HYSTERESIS_MS=25
```

CFNext：

```
polling = false
loadBalance = false
optimizer.count = 5
IPv6 = off（除非单独验证）
```

OpenClash：

```
CF-EDGE
├── CF-BEST-01
├── CF-BEST-02
├── CF-BEST-03
├── CF-BEST-04
└── CF-BEST-05
```

由 OpenClash 对这些节点做实际客户端视角的健康检查。

---

## 8. 回滚

### 回滚上游同步

`UPSTREAM_COMMIT` 记录了当前基线。

如果新同步版本出现问题：

- 回退本仓库上一提交；
- Cloudflare 重新部署上一版 `CFNext 明文版.js`。

### 回滚本地定制

如果怀疑本地补丁有问题：

1. 从对应 `UPSTREAM_COMMIT` 取原始 `CFNext 明文版.js`；
2. 不应用 `custom/patch.mjs`；
3. 单独部署验证。

这样可以迅速判断：

> 问题来自上游，还是来自本地补丁。

---

## 9. 关于 Pages 混淆包

当前本地定制的主要可审计目标是：

```
CFNext 明文版.js
```

`CFNext 混淆Pages版.zip` 继续同步上游原包，主要作为上游制品保留。

如果要确保 Pages 部署也应用完全相同的本地定制，应另做专门的 Pages 构建流程，而不要假定混淆包自动继承本地补丁。

当前推荐部署形态：

> **Worker + 明文定制版 + Wrangler/Git 部署**

---

## 10. 上游版权与致谢

本仓库不是独立原创项目。

核心能力、协议实现、面板及大量功能来自：

**PAICNI/CFNext**

本仓库只维护面向自身网络架构的定制补丁和自动同步机制。

上游地址：

`https://github.com/PAICNI/CFNext`

具体本地差异请查看：

`CUSTOM_CHANGELOG.md`
