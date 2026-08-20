-- 2026-08-20 : AI 추론 보안 위협 재분류
--
-- 배경: 배치 서빙 구조에서 'MODEL_EXTRACTION'(모델 추출)은 성립하지 않는 위협이었다.
--   모델 추출 공격은 공격자가 특징 벡터를 바꿔가며 결정 경계를 탐침해야 성립하는데,
--   이 API 의 입력은 {code, horizon} 즉 조회 키뿐이라 입력을 변화시킬 수 없다.
--   전 종목을 조회해도 얻는 것은 "그날 하루치 예측 테이블"이지 모델이 아니다.
--   따라서 호출량 초과는 모델 도난이 아니라 조회 API 남용으로 분류하는 것이 정확하다.
--
--   (1) anomaly_logs : INFERENCE_ABUSE 유형 추가
--   (2) MODEL_EXTRACTION 은 ENUM 에 남긴다 — 7월 검증 당시 기록된 기존 행을 보존하기 위함.
--       신규 기록은 더 이상 이 유형을 쓰지 않는다.
--   (3) inference_logs.deny_reason : EXTRACTION_SUSPECTED 제거
--       광범위 종목 스캔 규칙을 폐기했으므로 이 사유는 더 이상 발생하지 않는다.
--       기존 행이 있으면 남용(RATE_LIMIT)으로 재분류한 뒤 ENUM 에서 제거한다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20260820_inference_abuse_type.sql

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
    'INFERENCE_ABUSE'
  ) NOT NULL;

-- 폐기한 사유를 쓰는 기존 행을 먼저 옮긴다(ENUM 축소 시 빈 문자열로 깨지는 것을 방지).
UPDATE inference_logs
   SET deny_reason = 'RATE_LIMIT'
 WHERE deny_reason = 'EXTRACTION_SUSPECTED';

ALTER TABLE inference_logs
  MODIFY COLUMN deny_reason ENUM(
    'INVALID_SHAPE',
    'UNKNOWN_FIELD',
    'INVALID_CODE',
    'UNKNOWN_CODE',
    'INVALID_HORIZON',
    'RATE_LIMIT',
    'BURST_LIMIT',
    'MODEL_OUTPUT_INVALID',
    'MODEL_UNAVAILABLE',
    'NOT_PREDICTED'
  ) NULL;
