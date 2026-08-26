-- 2026-08-26 : 기만 기술(카나리 계좌) 탐지 기록
--   anomaly_logs : CANARY_ACCESS 유형 추가
--     미끼로 심어둔 계좌(canaryService.CANARY_USER_IDS)의 거래·조회 진입점 접근.
--     허니팟(HONEYPOT, 미끼 URL)과 분리한 이유는 두 기만 수단의 탐지 건수를
--     각각 집계해야 하기 때문이다. 합쳐두면 어느 미끼가 걸렸는지 구분되지 않는다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20260826_anomaly_type_canary.sql

ALTER TABLE anomaly_logs
  MODIFY COLUMN anomaly_type ENUM(
    'BRUTE_FORCE',
    'ABNORMAL_TIME',
    'CONCURRENT_SESSION',
    'ABNORMAL_COUNTRY',
    'HONEYPOT',
    'ABUSE_IP',
    'REQUEST_TAMPERING',
    'REPLAY_ATTACK',
    'ADVERSARIAL_INPUT',
    'MODEL_EXTRACTION',
    'ABNORMAL_TRADE_AMOUNT',
    'INFERENCE_ABUSE',
    'IMPOSSIBLE_TRAVEL',
    'CREDENTIAL_STUFFING',
    'POST_CHANGE_TRADE',
    'DORMANT_ACCOUNT_ACTIVITY',
    'TRADE_FREQUENCY_SPIKE',
    'MULTI_ACCOUNT_SAME_IP',
    'ROUND_AMOUNT_PATTERN',
    'ADAPTIVE_STEPUP',
    'CANARY_ACCESS'
  ) NOT NULL;
