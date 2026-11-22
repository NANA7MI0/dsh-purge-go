# 还原引擎：完整命令

> 原 README 的「15. 还原引擎（备份还在 / 备份没了）」整章。补丁打的是 `/opt/dsh/node_modules/@deepseek-ai/` 下的 39 个包，还原有两条路，取决于**你手上还有没有 apply 时生成的备份**。
> README 的「卸载与还原」一章只留最短路径。

## 有备份：用 restore

`apply` 每次会生成一个 `backup-<时间戳>/files/` 目录：直接用 CLI 跑时在仓库目录，用 `install.sh` 装时在 `~/.dsh/dsh-purge/patch-backup/`，里面是**被这次补丁改过的文件的原始副本**。目录名以 `ls` 为准。注意两种命名：`install.sh` 建的是 `<时间戳>-<pid>`，插件自己建的是带毫秒与随机串的长名；直接用 CLI 跑时是秒级的 `backup-<14 位>`，同一秒内连跑两次会复用同一个目录。

```sh
cd ~/dsh-purge-go
ls -d backup-*            # 看有哪几批

# 按时间倒序撤（后打的先撤）
node patches/purge-patch.mjs restore --backup ./backup-<最后一批>
node patches/purge-patch.mjs restore --backup ./backup-<更早一批>
```

**为什么要倒序**：同一文件可能被多批补丁动过，先撤早的会被后撤的覆盖，最后停在混合状态。

**只跑一次 restore 不够**——`restore` 只还原「这一批备份里有的文件」，跨批次的混合改动要靠倒序全跑完。

> **还原前会核对引擎版本。** 每份备份里都记了打补丁时的引擎版本（在 `manifest.json` 的 `engine.version`）。
> 如果当前引擎已经换过版本（比如 App 更新过），点「还原补丁」会被拒绝，并提示「备份来自引擎 X，当前是 Y，先点一键注入重打一次」。
> 这不是多此一举——把旧版引擎的文件写进新版里，轻则补丁失效，重则引擎起不来。
>
> 0.5.5 之前打的备份没有这个字段，只会提示「无法确认是否匹配」，仍然允许还原。

## 备份没了：从 npm 重装原版包

**这是最常见的情况**——仓库删了、备份跟着没了，但引擎还是被改过的。

思路很直接：**补丁改的是 npm 包的文件，那就把原版包重新装回来覆盖**。

### 方案 A：按引擎自己的 lock 文件重装（推荐）

`/opt/dsh/package-lock.json` 记录了所有依赖的确切版本，直接按它重装：

```sh
cd /opt/dsh
npm install --force
```

这条命令会按 lock 文件把 `@deepseek-ai/*` 全部重装成原版。**不需要知道哪些包被改过**。

### 方案 B：只重装确定被改的包

不想动整个 `node_modules` 的话，只覆盖被改的那 39 个：

```sh
# 先确认引擎版本（从任一包读）
V=$(node -p "require('/opt/dsh/node_modules/@deepseek-ai/dsh-base/package.json').version")
# 例如 0.2.2-rc.1

for P in dsh-acp-app dsh-agent-instructions dsh-agent-loop dsh-api-session-controller \
         dsh-app-boot dsh-base dsh-client-connection dsh-compaction-tool-result-pruner \
         dsh-deliverable-file-references dsh-experimental-auto-review \
         dsh-fs-observation-policy dsh-fs-sandbox dsh-harness-dev-context dsh-headless \
         dsh-llm-deepseek dsh-permission-presets dsh-persona dsh-repeat-tool-reminder \
         dsh-sandbox-local dsh-sandbox-policy dsh-sdk-app dsh-session \
         dsh-session-format-v0-to-v1 dsh-session-log-deepseek dsh-session-reference \
         dsh-settings dsh-skill-badge dsh-subagent dsh-system-prompt dsh-tool-bash \
         dsh-tool-fs dsh-tool-pwsh dsh-tool-subagent dsh-tool-todo dsh-tool-web \
         dsh-user-approval dsh-web-app dsh-client-ui-chat dsh-client-ui-conversation; do
  TARBALL="/tmp/$P.tgz"
  curl -sL "https://registry.npmmirror.com/@deepseek-ai/$P/-/$P-$V.tgz" -o "$TARBALL"
  rm -rf "/opt/dsh/node_modules/@deepseek-ai/$P"
  rm -rf /tmp/px && mkdir -p /tmp/px
  tar xzf "$TARBALL" -C /tmp/px
  cp -a /tmp/px/package "/opt/dsh/node_modules/@deepseek-ai/$P"
  echo "  $P $V"
done
rm -rf /tmp/px /tmp/*.tgz
```

**这 39 个包怎么来的**：跑 `probe`，对 `status === 'applied'` 的行取 `files` 字段里出现的包名去重。

> **注意别用 `pkg` 字段**：一条补丁可能同时改好几个包（比如 #4 命中 base / web-app / headless / sdk-app / acp-app 五个），
> 但 `pkg` 只记其中一个代表。按 `pkg` 去重只能得到 33 个，会漏掉 headless、sdk-app、acp-app、tool-subagent、tool-pwsh、client-ui-chat 这 6 个。

## 验证有没有还原干净

**最硬的办法：逐个和原版 tarball 比字节**。

```sh
# 先生成被改过的包清单（和上面「方案 B」那份一致）
grep -rl 'dsh-purge' /opt/dsh/node_modules/@deepseek-ai/ 2>/dev/null \
  | sed 's|.*@deepseek-ai/||' | cut -d/ -f1 | sort -u > /tmp/pkgs.txt

V=$(node -p "require('/opt/dsh/node_modules/@deepseek-ai/dsh-base/package.json').version")
mkdir -p /tmp/vf && cd /tmp/vf

for P in $(cat /tmp/pkgs.txt); do
  curl -sL "https://registry.npmmirror.com/@deepseek-ai/$P/-/$P-$V.tgz" -o "$P.tgz"
  mkdir -p "ex-$P" && tar xzf "$P.tgz" -C "ex-$P"
  D=$(diff -r "ex-$P/package" "/opt/dsh/node_modules/@deepseek-ai/$P" \
      | grep '^diff\|^Only in' | grep -v package.json | wc -l)
  echo "$P  差异 $D 处"
done
# 全部 0 处即为完全还原
```

**为什么不能只看 `probe`**：`probe` 判断的是「目标状态满没满足」，分不清「本来就是这样」和「被改回来过」。原版引擎上本来就有 `applied` 2 条（反向补丁）、`hit` 30 条、`partial` 22 条。所以还原是否成功，只能**逐字节和原版 tarball 比**（上面那段脚本），或者看 `grep -r 'dsh-purge'` 有没有残留。

> 想快点判断也可以：`applied` 掉到 2 条、`hit` 回到 29 条，就说明补丁全撤了（这正好是原版的读数）。

## 还原后必须重启

```sh
am force-stop io.github.ccch1mneyyy.dsh_app
```

**不重启的话，跑着的引擎进程里加载的还是旧代码**，文件改了也白改。这条和 [怎么重启引擎](install.md#怎么重启引擎) 里是同一条命令，放在这儿是因为刚还原完最容易忘。
