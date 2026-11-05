#!/usr/bin/env python3
"""Juice Shop challenge -> 対象経路 の機械的導出 (ベンチマーク測定側ツール)。

使用法:
  python docs/benchmark/derive-challenge-routes.py <juice-shop-source-dir> <out-json>

方針:
- challenges.yml から challenge key・name・category を読む。
- サーバ側の solveIf(challenges.<key>) / solve(challenges.<key>) 呼び出し位置
  (routes/, lib/, server.ts, models/, data/) から「どの実装ファイルで解決されるか」を得る。
- 各ファイルの router 登録パス (router.get/post/put/delete('/x')) と
  server.ts の mount (app.use('/base', handler)) からエンドポイントを組み立てる。
- サーバ側 solve がない challenge は client-side (browser 実行や UI 操作で解決) と記録する。

本スクリプトは Juice Shop のソース構造に依存する測定ツールであり、
製品コードには Juice Shop 固有の知識を持ち込まない (AGENTS.md)。
"""
import json
import re
import sys
from pathlib import Path

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])

ROUTE_FILE_RE = re.compile(r"router\.(?:get|post|put|delete|patch)\(\s*['\"]([^'\"]+)['\"]")
SOLVE_RE = re.compile(r"(?:solveIf|solve)\(\s*challenges\.(\w+)")
MOUNT_RE = re.compile(r"app\.(?:use|get|post|put|delete)\(\s*'([^']+)',\s*(?:utils\.asyncHandler\()?(\w+)")
IMPORT_RE = re.compile(r"import\s+(?:\*\s+as\s+(\w+)|\{([^}]+)\}|(\w+))\s+from\s+'\./routes/(\w+)'")

# 機械導出の対象外 (モデル層・websocket) の表面对応。測定側の管理知識。
CURATED_SURFACES: dict[str, list[str]] = {
    "models/product.ts": ["/api/Products", "/rest/products"],
    "models/user.ts": ["/api/Users", "/rest/user"],
    "models/feedback.ts": ["/api/Feedbacks"],
    "lib/startup/registerWebsocketEvents.ts": ["/socket.io/ (websocket)"],
}


def parse_yaml_challenges(path: Path) -> list[dict]:
    """最小の YAML パーサ (challenges.yml の実際の形だけを扱う)。"""
    challenges: list[dict] = []
    current: dict | None = None
    key_re = re.compile(r"^  (\w[\w ]*):\s*(.*)$")
    for raw in path.read_text(encoding="utf-8").splitlines():
        if raw.strip() in ("---", ""):
            continue
        if raw == "-":
            current = {}
            challenges.append(current)
            continue
        if current is None:
            continue
        m = key_re.match(raw)
        if m is not None:
            name, value = m.group(1), m.group(2).strip().strip("'")
            if name in ("name", "category", "description", "key"):
                current[name] = value
            elif name == "disabledEnv":
                current["disabled"] = True if value else False
    return [c for c in challenges if c.get("key")]


def file_routes(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    return [m.group(1) for m in ROUTE_FILE_RE.finditer(text)]


def solve_sites(roots: list[Path]) -> dict[str, list[str]]:
    sites: dict[str, list[str]] = {}
    for root in roots:
        for ts in root.rglob("*.ts"):
            if ts.name.endswith(".spec.ts"):
                continue
            try:
                text = ts.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for m in SOLVE_RE.finditer(text):
                sites.setdefault(m.group(1), []).append(str(ts.relative_to(SRC)).replace("\\", "/"))
    return sites


def main() -> None:
    challenges = parse_yaml_challenges(SRC / "data" / "static" / "challenges.yml")
    server_ts = (SRC / "server.ts").read_text(encoding="utf-8", errors="replace")

    # import 名 (handler) -> routes モジュール名
    import_map: dict[str, str] = {}
    for m in IMPORT_RE.finditer(server_ts):
        module = m.group(4)
        if m.group(1):
            import_map[m.group(1)] = module
        elif m.group(2):
            for name in m.group(2).split(","):
                import_map[name.strip()] = module
        elif m.group(3):
            import_map[m.group(3)] = module

    # mount: (base path, handlers...) を routes モジュールへ紐付ける。
    # ミドルウェア (security.isAuthorized() 等) が先に並ぶため、行内の全識別子を検査する。
    module_endpoints: dict[str, list[str]] = {}
    for m in re.finditer(r"app\.(?:use|get|post|put|delete|patch)\(\s*'([^']+)'([^;\n]*)", server_ts):
        base = m.group(1)
        rest = m.group(2)
        for identifier in re.finditer(r"\b([A-Za-z_]\w*)\b", rest):
            module = import_map.get(identifier.group(1))
            if module is None:
                continue
            route_file = SRC / "routes" / f"{module}.ts"
            endpoints: list[str] = []
            if route_file.exists():
                sub_paths = file_routes(route_file)
                endpoints = [base + ("" if p == "/" else p) for p in sub_paths] or [base]
            module_endpoints.setdefault(module, []).extend(endpoints)

    sites = solve_sites([SRC / "routes", SRC / "lib", SRC / "models", SRC / "data", SRC])

    result = []
    for challenge in challenges:
        key = challenge["key"]
        files = sorted(set(sites.get(key, [])))
        endpoints: list[str] = []
        for f in files:
            if f.startswith("routes/") and f.endswith(".ts"):
                module = f[len("routes/"):-3]
                endpoints.extend(module_endpoints.get(module, []))
            elif f == "server.ts":
                endpoints.append("(server.ts)")
            else:
                endpoints.extend(CURATED_SURFACES.get(f, []))
        result.append({
            "key": key,
            "name": challenge.get("name", ""),
            "category": challenge.get("category", ""),
            "disabled": bool(challenge.get("disabled")),
            "solveFiles": files,
            "endpoints": sorted(set(endpoints)),
            "clientSide": len(files) == 0,
        })

    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    server_side = sum(1 for r in result if not r["clientSide"])
    with_endpoint = sum(1 for r in result if r["endpoints"])
    print(f"challenges: {len(result)} (yaml)")
    print(f"server-side solve sites found: {server_side}")
    print(f"with endpoint mapping: {with_endpoint}")
    print(f"client-side (no server solve): {len(result) - server_side}")


if __name__ == "__main__":
    main()
