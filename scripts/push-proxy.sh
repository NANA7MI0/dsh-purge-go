#!/bin/sh
# 发布推送：优先走 v2rayNG 的本地代理端口，不依赖 VPN 开关。
#
# 为什么这么写：这台机器上 v2rayNG 同时开了
#   10808 SOCKS5 / 10809 HTTP / 以及 tun2socks 全局拦截。
# 实测走 10809 比走 tun 快一倍（deepseek 1.57s vs 3.46s，github 2.4s vs 3.4s），
# 因为 tun 多了一层 tun2socks 转发。
#
# 而且 127.0.0.1 是回环地址，不受 tun 影响 —— 所以即使把 dsh_app 排除在 VPN 之外
# （v2rayNG 的绕行模式），这个端口照样能用。
#
# 用法：sh push-proxy.sh [远端分支]
set -e

BRANCH="${1:-main}"
REPO="$(cd "$(dirname "$0")" && pwd)"

# 代理端口：先 HTTP 再 SOCKS5，都试一次
probe_proxy() {
  for p in "http://127.0.0.1:10809" "socks5h://127.0.0.1:10808"; do
    if curl -s -o /dev/null -m 5 --proxy "$p" https://github.com 2>/dev/null; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

PROXY=$(probe_proxy || true)

if [ -z "$PROXY" ]; then
  echo "  ✖ 本地代理端口都不通（10809 / 10808）"
  echo "    v2rayNG 可能没在跑。要么打开它，要么走「浏览器手动上传」那条路。"
  exit 1
fi

echo "  用代理：$PROXY"

cd "$REPO"

# 只对这一次 git 操作生效，不改全局配置
# 写成一行：续行符在某些 shell 里容易被 heredoc 吃掉反斜杠，踩过一次
URL="https://NANA7MI0:$GITHUB_TOKEN@github.com/NANA7MI0/dsh-purge-go.git"
git -c http.proxy="$PROXY" -c credential.helper= -c http.version=HTTP/1.1 -c http.postBuffer=524288000 push "$URL" "HEAD:$BRANCH"
