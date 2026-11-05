#!/usr/bin/env python3
"""クロール観測 × challenge 対象経路の交差で「到達済み」を判定する (測定側ツール)。

使用法:
  python docs/benchmark/judge-challenge-reach.py <routes-json> <crawl-log...> --out <md>

クロールログは juice-shop-crawl-measure.ts の出力 (GET/POST path shape 行) を想定する。
- API 経路形状: "  GET /api/Challenges/" 等 (末尾要素を / に正規化した形状)
- ページルート: socket.io ポーリング形状 "/score-board/socket.io/" から
  "/score-board" を復元する (ハッシュルーティングの実訪問の痕跡)。

判定:
- endpoints のいずれかが観測形状に前方一致すれば 到達済み (API)。
- client-side challenge は復元したページルートから到達を判断できないため
  「ページ要到達」候補として機械判定対象外とし、理由を記録する。
"""
import json
import re
import sys
from pathlib import Path

args = sys.argv[1:]
routes_path = Path(args[0])
log_paths = [Path(a) for a in args[1:args.index("--out")]]
out_path = Path(args[args.index("--out") + 1])

SHAPE_RE = re.compile(r"^  (GET|POST|PUT|DELETE|PATCH) (\S+)$")


def observed_shapes(paths: list[Path]) -> tuple[set[str], set[str]]:
    api: set[str] = set()
    pages: set[str] = set()
    for path in paths:
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            m = SHAPE_RE.match(raw.rstrip())
            if m is None:
                continue
            api.add(f"{m.group(1)} {m.group(2)}")
            page = m.group(2)
            if page.endswith("/socket.io/"):
                pages.add(page[: -len("socket.io/")])
    return api, pages


def normalize(endpoint: str) -> str:
    return "/" + endpoint.strip("/")


def reached(endpoint: str, api_shapes: set[str]) -> str | None:
    """endpoint が観測形状のいずれかに一致 (パラメータ部の緩い一致) すればその形状を返す。"""
    target = normalize(endpoint)
    for shape in api_shapes:
        method, path = shape.split(" ", 1)
        observed = path.rstrip("/")
        # 観測形状は末尾要素が正規化済み (例: /api/Challenges/)。
        # endpoint (/api/Challenges) との対応は、観測の先頭一致または逆で判定する。
        if observed == target or observed.startswith(target + "/") or target.startswith(observed + "/"):
            return shape
    return None


def main() -> None:
    mapping = json.loads(routes_path.read_text(encoding="utf-8"))
    api_shapes, page_routes = observed_shapes(log_paths)
    rows = []
    for challenge in mapping:
        evidence: list[str] = []
        for endpoint in challenge["endpoints"]:
            if endpoint in ("(server.ts)",):
                continue
            hit = reached(endpoint, api_shapes)
            if hit is not None:
                evidence.append(hit)
        if challenge["clientSide"]:
            status = "機械判定対象外 (client-side)"
        elif not challenge["endpoints"]:
            status = "マッピング不足"
        elif evidence:
            status = "到達済み"
        else:
            status = "未到達"
        rows.append({**challenge, "status": status, "evidence": sorted(set(evidence))[:3]})

    counts: dict[str, int] = {}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1

    lines = [
        "# Juice Shop challenge 対象経路と到達判定 (機械導出)",
        "",
        f"- 導出ツール: `docs/benchmark/derive-challenge-routes.py` (solveIf 呼び出し位置×ルート定義)",
        f"- 判定ツール: `docs/benchmark/judge-challenge-reach.py` (クロール観測との交差)",
        f"- 観測ソース: クロール実測ログ ({', '.join(p.name for p in log_paths)})",
        "",
        f"判定結果: {json.dumps(counts, ensure_ascii=False)}",
        "",
        "| key | category | status | endpoints | evidence |",
        "|---|---|---|---|---|",
    ]
    for row in sorted(rows, key=lambda r: (r["status"], r["category"], r["key"])):
        endpoints = "<br>".join(row["endpoints"][:4]) or "-"
        evidence = "<br>".join(row["evidence"]) or "-"
        lines.append(f"| {row['key']} | {row['category']} | {row['status']} | {endpoints} | {evidence} |")
    lines.append("")
    lines.append("注意: solveIf の関連付けはミドルウェア経由になることがあり、endpoints がチャレンジの")
    lines.append("本体表面と一致しない場合がある (verify.ts 系など)。それらは判定結果を参考値として扱う。")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(counts, ensure_ascii=False))


if __name__ == "__main__":
    main()
