# -*- coding: utf-8 -*-
"""
확률 보정 브리지 — raw 점수 CSV → 보정·앙상블·추천 → 배치 예측 CSV
====================================================================
팀 AI 의 predict_v97.py 가 최종 산출물(전 종목 예측 CSV)을 직접 주기 전까지,
"보정 단계"만 우리 쪽에서 재현·검증하기 위한 브리지다. 받은 iso_lgbm_*.pkl 을
실제로 사용하며, CatBoost 보정기(iso_cat_*.pkl)가 들어오면 앙상블까지 그대로 확장된다.

입력 CSV (base 모델의 raw 확률 — 팀 AI 가 LightGBM/CatBoost 로 산출)
  date, ticker, horizon, lgbm_raw[, cat_raw]

처리
  1) iso_lgbm 으로 lgbm_raw 보정  (+ iso_cat 있으면 cat_raw 보정)
  2) 앙상블 가중 평균  (가중치 미지정 시 0.5/0.5)
  3) confidence=|p-0.5| 상위 coverage 를 추천(recommended=1)
  4) importPredictions.ts 가 읽는 스키마로 저장

출력 CSV (predict_v97.py 스펙과 동일)
  date, ticker, horizon, prob, confidence, direction, recommended, conf_rank

실행
  python calibrationBridge.py --raw raw_scores.csv --iso-dir "C:/Users/leesi/Downloads" \
         --coverage 0.067 --out pred.csv
"""
import argparse
import os
import sys
import joblib
import numpy as np
import csv

sys.stdout.reconfigure(encoding="utf-8")


def normalize_horizon(h):
    return h.strip().replace("label_", "")


def load_iso(iso_dir, target, kind):
    p = os.path.join(iso_dir, f"iso_{kind}_label_{target}.pkl")
    return joblib.load(p) if os.path.exists(p) else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, help="raw 점수 CSV (date,ticker,horizon,lgbm_raw[,cat_raw])")
    ap.add_argument("--iso-dir", default="C:/Users/leesi/Downloads")
    ap.add_argument("--coverage", type=float, default=0.067, help="추천 비율(그날 확신도 상위 X)")
    ap.add_argument("--w-lgbm", type=float, default=0.5)
    ap.add_argument("--w-cat", type=float, default=0.5)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    rows = []
    with open(args.raw, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            rows.append(r)
    if not rows:
        print("raw CSV 에 데이터가 없습니다.")
        sys.exit(2)

    iso_cache = {}

    def iso(target, kind):
        key = (target, kind)
        if key not in iso_cache:
            iso_cache[key] = load_iso(args.iso_dir, target, kind)
        return iso_cache[key]

    # (date, horizon) 그룹별로 추천 상위 X% 판정
    from collections import defaultdict
    groups = defaultdict(list)
    for r in rows:
        h = normalize_horizon(r["horizon"])
        groups[(r["date"], h)].append(r)

    out_rows = []
    for (date, h), grp in groups.items():
        il = iso(h, "lgbm")
        ic = iso(h, "cat")
        if il is None:
            print(f"⚠️  iso_lgbm_label_{h}.pkl 없음 — 스킵")
            continue

        lgbm_raw = np.array([float(r["lgbm_raw"]) for r in grp])
        p_lgbm = np.asarray(il.transform(lgbm_raw))

        has_cat = ic is not None and all("cat_raw" in r and r["cat_raw"] != "" for r in grp)
        if has_cat:
            cat_raw = np.array([float(r["cat_raw"]) for r in grp])
            p_cat = np.asarray(ic.transform(cat_raw))
            p = args.w_lgbm * p_lgbm + args.w_cat * p_cat
        else:
            p = p_lgbm  # CatBoost 보정기 미수령 시 LightGBM 단독

        p = np.clip(p, 0.0, 1.0)
        conf = np.abs(p - 0.5)
        order = np.argsort(-conf)
        k = max(1, int(round(len(p) * args.coverage)))
        rec = np.zeros(len(p), dtype=int)
        rec[order[:k]] = 1
        rank = np.empty(len(p), dtype=int)
        rank[order] = np.arange(1, len(p) + 1)

        for i, r in enumerate(grp):
            out_rows.append({
                "date": date,
                "ticker": str(r["ticker"]).zfill(6),
                "horizon": h,
                "prob": f"{p[i]:.4f}",
                "confidence": f"{conf[i]:.4f}",
                "direction": "상승" if p[i] >= 0.5 else "하락",
                "recommended": int(rec[i]),
                "conf_rank": int(rank[i]),
            })

    out_rows.sort(key=lambda x: (x["date"], x["horizon"], x["conf_rank"]))
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["date", "ticker", "horizon", "prob",
                                          "confidence", "direction", "recommended", "conf_rank"])
        w.writeheader()
        w.writerows(out_rows)

    n_rec = sum(r["recommended"] for r in out_rows)
    print(f"보정 완료: {len(out_rows):,}행, 추천 {n_rec}건")
    print(f"저장: {args.out}")


if __name__ == "__main__":
    main()
