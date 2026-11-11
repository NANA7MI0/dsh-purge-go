#!/usr/bin/env bash
# dsh-purge-go __VERSION__ 自解压安装器（由 scripts/build-selfinstall.sh 生成）（Android / PRoot Ubuntu / 任意 Linux）
# 用法:  bash dsh-purge-go-__VERSION__-selfinstall.sh            安装
#        bash dsh-purge-go-__VERSION__-selfinstall.sh --uninstall 卸载
#        bash dsh-purge-go-__VERSION__-selfinstall.sh --check     只体检不动手
set -u

PKG=dsh-purge-go
VER=__VERSION__
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
PROFILE=${DSH_PROFILE:-web}
MODE=install
case ${1:-} in
  --uninstall) MODE=uninstall ;;
  --check)     MODE=check ;;
  "" ) ;;
  * ) echo "未知参数: $1（可用 --check / --uninstall）" >&2; exit 2 ;;
esac

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# 用 pathToFileURL 判导入，Windows 与 Linux 都能跑
import_check() {
  node -e 'const {pathToFileURL}=require("node:url");const path=require("path");const dir=process.argv[1];const url=pathToFileURL(path.join(dir,"lib","index.js")).href;import(url).then(m=>{const k=Object.keys(m).sort();if(!k.includes("apply")){console.error("✗ 导出里没有 apply");process.exit(1)}console.log("· 导入 OK:",k.join(","))}).catch(e=>{console.error("✗ 导入失败:",e.code||"",e.message);process.exit(1)})' "$1"
}

say "== $PKG $VER / mode=$MODE"
say "   DSH_HOME = $DSH_HOME"
say "   PROFILE  = $PROFILE"

# ── 0. 环境
command -v node >/dev/null 2>&1 || die "找不到 node（引擎自带，或用 dsh 的那个 node）"
command -v tar  >/dev/null 2>&1 || die "找不到 tar"
say "· node $(node -v 2>/dev/null)"

PROF_DIR="$DSH_HOME/profiles/$PROFILE"
DEST_ROOT="$DSH_HOME/dsh-go/plugins"
DEST="$DEST_ROOT/$PKG"

# ── 卸载
if [ "$MODE" = uninstall ]; then
  node - "$DSH_HOME" "$PROFILE" "$PKG" <<'NODE'
