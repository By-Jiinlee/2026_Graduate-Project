-- 2026-08-20 : 이상탐지 M-2 ~ M-8 기반 스키마
--
-- 기능을 만들기 전에 "판정 근거가 되는 데이터가 없던" 세 곳을 먼저 채운다.
--
--   (1) login_records.latitude/longitude
--       Impossible Travel(M-4)은 두 접속 지점의 거리/시간 → 속도를 봐야 하는데
--       기존에는 country/region/city 만 저장해 거리 계산이 불가능했다.
--
--   (2) users.password_changed_at
--       계정 정보 변경 직후 고액 거래(M-2)는 탈취 계정의 전형적 인출 패턴이다.
--       email_changed_at 은 있었으나 비밀번호 변경 시각은 남지 않아 평가할 수 없었다.
--
--   (3) trade_auth_attempts (신규)
--       PIN 실패 이력이 인메모리 Map 에만 있어 재시작 시 소실됐고, "N회 실패 후 성공"
--       (M-5, 크리덴셜 스터핑)을 성공 시점에 조회할 수 없었다.
--
--   (4) anomaly_logs : 신규 유형 5종
--   (5) 조회 인덱스 — 거래 빈도(M-6)·동일 IP 다계정(M-7) 은 매 주문마다 집계하므로
--       인덱스가 없으면 풀스캔이 된다. (user_id, ordered_at) 는 기존에 있고
--       여기서는 IP 축 조회용 (ip_address, ordered_at) 을 추가한다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20260820_anomaly_detection_m2_m8.sql

-- ── (1) 로그인 좌표 ───────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'login_records' AND column_name = 'latitude');
SET @s := IF(@c = 0, 'ALTER TABLE login_records ADD COLUMN latitude DECIMAL(9,6) NULL AFTER city', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'login_records' AND column_name = 'longitude');
SET @s := IF(@c = 0, 'ALTER TABLE login_records ADD COLUMN longitude DECIMAL(9,6) NULL AFTER latitude', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- M-4 는 사용자별 최근 로그인을 시간 역순으로 조회한다.
SET @c := (SELECT COUNT(*) FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'login_records' AND index_name = 'idx_login_records_user_time');
SET @s := IF(@c = 0, 'CREATE INDEX idx_login_records_user_time ON login_records (user_id, logged_at)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── (2) 비밀번호 변경 시각 ────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'password_changed_at');
SET @s := IF(@c = 0, 'ALTER TABLE users ADD COLUMN password_changed_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── (3) 거래 인증 시도 기록 ───────────────────────────────────
CREATE TABLE IF NOT EXISTS trade_auth_attempts (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  user_id      BIGINT       NOT NULL,
  method       ENUM('PIN','WALLET_SIGNATURE') NOT NULL,
  success      TINYINT(1)   NOT NULL,
  ip           VARCHAR(45)  NOT NULL,
  user_agent   VARCHAR(500) NULL,
  attempted_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_trade_auth_user_time (user_id, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── (4) 이상 유형 추가 ────────────────────────────────────────
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
    'ROUND_AMOUNT_PATTERN'
  ) NOT NULL;

-- ── (5) IP 축 주문 조회 인덱스 (M-7) ──────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'virtual_orders' AND index_name = 'idx_virtual_orders_ip_time');
SET @s := IF(@c = 0, 'CREATE INDEX idx_virtual_orders_ip_time ON virtual_orders (ip_address, ordered_at)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'real_orders' AND index_name = 'idx_real_orders_ip_time');
SET @s := IF(@c = 0, 'CREATE INDEX idx_real_orders_ip_time ON real_orders (ip_address, ordered_at)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
