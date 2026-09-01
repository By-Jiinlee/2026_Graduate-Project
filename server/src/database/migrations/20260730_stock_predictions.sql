-- 2026-07-30 : AI 예측 결과 배치 적재 테이블
--
-- v9.7 모델은 "그날 전 종목 중 확신도 상위 X%"를 추천하는 구조이므로 종목 단건 추론이
-- 불가능하다. 따라서 하루 1회 배치로 전 종목 점수를 계산해 이 테이블에 적재하고,
-- 웹 API 는 조회만 수행한다(6.4 AI 추론 파이프라인 보안 — 사전 계산 방식).
--
-- 컬럼은 팀 AI 인터페이스(predict_v97.py) 출력 스펙과 1:1 대응한다.
--   date, ticker, horizon, prob, confidence, direction, recommended, conf_rank
-- horizon 은 웹 API 규약에 맞춰 label_1d → 1d 로 정규화해 저장한다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20260730_stock_predictions.sql

CREATE TABLE IF NOT EXISTS stock_predictions (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '기본키',
  predict_date DATE NOT NULL COMMENT '예측 기준일(거래일)',
  ticker VARCHAR(12) NOT NULL COMMENT '종목코드 6자리(앞자리 0 유지)',
  horizon VARCHAR(4) NOT NULL COMMENT '예측 구간 1d/1w/1m/1y',
  prob DECIMAL(6,5) NOT NULL COMMENT '상승 확률 0~1 (원본 — 응답에는 양자화 값만 노출)',
  confidence DECIMAL(6,5) NOT NULL COMMENT '확신도 |prob-0.5|',
  direction ENUM('UP','DOWN') NOT NULL COMMENT '상승/하락 판정',
  recommended TINYINT(1) NOT NULL COMMENT '1=추천(확신도 상위 coverage 내)',
  conf_rank INT NOT NULL COMMENT '그날 확신도 순위 — 내부 전용, 응답 비노출',
  model_version VARCHAR(20) NOT NULL COMMENT '산출 모델 버전(예: v9.7)',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '적재 일시',
  PRIMARY KEY (id),
  UNIQUE KEY uq_prediction (predict_date, ticker, horizon),
  KEY idx_pred_lookup (horizon, predict_date, recommended),
  KEY idx_pred_ticker (ticker, horizon, predict_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='AI 상승·하락 예측 배치 결과';
