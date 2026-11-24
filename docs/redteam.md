# 配套红队插件

红队不是本仓库的功能，是**独立的 bundle**。想用就单独装，不想用完全可以不装。

## 1. 它是什么

上游 [`Jueze-2019/dsh-redteam-mode`](https://github.com/Jueze-2019/dsh-redteam-mode)（MIT），包名 `dsh-redteam-mode`，约 1.8 MB：

| 组成 | 内容 |
|---|---|
| **预设** | 1 个主预设「红队模式」+ 6 个执行角色（recon / assess / vuln-scan / exploit / internal-recon / internal） |
| **工具** | 63 个 `redteam_*`：资产库、漏洞库、POC、凭据、WebShell、隧道、攻击链、评分、报告 |
| **技能** | 41 篇方法论（侦察 / 内网 / 验证 / 隧道 / 规划 / 收口） |
| **资产库** | `~/.dsh/redteam/` 下的 SQLite（用 Node 内置 `node:sqlite`，无原生模块） |

## 2. 装法

**前置**：profile 目录可写，引擎版本 ≥ 0.1.0-rc.6。

```sh
# 1. 取包（上游 monorepo 的 packages/redteam-bundle）
git clone --depth 1 https://github.com/Jueze-2019/dsh-redteam-mode /tmp/rt
cp -r /tmp/rt/packages/redteam-bundle ~/.dsh/profiles/web/node_modules/dsh-redteam-mode

# 2. 注册到 profile
node -e "const f=process.env.HOME+'/.dsh/profiles/web/package.json',p=require(f);
p.dsh.profile.bundles.includes('dsh-redteam-mode')||p.dsh.profile.bundles.push('dsh-redteam-mode');
(p.dependencies=p.dependencies||{})['dsh-redteam-mode']='link:'+process.env.HOME+'/.dsh/profiles/web/node_modules/dsh-redteam-mode';
require('fs').writeFileSync(f,JSON.stringify(p,null,2))"

# 3. 重启引擎，新开对话时在「这次对话的预设」里选「红队模式」
```

**注意**：必须放进 `node_modules` 实体目录，**不能只建符号链接**——ESM 按真实路径解析，
链到 `~/tools/` 之后 `import '@deepseek-ai/dsh-tools'` 会失败。

## 3. 装完怎么验

在红队会话里让它跑自检：`调 redteam_preflight，报 all_checked.total / available / broken / unknown 四个数`。

正常结果：`total: 46`（41 红队 + 5 dsh-go 常规），`unknown: 0`。
如果 `total: 0` 或全是 `unknown`，是上游两个调用漏传 `scope`（见本文最后一节）。

## 4. 装完不等于能打：还要自己准备工具包

**红队插件本身不发工具。** 它是「作战指挥台」——编排、记录、算分、出报告、指挥子智能体；
真正扫端口、跑漏洞、建隧道的是它调用的**外部二进制**，本仓库和上游都不提供。

所以要用就得自己下载，放进 `$DSH_HOME/redteam/toolkit/` 或系统 PATH。
缺了不影响装、不影响开红队会话，只是打不了东西。

**`redteam_preflight` 的报告怎么读**：`available` 表示技能文本自洽（**不代表扫描器能跑**），
`broken` 是真实缺口（缺密钥、缺 VPS、缺二进制），`ok: false` 只要有 broken 就是这个值，正常现象。

实测 46 个技能里 16 个 broken，典型缺口：`FOFA_KEY` / `DEEPSEEK_API_KEY`（要自己账号）、
VPS 地址（技能里还是 `<你的VPS_IP>` 占位符）、`toolkit/` 下的 `naabu` / `suo5-linux-amd64` / `Godzilla.jar` / `nuclei-templates`。

## 5. 已知的两个上游 bug（本仓库的装法里已修）

红队包自己的 `lib/tools.js` 里两处调用没传 `scope`，导致引擎的 `collect(options)` 只扫 global 层、
收集不到注册在预设 fiber 层的技能 provider。

症状对照：修复前 `total: 0`；只修 `list` 后 `total: 46` 但 46 条全是 `unknown`；
两处都修才变成 `available: 30 / broken: 16 / unknown: 0`。

---

返回 [README](../README.md)。
