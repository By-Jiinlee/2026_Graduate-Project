-- 2026-07-30 : HMAC 요청서명 검증 실패를 이상탐지 로그로 기록하기 위한 ENUM 확장
--   REQUEST_TAMPERING : 서명 불일치 — 요청 본문 위·변조
--   REPLAY_ATTACK     : 논스 재사용·서명 유효시간 초과 — 요청 재전송
--
-- 적용:
--   mysql -u <user> -p <db_name> < src/database/migrations/20260730_anomaly_type_hmac.sql

ALTER TABLE anomaly_logs
  MODIFY COLUMN anomaly_type ENUM(
    'BRUTE_FORCE',
    'ABNORMAL_TIME',
    'CONCURRENT_SESSION',
    'ABNORMAL_COUNTRY',
    'HONEYPOT',
    'ABUSE_IP',
    'REQUEST_TAMPERING',
    'REPLAY_ATTACK'
  ) NOT NULL;
