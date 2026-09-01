-- 2026-07-30 : AI 추론 파이프라인 보안
--   (1) inference_logs : 추론 요청 감사 로그(허용·차단 전건)
--   (2) anomaly_logs   : AI 남용 이상탐지 유형 추가
--        ADVERSARIAL_INPUT : 입력 스키마 위반 반복
--        MODEL_EXTRACTION  : 대량·광범위 질의(모델 추출 의심)
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20260730_inference_logs.sql

CREATE TABLE IF NOT EXISTS inference_logs (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '기본키',
  user_id BIGINT DEFAULT NULL COMMENT '요청 사용자',
  ip VARCHAR(45) NOT NULL COMMENT '요청 IP',
  user_agent TEXT DEFAULT NULL COMMENT 'User-Agent',
  stock_code VARCHAR(12) DEFAULT NULL COMMENT '조회 종목코드',
  horizon VARCHAR(4) DEFAULT NULL COMMENT '예측 구간(1d/1w/1m/1y)',
  decision ENUM('ALLOW','DENY') NOT NULL COMMENT '허용 여부',
  deny_reason VARCHAR(40) DEFAULT NULL COMMENT '차단 사유 코드',
  label TINYINT DEFAULT NULL COMMENT '1=상승, 0=하락',
  probability DECIMAL(6,5) DEFAULT NULL COMMENT '모델 원본 상승확률(응답에는 양자화 값만 노출)',
  latency_ms INT DEFAULT NULL COMMENT '모델 호출 지연(ms)',
  adapter VARCHAR(20) DEFAULT NULL COMMENT '사용된 추론 어댑터',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '요청 일시',
  PRIMARY KEY (id),
  KEY idx_inference_user (user_id),
  KEY idx_inference_created (created_at),
  KEY idx_inference_decision (decision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 추론 요청 감사 로그';

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
    'MODEL_EXTRACTION'
  ) NOT NULL;
