-- 2026-08-01 : M-1 거래 이상탐지
--   (1) anomaly_logs : ABNORMAL_TRADE_AMOUNT 유형 추가
--        주문 무결성 위반(음수·소수 수량 등) + 개인 베이스라인 대비 이상 금액
--   (2) virtual_orders / real_orders : 베이스라인 조회용 (user_id, ordered_at) 인덱스
--        매 주문마다 최근 90일 표본을 조회하므로 인덱스가 없으면 풀스캔이 된다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20260801_anomaly_type_trade.sql

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
    'ABNORMAL_TRADE_AMOUNT'
  ) NOT NULL;

-- MySQL 은 CREATE INDEX IF NOT EXISTS 를 지원하지 않아 존재 여부를 확인 후 생성한다.
SET @idx_virtual := (SELECT COUNT(*) FROM information_schema.statistics
                      WHERE table_schema = DATABASE()
                        AND table_name = 'virtual_orders'
                        AND index_name = 'idx_virtual_orders_user_time');

SET @sql_virtual := IF(@idx_virtual = 0,
  'CREATE INDEX idx_virtual_orders_user_time ON virtual_orders (user_id, ordered_at)',
  'SELECT 1');

PREPARE stmt_virtual FROM @sql_virtual;
EXECUTE stmt_virtual;
DEALLOCATE PREPARE stmt_virtual;

SET @idx_real := (SELECT COUNT(*) FROM information_schema.statistics
                   WHERE table_schema = DATABASE()
                     AND table_name = 'real_orders'
                     AND index_name = 'idx_real_orders_user_time');

SET @sql_real := IF(@idx_real = 0,
  'CREATE INDEX idx_real_orders_user_time ON real_orders (user_id, ordered_at)',
  'SELECT 1');

PREPARE stmt_real FROM @sql_real;
EXECUTE stmt_real;
DEALLOCATE PREPARE stmt_real;