const fs=require("fs"),path=require("path")
const [home,profile,pkg]=process.argv.slice(2)
const p=path.join(home,"profiles",profile,"package.json")
if(fs.existsSync(p)){
  const j=JSON.parse(fs.readFileSync(p,"utf8"))
  if(j.dependencies) delete j.dependencies[pkg]
  const b=j.dsh&&j.dsh.profile&&j.dsh.profile.bundles
  if(Array.isArray(b)) j.dsh.profile.bundles=b.filter(x=>x!==pkg)
  fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")
  console.log("· 已从 profile 移除登记")
}
NODE
  rm -f "$PROF_DIR/node_modules/$PKG"
  rm -rf "$DEST"
  rm -f "$DSH_HOME/redteam/skills"/*.md 2>/dev/null
  rm -rf "$DSH_HOME/.agent-presets/redteam"
  say "✓ 已卸载（redteam 技能与预设一并清掉）"
  exit 0
fi

[ -d "$PROF_DIR" ] || {
  say "可用的 profile:"
  ls "$DSH_HOME/profiles" 2>/dev/null || say "  (没有 profiles 目录)"
  die "找不到 $PROF_DIR —— 用 DSH_PROFILE=xxx 指定"
}

# ── 体检
if [ "$MODE" = check ]; then
  say "· profile/package.json: $([ -f "$PROF_DIR/package.json" ] && echo 有 || echo 缺)"
  node - "$DSH_HOME" "$PROFILE" "$PKG" <<'NODE'
const fs=require("fs"),path=require("path")
const [home,profile,pkg]=process.argv.slice(2)
const p=path.join(home,"profiles",profile,"package.json")
if(!fs.existsSync(p)){ console.log("· 无 package.json，跳过"); process.exit(0) }
const j=JSON.parse(fs.readFileSync(p,"utf8"))
console.log("· dependencies:", (j.dependencies||{})[pkg] ?? "(未登记)")
console.log("· bundles     :", JSON.stringify((j.dsh&&j.dsh.profile&&j.dsh.profile.bundles)||null))
NODE
  say "· 已安装目录: $([ -d "$DEST" ] && echo 有 || echo 缺)"
  [ -d "$DEST" ] && import_check "$DEST"
  say "· redteam/skills: $([ -d "$DSH_HOME/redteam/skills" ] && ls "$DSH_HOME/redteam/skills" 2>/dev/null | wc -l || echo 0) 个"
  say "· 预设目录: $([ -d "$DSH_HOME/.agent-presets/redteam" ] && echo 有 || echo 缺)"
  exit 0
fi

# ── 1. 备份
STAMP=$(date +%Y%m%d-%H%M%S)
BAK="$DSH_HOME/backup-before-$PKG-$STAMP"
mkdir -p "$BAK/profiles/$PROFILE"
cp -a "$PROF_DIR/package.json"     "$BAK/profiles/$PROFILE/" 2>/dev/null || true
cp -a "$PROF_DIR/cordis.patch.yml" "$BAK/profiles/$PROFILE/" 2>/dev/null || true
say "· 备份: $BAK"

# ── 2. 解包（自带 payload）
TMP=$(mktemp -d 2>/dev/null || echo "/tmp/dshpg-$$")
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM
sed -n '/^__PAYLOAD_BEGIN__$/,/^__PAYLOAD_END__$/p' "$0" | sed '1d;$d' > "$TMP/pkg.b64" \
  || die "payload 截取失败（文件被改过换行或截断？）"
node -e 'const fs=require("fs");const p=process.argv[1];fs.writeFileSync(p.replace(/\.b64$/,".tgz"),Buffer.from(fs.readFileSync(p,"utf8"),"base64"))' "$TMP/pkg.b64" \
  || die "payload 解 base64 失败"
[ -s "$TMP/pkg.tgz" ] || die "payload 为空"
mkdir -p "$DEST_ROOT"
if [ -d "$DEST" ]; then
  mv "$DEST" "$DEST.bak-$STAMP" || die "旧目录挪不动: $DEST"
  say "· 旧版本挪到 $DEST.bak-$STAMP"
fi
tar -xzf "$TMP/pkg.tgz" -C "$DEST_ROOT" || die "tar 解包失败"
# npm pack 产出的 tgz 顶层目录叫 package/，解到 plugins 下要改回包名目录
if [ ! -f "$DEST/package.json" ] && [ -f "$DEST_ROOT/package/package.json" ]; then
  mv "$DEST_ROOT/package" "$DEST" || die "把 package/ 改名为 $PKG/ 失败"
  say "· 顶层目录 package/ → $PKG/"
fi
[ -f "$DEST/package.json" ] || die "解包后没有 $DEST/package.json"
say "· 已释放: $DEST"

# ── 3. 登记到 profile（dependencies + dsh.profile.bundles 两条都要）
node - "$DSH_HOME" "$PROFILE" "$PKG" <<'NODE'
const fs=require("fs"),path=require("path")
const [home,profile,pkg]=process.argv.slice(2)
const p=path.join(home,"profiles",profile,"package.json")
const j=JSON.parse(fs.readFileSync(p,"utf8"))
j.dependencies=j.dependencies||{}
j.dependencies[pkg]="link:../../dsh-go/plugins/"+pkg
j.dsh=j.dsh||{}
j.dsh.profile=j.dsh.profile||{}
const b=j.dsh.profile.bundles=j.dsh.profile.bundles||[]
if(!b.includes(pkg)) b.push(pkg)
fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")
console.log("· dependencies["+pkg+"] =",j.dependencies[pkg])
console.log("· bundles =",b.length,"项，含",pkg,"=",b.includes(pkg))
NODE
[ $? -eq 0 ] || die "写 profile/package.json 失败"

# ── 4. node_modules 落点（link 安装缺了它引擎会 resolve 不到）
NM="$PROF_DIR/node_modules"
mkdir -p "$NM"
node - "$NM" "../../../dsh-go/plugins/$PKG" "$PKG" <<'NODE'
const fs=require("fs"),path=require("path")
const [nm,target,pkg]=process.argv.slice(2)
fs.mkdirSync(nm,{recursive:true})
const p=path.join(nm,pkg)
try{fs.rmSync(p,{recursive:true,force:true})}catch{}
try{fs.symlinkSync(target,p,process.platform==="win32"?"junction":"dir")}
catch(e){console.error("symlink:",e.code||"",e.message);process.exit(1)}
if(!fs.existsSync(path.join(p,"package.json"))){console.error("软链后看不到 package.json");process.exit(1)}
console.log("· 软链:",p,"->",target)
NODE
[ -f "$NM/$PKG/package.json" ] || die "软链没指对: $NM/$PKG"

# ── 5. 自检（能否 import 起来）
import_check "$DEST" || die "插件代码导入失败（把上面这行报错发我）"

say ""
say "✓ 安装完成。现在必须【完全重启 DSH Go 引擎】（退出 App 再进，或点重启引擎），"
say "  技能与预设是在插件加载时同步的，重启后才会出现："
say "    ls ~/.dsh/redteam/skills | wc -l      # 期望 23"
say "    ls ~/.dsh/.agent-presets/redteam      # 期望 3 个文件"
say "    dsh --profile $PROFILE --dump-config 2>&1 | grep -n purge   # 期望出现 dsh-purge-go"
say ""
say "回滚: bash $0 --uninstall"
say "体检: bash $0 --check"
exit 0
