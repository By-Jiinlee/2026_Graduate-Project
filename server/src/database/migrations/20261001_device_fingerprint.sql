-- 2026-10-01 : 강화된 디바이스 핑거프린팅
--
--   (1) trusted_devices.component_fingerprint
--       기존 핑거프린트는 User-Agent 해시만 썼다(변조가 쉬움). 여기에 클라이언트가 수집한
--       하드웨어 컴포넌트(캔버스·WebGL·AudioContext·폰트·타임존) 조합 해시를 더해 기기 식별
--       정확도를 높인다. 저장값과 달라지면 관측 신호(DEVICE_FINGERPRINT_MISMATCH)로 남기되,
--       신뢰 자체는 파기하지 않는다(드라이버·브라우저 업데이트 등 정상 변화의 오탐 방지).
--
--   (2) anomaly_logs : DEVICE_FINGERPRINT_MISMATCH 유형 추가
--       기본 관측(위험 점수 상한 그룹). DEVICE_FP_ENFORCE=true 시 gating 으로 재인증 유발.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261001_device_fingerprint.sql

-- ── (1) 컴포넌트 지문 컬럼 (멱등 가드) ───────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'trusted_devices' AND column_name = 'component_fingerprint');
SET @s := IF(@c = 0, 'ALTER TABLE trusted_devices ADD COLUMN component_fingerprint VARCHAR(64) NULL AFTER device_fingerprint', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── (2) anomaly_logs 신규 유형 ───────────────────────────────
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
    'BOT_TRADE_BEHAVIOR',
    'BEHAVIOR_BIOMETRIC_MISMATCH',
    'DEVICE_FINGERPRINT_MISMATCH'
  ) NOT NULL;
