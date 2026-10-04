-- 2026-10-01 : 거래 봇 + 시장 조작 탐지 (허수주문·자전거래·거래화면 자동화)
--
--   (1) virtual_orders.cancelled_at
--       허수주문(스푸핑)은 "지정가 주문 직후 즉시 취소"의 반복이다. 기존 취소 경로는
--       status 만 'cancelled' 로 바꾸고 취소 시각을 남기지 않아, 생성→취소 지연(단명 여부)과
--       취소 반복 빈도를 사후에 계산할 수 없었다. 취소 시각을 기록해 판정 근거를 확보한다.
--
--   (2) anomaly_logs : 신규 유형 3종
--       SPOOFING_ORDER / WASH_TRADE / BOT_TRADE_BEHAVIOR 는 모두 관측 신호로 시작한다.
--       (MARKET_MANIP_ENFORCE=true 시에만 재인증 승격.)
--
-- 기존 값 목록은 20260929(bot_behavior) 과 동일한 집합을 기준으로 확장했다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261001_trade_manip_detection.sql

-- ── (1) 취소 시각 컬럼 (멱등 가드) ───────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'virtual_orders' AND column_name = 'cancelled_at');
SET @s := IF(@c = 0, 'ALTER TABLE virtual_orders ADD COLUMN cancelled_at DATETIME NULL AFTER filled_at', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 스푸핑 판정은 사용자별 최근 취소를 시간 역순으로 조회한다.
SET @c := (SELECT COUNT(*) FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'virtual_orders' AND index_name = 'idx_virtual_orders_user_status_time');
SET @s := IF(@c = 0, 'CREATE INDEX idx_virtual_orders_user_status_time ON virtual_orders (user_id, status, ordered_at)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── (2) anomaly_logs 신규 유형 3종 ──────────────────────────
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
    'SPOOFING_ORDER',
    'WASH_TRADE',
    'BOT_TRADE_BEHAVIOR'
  ) NOT NULL;
