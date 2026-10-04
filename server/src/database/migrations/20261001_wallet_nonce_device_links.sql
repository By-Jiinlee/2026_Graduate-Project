-- 2026-10-01 : 지갑 인증 결함 수정 + 단말 다계정 탐지
--
--   (1) wallet_nonce_uses (신규)
--       컨트랙트 논스는 검증 트랜잭션이 블록에 포함된 뒤에야 증가한다. 서버가 포함을 기다리지
--       않으므로 포함 전 약 12초 동안 같은 서명이 사전 실행 검증을 다시 통과했다.
--       (지갑, 용도, 논스) 유일 제약으로 서버가 소비한 논스를 즉시 확정한다.
--
--   (2) device_account_links (신규)
--       1인 1계정 원칙 감시 — 한 단말(서버 발급 식별 쿠키의 HMAC)에서 쓰인 계정 목록.
--
--   (3) anomaly_logs : MULTI_ACCOUNT_DEVICE 유형 추가
--       기존 값 목록은 20260929_anomaly_type_bot_behavior.sql 과 동일하다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261001_wallet_nonce_device_links.sql

CREATE TABLE IF NOT EXISTS wallet_nonce_uses (
  id             BIGINT         NOT NULL AUTO_INCREMENT,
  wallet_address VARCHAR(42)    NOT NULL,
  purpose        ENUM('AUTH','TRADE') NOT NULL,
  nonce          VARCHAR(78)    NOT NULL,  -- uint256 십진 문자열(DECIMAL 은 최대 65자리라 담지 못함)
  tx_hash        VARCHAR(66)    NULL,
  created_at     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wallet_nonce_use (wallet_address, purpose, nonce)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS device_account_links (
  id            BIGINT      NOT NULL AUTO_INCREMENT,
  device_hash   CHAR(64)    NOT NULL,
  user_id       BIGINT      NOT NULL,
  first_event   ENUM('REGISTER','LOGIN') NOT NULL,
  first_seen_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_device_account (device_hash, user_id),
  KEY idx_device_last_seen (device_hash, last_seen_at)
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
    'MULTI_ACCOUNT_DEVICE'
  ) NOT NULL;
