-- 2026-09-29 : 행동 기반 봇 신호 기록
--   anomaly_logs : BOT_BEHAVIOR_MOUSE, BOT_BEHAVIOR_TYPING 유형 추가
--     로그인 1단계에서 프론트가 보낸 behaviorData 로 판정한 봇 신호를 남긴다.
--     기록하지 않으면 로그인 2단계(실제 강제 지점)가 이 신호를 볼 수 없어,
--     1단계 안내값(requiredAuth)에만 반영되고 서버 강제에서는 빠지는 괴리가 생긴다.
--     스크립트는 안내값을 무시하고 서명 없이 2단계를 보낼 수 있으므로 그 괴리가 곧 우회 경로다.
--
-- 기존 값 목록은 적용 직전 실DB 의 SHOW COLUMNS 결과(20260826 과 동일)를 기준으로 했다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20260929_anomaly_type_bot_behavior.sql

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
    'BOT_BEHAVIOR_TYPING'
  ) NOT NULL;
