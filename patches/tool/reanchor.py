#!/usr/bin/env python3
"""reanchor — 让 dsh-purge 的 needle 跟上新引擎（默认只报告，--write 才改表）。

用法:
  python3 patches/tool/reanchor.py --root /opt/dsh/node_modules/@deepseek-ai
  python3 patches/tool/reanchor.py --root ... --write   # 写 patches.reanchored.json

判据:
  · pattern 在候选文件里逐字存在        → ok（不动）
  · 模糊命中（相似度 >= --min）        → 生成新 pattern；若命中片段已含替换意图（marker/替换尾部），改成 no-op
  · 找不准                             → 标 needs-review，交人判断
候选文件 = 别名匹配到的包 × 常见相对路径（lib/index.js、lib/client.js、presets/*.patch.yml、cordis.patch.yml ...）
"""
import argparse, difflib, json, os, re, sys

RELS = [("lib", "index.js"), ("lib", "client.js"), ("lib", "types", "index.js"),
        ("cordis.patch.yml",), ("presets", "standard.patch.yml"), ("presets", "minimal.patch.yml"),
        ("presets", "ptc.patch.yml"), ("presets", "cordis.patch.yml"), ("package.json",)]

def aliases(p):
    f = p.get("file")
    return f if isinstance(f, list) else [f]

def pkgs_for(p, root):
    names = sorted(os.listdir(root))
    out = []
    for a in aliases(p):
        if not isinstance(a, str):
            continue
        for n in names:
            if n == a or n == "dsh-" + a or n.endswith("-" + a) or a in n:
                out.append(n)
    return sorted(set(out))

def walk_files(pkgdir, limit=80):
    out = []
    for base, dirs, files in os.walk(pkgdir):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git")]
        depth = base[len(pkgdir):].count(os.sep)
        if depth > 3:
            dirs[:] = []
        for f in files:
            if not f.endswith((".js", ".mjs", ".cjs", ".yml", ".yaml", ".json")):
                continue
            fp = os.path.join(base, f)
            try:
                if os.path.getsize(fp) > 4_000_000:
                    continue
            except OSError:
                continue
            out.append(fp)
    return out[:limit]

def candidate_files(p, root):
    rels = []
    if p.get("rel"):
        rels.append(tuple(p["rel"]) if isinstance(p["rel"], list) else tuple(p["rel"].split("/")))
    rels += RELS
    seen, out = set(), []
    for pkg in pkgs_for(p, root):
        pkgdir = os.path.join(root, pkg)
        for rel in rels:
            fp = os.path.join(pkgdir, *rel)
            if fp not in seen and os.path.isfile(fp):
                seen.add(fp); out.append(fp)
        for fp in walk_files(pkgdir):
            if fp not in seen:
                seen.add(fp); out.append(fp)
    return out

_GLOBAL = None
def global_texts(root, limit=4000):
    global _GLOBAL
    if _GLOBAL is not None:
        return _GLOBAL
    out = {}
    for pkg in sorted(os.listdir(root)):
        d = os.path.join(root, pkg)
        if not os.path.isdir(d):
            continue
        for fp in walk_files(d, limit=60):
            try:
                if os.path.getsize(fp) > 900_000:
                    continue
                out[fp] = open(fp, encoding="utf8", errors="replace").read()
            except OSError:
                continue
            if len(out) >= limit:
                break
        if len(out) >= limit:
            break
    _GLOBAL = out
    return out

def best_window(text, pattern):
    head = pattern.split("\n")[0][:60]
    probe = head[:24]
    best = (0.0, "")
    for m in re.finditer(re.escape(probe), text):
        seg = text[m.start():m.start() + len(pattern) + 40]
        r = difflib.SequenceMatcher(None, pattern, seg[:len(pattern)]).ratio()
        if r > best[0]:
            best = (r, text[m.start():m.start() + len(pattern)])
    if best[0] < 0.4:
        lines = text.split("\n")
        for i, l in enumerate(lines):
            if len(l) < 12:
                continue
            r = difflib.SequenceMatcher(None, head, l[:len(head)]).ratio()
            if r > best[0]:
                best = (r, "\n".join(lines[i:i + pattern.count("\n") + 1]))
    return best

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--table", default="patches/patches.json")
    ap.add_argument("--min", type=float, default=0.85)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()

    table = json.load(open(a.table, encoding="utf8"))
    report, changed = [], 0
    for p in table:
        edits = [r for r in p.get("replacements", [])
                 if isinstance(r.get("pattern"), str) and isinstance(r.get("replace"), str)]
        if not edits:
            continue
        files = candidate_files(p, a.root)
        texts = {fp: open(fp, encoding="utf8", errors="replace").read() for fp in files}
        if not texts:
            texts = global_texts(a.root)
        for r in edits:
            pat, rep = r["pattern"], r["replace"]
            live = [fp for fp, t in texts.items() if pat in t]
            if live:
                continue  # 还没打，但 needle 有效
            if any(rep in t for t in texts.values()):
                continue  # 已经是替换后的样子
            best = (0.0, "", "")
            for fp, t in texts.items():
                ratio, seg = best_window(t, pat)
                if ratio > best[0]:
                    best = (ratio, seg, fp)
            ratio, seg, fp = best
            if ratio >= a.min:
                already = any(k in seg for k in ("[dsh-purge]",))
                r["pattern"] = seg
                if already:
                    r["replace"] = seg  # 引擎里已经是改造后的样子 → 变成幂等项
                changed += 1
                report.append((p["id"], p["name"], "reanchored", os.path.relpath(fp, a.root),
                               f"{ratio:.2f}", ratio))
            else:
                report.append((p["id"], p["name"], "needs-review", os.path.relpath(best[2], a.root) if best[2] else "",
                               f"{ratio:.2f}", ratio))
    print(f"{'id':>4} {'name':34s} {'status':12s} {'ratio':>5s}  file")
    for i, n, s, f, r, _ in sorted(report, key=lambda x: (x[2] != "needs-review", x[0])):
        print(f"{i:>4} {n[:34]:34s} {s:12s} {r:>5s}  {f}")
    tally = {}
    for _, _, s, *_ in report:
        tally[s] = tally.get(s, 0) + 1
    print("\n", tally, "| 改写条目:", changed)
    if a.write:
        out = a.table.replace(".json", ".reanchored.json")
        json.dump(table, open(out, "w", encoding="utf8"), ensure_ascii=False, indent=1)
        print("written:", out)

if __name__ == "__main__":
    main()
