# 出问题时自查

> 原 README 的「12. 已知限制」（含「换用别的模型会怎样」）、「14.4 App 起不来的时候怎么救」、「16. 升级引擎 / 更新 App 之后」和「18.1 遇到问题」。
> README 的「出问题怎么办」一章只留最常中的那几条，逐条排查看这里。

## 已知限制

1. **只对新会话完全生效**。引擎把系统提示写进对话历史（`systemPromptUpdate: "in-history"`），
  旧会话里那条旧 system 还在，注入顶不动它。
2. **压缩会重发基线**。上下文压缩之后，引擎会用 `COMPACT_AGENT_INSTRUCTIONS_INTRO` 那句弱提示顶掉强开场。
  想补的话**只改这一个常量**（它在 `dsh-agent-instructions` 里，目前没有补丁覆盖）。
  **别去动 `REPLACEMENT_*`**——#2 补丁正把它们往「温和说法」的方向改，你再手动改强会和补丁互相覆盖。
3. **补丁改的是 `node_modules`**。**升级引擎、或者装新版 App，都会把它整个重装一遍、补丁全丢**——App 的更新流程会重新铺 `@deepseek-ai/*`，跟你有没有动过它无关。之后要重跑 `probe` + `apply`（见 [升级引擎 / 更新 App 之后](#升级引擎--更新-app-之后)）。
4. **`node --check` 只验语法不验语义**——保证不把文件改坏，保证不了行为对。

## 换用别的模型（API）会怎样

> **只适配 DeepSeek，最好不要换。** 换别的模型不会报错，但**破甲效果会打折扣**——
> 注入正文是按 DeepSeek 的格式写的。原版哪天支持了多模型，这里会跟着加。

先说清楚：**这个插件不改模型本身**，它改的是引擎——系统提示怎么组装、执行时有没有闸拦着。
所以换 API 之后插件不是「失效」，而是**分层受影响**：

| 层 | 换 API 后 |
|---|---|
| 注入层（丢身份段、拼注入正文） | ✅ 照常工作。走的是引擎的 `system-prompt/assemble`，跟用哪个模型无关 |
| 补丁层生效的 58 条里，管审批、沙箱、身份、压缩的那批（判定阈值另算，见本页[升级引擎 / 更新 App 之后](#升级引擎--更新-app-之后)） | ✅ 照常工作。改的是 `node_modules` 里的源码 |
| 补丁层 5 条模型相关 | ⚠️ 可能失效，不影响大局 |
| **注入正文的写法** | ⚠️ **要重写**，见下 |

那 5 条模型相关的补丁是：`#47` / `#49`（`pi-ai-anthropic-messages`）、
`#52`（`session-log-deepseek`）、`#69` / `#72`（`llm-deepseek`）。

**真正的问题在注入正文**。包内那份正文（加密存成 `lib/asset-table.json`，解出来就是原来那份）第一行是：

```text
<|im_start|>system:<project_instructions>
```

`<|im_start|>` 是 **ChatML** 格式标记，DeepSeek / Qwen 系用这个。换到 Claude 或 GPT 上，
它只是被当普通文本塞进 system，**不报错但也不加分**——同一段话，DeepSeek 可能听，Claude 未必。

这不是本仓库的疏忽。**原版也是这么干的**：社区维护版 v1.6.93 的 `lib/identity.js`、`lib/index.js`、
`test/chatml-envelope.test.mjs` 等 10 个文件里都有 `im_start`，它自己的 `docs/inject-review.md` 
评估的那份正文，第一段就是我们这份的第一行——**同一份正文**。原版 README 里也只有一句
「它不改模型本身」，没有多模型适配的说明。

**结论**：换模型的话，插件该装还装，但别指望原封不动的效果——**注入正文得按目标模型重写**。

## App 起不来的时候怎么救

**症状**：App 启动就闪退或停在加载页，反复出现这几行：

```
[dsh-app] start failed: .../dsh-go/plugins/dsh-go-purge/LICENSE
[dsh-app] runtime failed; system service recreation disabled
```

**这个时候App 内的终端点不开**——侧边栏「全部功能」整个是灰的，因为它也依赖引擎。安全模式（safe mode）只换 profile，救不了这个。

**原因**：原生界面目录里的文件读不到。0.6.8 之前那套是「指向仓库的软链」，仓库被删/被移走/被 git 操作搞乱，11 条软链就全悬空。

**三种救法，按能不能用挑：**

| 你有什么 | 怎么做 |
|---|---|
| **电脑 + USB 线** | `adb shell` 进去，`rm -rf /data/user/0/io.github.ccch1mneyyy.dsh_app/files/runtime/rootfs/root/.dsh/dsh-go/plugins/dsh-go-purge`，然后正常打开 App |
| **手机有 root（KernelSU / Magisk）** | 用任意带 root 的终端 `su` 进去，删同一个路径 |
| **什么都没有** | 只能重装 App。**重装会清掉 App 私有目录，历史对话一起没**——所以重装前先确认没有别的办法 |

**0.6.8 起不会再进这个状态**：原生界面目录是一份独立副本，仓库没了它照样完整；而且装的时候先建到临时目录、逐个校验、全部通过才替换，中途失败旧目录一点不动。

**已经中招、但 App 还能打开终端的话**，一条命令修回来：

```sh
cd "$(readlink -f ~/.dsh/profiles/web/node_modules/dsh-go-purge)" && sh install.sh --repair-native
```

## 升级引擎 / 更新 App 之后

**两种情况都会让补丁失效**：

- **升级引擎**：自己跑 `npm install`、或按 [还原引擎](restore.md) 还原
- **更新 App**：从 GitHub 装新版 APK。App 启动时会重新铺一遍 `/opt/dsh/node_modules/@deepseek-ai/`，实测 331 个包的时间戳全部刷新、补丁一条不剩。**这一点最容易被忽略**——你什么都没干，只是装了个新版 App，破甲就剩一半了。

**怎么知道自己中招了**：补丁被冲掉时**输入框上方会自己出现一条红色状态条**（正常时不显示，也不是点胶囊才出来的）。

状态条本身只有一句短的（24 字上限）：

```
⚠️ 破甲异常 · 点开处理
```

点它进面板，顶部那条总结会说清是什么情况 —— 被 App 更新冲掉时是这句：

```
补丁被覆盖了（App 更新会重置引擎）。点下面的「一键注入」，打完重启一次引擎。
```

注入层不受影响（走官方扩展点），失效的只有补丁层。

**修复**：说一句「重打补丁」让插件调 `purge_patch_apply`，或者手动跑:

```sh
cd "$(readlink -f ~/.dsh/profiles/web/node_modules/dsh-go-purge)" && node patches/purge-patch.mjs apply
# 然后从最近任务里把 App 划掉再打开（am 命令在 proot 里跑不了）
```

打之前建议先 `probe` 看一眼。**别急着 `apply`**：

```sh
node patches/purge-patch.mjs probe
node patches/purge-patch.mjs apply --dry
```

命中率低说明查找串对不上，这种情况下 `apply` 会全部落空、文件不改（先跑 `probe` 看一遍即可）。注入层不受影响（走官方扩展点），但建议开新会话确认身份段还被丢掉。

## 遇到问题

装不上、面板报错、补丁打不上、行为跟文档对不上——先按对应的章节自查一遍（安装问题看 [安装](../README.md#2-安装)，补丁看 [补丁层](patches.md)，状态看不懂查 [状态含义](states.md)）。

**自查之后还没解决，发邮件到：NANA7MI0@outlook.com**

写清楚这几样，能省不少来回：

- 你那个版本的版本号（`node -p "require(process.env.HOME+'/dsh-purge-go/package.json').version"`）
- 引擎版本（`node -p "require('/opt/dsh/node_modules/@deepseek-ai/dsh-base/package.json').version"`）
- `probe` 的输出（`node patches/purge-patch.mjs probe`）
- 具体现象：点了什么、看到什么、期望是什么
- 有截图更好
