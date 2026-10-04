-- 2026-10-01 : 행동 생체인식 프로필
--
--   (1) behavior_profiles (신규)
--       사용자별 키스트로크·마우스 리듬의 러닝 통계(EWMA 평균·분산)를 누적한다.
--       로그인마다 현재 특징과 비교해 유사도가 미달하면 세션 탈취 의심 신호를 남긴다.
--       한 사용자당 한 행(user_id PK). 특징 3종(타자 간격 / 마우스 이동률 / 키 입력률).
--
--   (2) anomaly_logs : BEHAVIOR_BIOMETRIC_MISMATCH 유형 추가
--       기본은 관측(위험 점수 상한 그룹). BIOMETRIC_ENFORCE=true 시 gating 으로 재인증 유발.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261001_behavior_profiles.sql

-- ── (1) 프로필 테이블 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS behavior_profiles (
  user_id         BIGINT   NOT NULL,
  sample_count    INT      NOT NULL DEFAULT 0,
  typing_mean     DOUBLE   NULL,
  typing_var      DOUBLE   NULL,
  mouse_rate_mean DOUBLE   NULL,
  mouse_rate_var  DOUBLE   NULL,
  key_rate_mean   DOUBLE   NULL,
  key_rate_var    DOUBLE   NULL,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
    'BEHAVIOR_BIOMETRIC_MISMATCH'
  ) NOT NULL;
