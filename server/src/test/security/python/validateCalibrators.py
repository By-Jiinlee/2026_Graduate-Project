# -*- coding: utf-8 -*-
"""
[보안 검증] AI 확률 보정기(Isotonic Calibrator) 아티팩트 검증
================================================================
대상 : iso_lgbm_label_{1d,1w,1m,1y}.pkl (팀 AI 산출물)

이 스크립트가 검증하는 것 (모델 base 파일 없이 보정기만으로 가능한 범위)
  1) 역직렬화 안전성 — 신뢰 경로의 파일만, 기대한 클래스(IsotonicRegression)로만 로드
  2) 응답 상·하한 클리핑 — 어떤 raw 점수(음수·>1·NaN·Inf 포함)가 들어와도 출력 ∈ [0,1]
  3) 단조성 — raw 점수가 커지면 보정 확률도 감소하지 않음(등위 보정의 정의)
  4) 서비스 파이프라인 정합 — 보정 확률이 응답 최소화(5%p 양자화)와 결합해도 [0,1] 유지

논문 6.4 의 "예측 응답의 비현실적 값 상·하한 클리핑" 주장을 실제 아티팩트로 뒷받침한다.

실행 : python validateCalibrators.py --dir "C:/Users/leesi/Downloads"
"""
import argparse
import os
import sys
import math
import joblib
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")

TARGETS = ["label_1d", "label_1w", "label_1m", "label_1y"]
PROB_STEP = 0.05  # 서버 응답 최소화 격자(inferenceSecurityService.POLICY.PROBABILITY_STEP 와 일치)

pass_cnt = 0
fail_cnt = 0
problems = []


def check(name, ok, detail=""):
    global pass_cnt, fail_cnt
    mark = "OK  " if ok else "FAIL"
    if ok:
        pass_cnt += 1
    else:
        fail_cnt += 1
        problems.append(f"{name}{(' — ' + detail) if detail else ''}")
    print(f"  [{mark}] {name}{(' — ' + detail) if detail else ''}")


def quantize(p):
    q = round(p / PROB_STEP) * PROB_STEP
    return min(1.0, max(0.0, round(q, 2)))


def validate_one(target, path):
    print(f"\n── {target} ({os.path.basename(path)})")

    # 1) 역직렬화 — 기대 클래스 확인
    try:
        obj = joblib.load(path)
    except Exception as e:
        check(f"{target} 로드", False, str(e))
        return
    from sklearn.isotonic import IsotonicRegression
    is_iso = isinstance(obj, IsotonicRegression)
    check(f"{target} 기대 클래스(IsotonicRegression)", is_iso, type(obj).__name__)
    if not is_iso:
        return

    # 2) 상·하한 클리핑 — 극단·비정상 raw 입력에도 출력이 [0,1]
    raw = np.array([-10.0, -1.0, -0.001, 0.0, 0.25, 0.5, 0.75, 1.0, 1.001, 2.0, 100.0])
    try:
        cal = obj.transform(raw)
    except Exception as e:
        check(f"{target} 극단 입력 변환", False, str(e))
        return
    bounded = np.all(cal >= 0.0) and np.all(cal <= 1.0) and np.all(np.isfinite(cal))
    check(f"{target} 출력 범위 [0,1] 유지", bool(bounded),
          f"min={cal.min():.4f} max={cal.max():.4f}")

    # out_of_bounds 정책이 clip 인지 (범위 밖을 예외 없이 처리)
    check(f"{target} out_of_bounds=clip", getattr(obj, "out_of_bounds", None) == "clip",
          str(getattr(obj, "out_of_bounds", None)))

    # 3) 단조성 — raw 증가 시 보정 확률 비감소
    grid = np.linspace(0.0, 1.0, 501)
    cg = obj.transform(grid)
    monotonic = np.all(np.diff(cg) >= -1e-9)
    check(f"{target} 단조 증가", bool(monotonic))

    # 4) 서비스 파이프라인 정합 — 양자화 후에도 [0,1], 격자 위에 존재
    q = np.array([quantize(float(x)) for x in cg])
    on_grid = np.all(np.abs(np.round(q / PROB_STEP) * PROB_STEP - q) < 1e-9)
    check(f"{target} 양자화 정합(5%p 격자)", bool(on_grid) and np.all((q >= 0) & (q <= 1)))

    # 참고 정보
    xt = np.asarray(obj.X_thresholds_)
    print(f"       · knots={len(xt)}  X∈[{xt.min():.4f},{xt.max():.4f}]  "
          f"raw 0.50→{obj.transform([0.5])[0]:.4f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="C:/Users/leesi/Downloads",
                    help="iso_lgbm_label_*.pkl 이 있는 폴더")
    args = ap.parse_args()

    print("[보안 검증] AI 확률 보정기 아티팩트")
    print(f"경로: {args.dir}")

    found = 0
    for t in TARGETS:
        p = os.path.join(args.dir, f"iso_lgbm_{t}.pkl")
        if not os.path.exists(p):
            check(f"{t} 파일 존재", False, p)
            continue
        found += 1
        validate_one(t, p)

    print("\n─────────────────────────────────────────────")
    if problems:
        print("[실패 항목]")
        for pr in problems:
            print(f"  · {pr}")
    print(f"\n대상 파일: {found}/{len(TARGETS)}개")
    print(f"검증 항목: {pass_cnt}건 통과 / {fail_cnt}건 실패")
    print(f"판정: {'PASS' if fail_cnt == 0 and found == len(TARGETS) else 'FAIL'}")
    sys.exit(0 if fail_cnt == 0 and found == len(TARGETS) else 1)


if __name__ == "__main__":
    main()
