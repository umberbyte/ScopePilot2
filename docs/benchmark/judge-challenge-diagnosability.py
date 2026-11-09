#!/usr/bin/env python3
"""challenge 関連経路 × 探索候補の診断トラック付与状況を参考値として集計する。

使用法:
  python docs/benchmark/judge-challenge-diagnosability.py <routes-json> <observations-json...> --out <md>

観測ダンプは juice-shop-crawl-measure.ts の JUICE_SHOP_DUMP_PATH 出力
(visitedUrls / apiPathShapes / candidates (diagnosticTracks 付き)) を想定する。

判定:
- challenge の各 endpoint に一致する候補 (パスの :param は任意セグメントとして一致) を探し、
  候補の diagnosticTracks の和集合を「診断トラック候補」とする。
- 一致する候補がない (または候補にトラックがない) 場合は「候補化されていない」とする。
- client-side challenge は判定対象外。

トラック名が付いているだけでは、必要な入力値・認証状態・操作列が揃って実行できることや、
challenge を診断・検出できることを意味しない。入力の challenge→endpoint 対応も粗い推定を含む。
"""
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

args = sys.argv[1:]
routes_path = Path(args[0])
log_paths = [Path(p) for p in args[1:args.index("--out")]]
out_path = Path(args[args.index("--out") + 1])


def endpoint_pattern(endpoint: str) -> re.Pattern | None:
    """endpoint (/rest/basket/:id 等) を正規化パターンへ。"""
    if endpoint.startswith("(") or "websocket" in endpoint:
        return None
    segments = [s for s in endpoint.strip("/").split("/") if s != ""]
    body = r"/".join(r"[^/]+" if s.startswith(":") else re.escape(s) for s in segments)
    return re.compile(r"^/" + body + r"$")


def main() -> None:
    mapping = json.loads(routes_path.read_text(encoding="utf-8"))
    candidates: list[dict] = []
    for path in log_paths:
        dump = json.loads(path.read_text(encoding="utf-8"))
        candidates.extend(dump["candidates"])

    rows = []
    for challenge in mapping:
        if challenge["clientSide"]:
            rows.append({**challenge, "tracks": [], "status": "機械判定対象外 (client-side)", "matched": []})
            continue
        tracks: set[str] = set()
        matched: list[str] = []
        for endpoint in challenge["endpoints"]:
            pattern = endpoint_pattern(endpoint)
            if pattern is None:
                continue
            for candidate in candidates:
                normalized = "/" + urlparse(candidate["url"]).path.strip("/")
                if pattern.match(normalized):
                    tracks.update(candidate.get("diagnosticTracks", []))
                    if len(matched) < 3 and candidate["url"] not in matched:
                        matched.append(candidate["url"])
        status = "診断トラック候補あり" if tracks else "トラック候補なし"
        rows.append({**challenge, "tracks": sorted(tracks), "status": status, "matched": matched})

    counts: dict[str, int] = {}
    track_totals: dict[str, int] = {}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
        for track in row["tracks"]:
            track_totals[track] = track_totals.get(track, 0) + 1

    lines = [
        "# Juice Shop challenge 診断トラック候補の付与状況 (参考値・機械導出)",
        "",
        "- 入力: `juice-shop-challenge-routes.json` (challenge 対象経路) × クロール観測ダンプ (診断トラック付き候補)",
        f"- 判定ツール: `docs/benchmark/judge-challenge-diagnosability.py`",
        f"- 観測: {', '.join(p.name for p in log_paths)}",
        "",
        "> この表は粗い経路対応と候補トラックの交差です。診断の実行可能性や challenge の検出を証明しません。",
        "",
        f"判定結果: {json.dumps(counts, ensure_ascii=False)}",
        f"トラック別候補challenge数: {json.dumps(dict(sorted(track_totals.items(), key=lambda x: -x[1])), ensure_ascii=False)}",
        "",
        "| key | category | status | tracks | matched candidates |",
        "|---|---|---|---|---|",
    ]
    for row in sorted(rows, key=lambda r: (r["status"], r["category"], r["key"])):
        tracks = "<br>".join(row["tracks"]) or "-"
        matched = "<br>".join(row["matched"][:2]) or "-"
        lines.append(f"| {row['key']} | {row['category']} | {row['status']} | {tracks} | {matched} |")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(counts, ensure_ascii=False))
    print(json.dumps(dict(sorted(track_totals.items(), key=lambda x: -x[1])), ensure_ascii=False))


if __name__ == "__main__":
    main()
