-- 2026-08-21 : 적응형 인증(H) 판정 기록
--
-- 배경: 위험 점수 엔진이 로그인마다 요구 인증 강도를 산출하지만, 그 판정이
--   console 로만 남아 있어 (1) 관리자 화면이 집계할 수 없고 (2) 강제 적용 전에
--   실제 등급 분포를 측정할 수 없다. 가중치·임계를 실측으로 조정하려면 기록이 필요하다.
--
--   ADAPTIVE_STEPUP : 위험 점수로 인해 추가 인증이 요구된 판정.
--     · 관측 모드(ADAPTIVE_AUTH_ENFORCE 미설정)에서도 기록한다 —
--       강제하기 전에 분포를 모으는 것이 이 유형의 1차 목적이기 때문이다.
--     · action 은 관측 모드면 ALERT, 강제 모드에서 실제로 막았으면 BLOCK 으로 남는다.
--     · requirement 가 NONE 인 통과 건은 기록하지 않는다(전 로그인이 기록되어 무의미해짐).
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20260821_adaptive_auth.sql

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
    'ADAPTIVE_STEPUP'
  ) NOT NULL;
