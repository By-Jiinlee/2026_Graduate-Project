-- 2026-10-04 : anomaly_logs.anomaly_type ENUM 병합
--
--   20261001_* 마이그레이션이 두 갈래에서 같은 ENUM 을 각자 MODIFY 했다.
--     - 장부/다계정 쪽 : MULTI_ACCOUNT_DEVICE, LEDGER_TAMPERING
--     - 시장조작/생체/지문 쪽 : SPOOFING_ORDER, WASH_TRADE, BOT_TRADE_BEHAVIOR,
--                              BEHAVIOR_BIOMETRIC_MISMATCH, DEVICE_FINGERPRINT_MISMATCH
--   MODIFY 는 목록 전체를 덮어쓰므로 나중에 적용된 쪽이 먼저 적용된 쪽의 값을 지운다.
--   STRICT_TRANS_TABLES 에서는 지워진 값으로 INSERT 하면 실패해 탐지 기록이 유실된다.
--   이 파일은 두 목록의 합집합으로 다시 맞춘다. 어느 20261001_* 를 다시 돌렸든 마지막에 이것을 적용한다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261004_anomaly_type_union.sql

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
    'CANARY_ACCESS',
    'BOT_BEHAVIOR_MOUSE',
    'BOT_BEHAVIOR_TYPING',
    'MULTI_ACCOUNT_DEVICE',
    'LEDGER_TAMPERING',
    'SPOOFING_ORDER',
    'WASH_TRADE',
    'BOT_TRADE_BEHAVIOR',
    'BEHAVIOR_BIOMETRIC_MISMATCH',
    'DEVICE_FINGERPRINT_MISMATCH'
  ) NOT NULL;
