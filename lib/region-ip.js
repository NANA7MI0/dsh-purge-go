/**
 * 字面 IP → 受控地区 判定（1.1.63 的 net-scope 网段能力，v1.1.64 被当成「没有调用的代码」删掉）。
 *
 * 现版 region gate 只按域名后缀判，`taskTargetHit` 遇到字面 IP 直接 `continue`：
 * 于是「打 1.2.3.4」这类任务从来不进地区门。这里把网段表捡回来，只做离线判定：
 * 不解析 DNS、不发网络请求，命中就返回地区代码，未命中返回空串。
 *
 * 同时补回 canEmbed 判定用的 `isIpLiteral`：抽出来的 host 到底是不是 IP，一处说清。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RANGES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "net-scope-ranges.json");

let cache = null;

/** 网段表按需读一次；文件缺失/损坏时返回空表，地区门退化为只看后缀。 */
export function loadRanges(fp = RANGES_FILE) {
  if (fp === RANGES_FILE && cache) return cache;
  const empty = { v4: [], v6: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    const loaded = {
      v4: Array.isArray(parsed.v4) ? parsed.v4 : [],
      v6: Array.isArray(parsed.v6) ? parsed.v6 : [],
    };
    if (fp === RANGES_FILE) cache = loaded;
    return loaded;
  } catch {
    if (fp === RANGES_FILE) cache = empty;
    return empty;
  }
}

export function resetRangeCache() {
  cache = null;
}

export function ipv4ToInt(ip) {
  const parts = String(ip || "").split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (number > 255) return null;
    value = value * 256 + number;
  }
  return value >>> 0;
}

/** 私网/保留/组播网段：既是「自己的网段」，也不进地区表。 */
export function isSkippedV4(value) {
  const a = value >>> 24;
  const b = (value >>> 16) & 255;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

export function parseIpv6(input) {
  let text = String(input || "").trim().toLowerCase().split("%")[0];
  if (!text) return null;
  if (text.includes(".")) {
    const colon = text.lastIndexOf(":");
    const tail = ipv4ToInt(text.slice(colon + 1));
    if (tail == null) return null;
    const hi = (tail >>> 16).toString(16);
    const lo = (tail & 0xffff).toString(16);
    text = `${text.slice(0, colon + 1)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && missing < 0) return null;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (parts.length !== 8) return null;
  let out = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    out = (out << 16n) + BigInt(parseInt(part, 16));
  }
  return out;
}

export function isIpLiteral(host) {
  const text = String(host || "").trim();
  if (!text) return false;
  if (ipv4ToInt(text) != null) return true;
  return text.includes(":") && parseIpv6(text) != null;
}

/** 命中受控地区返回地区代码（CN/HK/MO/RU…），未命中或私网/保留网段返回空串。 */
export function regionOfIp(ip, ranges = loadRanges()) {
  const text = String(ip || "").trim().toLowerCase();
  if (!text) return "";
  if (text.includes(":")) {
    const value = parseIpv6(text);
    if (value == null) return "";
    for (const row of ranges.v6 || []) {
      const shift = BigInt(128 - row.len);
      if ((value >> shift) === (BigInt(row.value) >> shift)) return row.region;
    }
    return "";
  }
  const value = ipv4ToInt(text);
  if (value == null || isSkippedV4(value)) return "";
  const v4 = ranges.v4 || [];
  let lo = 0;
  let hi = v4.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v4[mid][0] <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return "";
  return value <= v4[found][1] ? v4[found][2] : "";
}

/** 表格自检：返回 `{ v4, v6, sorted, sample }`，`--region-check` 与单测都用它。 */
export function rangeTableSummary(ranges = loadRanges()) {
  const v4 = ranges.v4 || [];
  let sorted = true;
  for (let i = 1; i < v4.length; i += 1) {
    if (v4[i - 1][0] > v4[i][0]) { sorted = false; break; }
  }
  const sample = v4.length > 0
    ? (() => {
        const row = v4[0];
        const ip = [row[0] >>> 24, (row[0] >>> 16) & 255, (row[0] >>> 8) & 255, row[0] & 255].join(".");
        return { ip, region: regionOfIp(ip, ranges) };
      })()
    : null;
  return { v4: v4.length, v6: (ranges.v6 || []).length, sorted, sample };
}
