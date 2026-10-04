-- 2026-10-01 : 모의투자 체결 장부 일별 고정(머클 앵커링)
--
--   (1) ledger_anchors (신규)
--       하루치 체결 주문의 머클 루트와 잎 목록. 루트는 MockTrade.anchorLedger 로 체인에 고정한다.
--   (2) anomaly_logs : LEDGER_TAMPERING 유형 추가
--       고정된 루트와 현재 장부로 다시 계산한 루트가 다르면 기록한다.
--       기존 값 목록은 20261001_wallet_nonce_device_links.sql 과 동일하다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261001_ledger_anchor.sql

CREATE TABLE IF NOT EXISTS ledger_anchors (
  id                 BIGINT       NOT NULL AUTO_INCREMENT,
  anchor_date        INT          NOT NULL,
  merkle_root        CHAR(66)     NOT NULL,
  leaf_count         INT          NOT NULL,
  leaves             LONGTEXT     NOT NULL,
  status             ENUM('LOCAL','SUBMITTED','FAILED') NOT NULL,
  tx_hash            VARCHAR(66)  NULL,
  last_verify_result ENUM('MATCH','MISMATCH') NULL,
  verified_at        DATETIME     NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_anchor_date (anchor_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
    'LEDGER_TAMPERING'
  ) NOT NULL;
