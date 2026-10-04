-- 2026-10-01 : 가입 본인 인증 우회 수정 — "사용 처리됨"과 "인증 성공"의 의미 분리
--
--   email_verifications / sms_verifications 에 세 컬럼 추가
--     verified_at : 코드 입력 성공 시각. 가입은 이 값이 최근 30분 이내인 기록만 인정한다.
--                   (이전에는 is_used=1 이면 성공으로 봤는데, 재발송 무효화·5회 실패 폐기도 is_used=1 이라
--                    코드를 입력하지 않고 재발송만 해도 가입 인증을 통과했다)
--     consumed_at : 이 인증으로 가입을 마친 시각. 인증 한 번으로 계정 두 개를 만들지 못하게 한다.
--     purpose     : SIGNUP / PHONE_CHANGE(마이페이지) / EMAIL_CHANGE — 다른 용도의 인증을 가입에 못 쓰게 한다.
--   기존 행은 purpose=SIGNUP, verified_at=NULL 이 되어 가입 근거로 인정되지 않는다(진행 중이던 가입은 재인증 필요).
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261001_signup_verification.sql

SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'email_verifications' AND column_name = 'verified_at');
SET @s := IF(@c = 0, 'ALTER TABLE email_verifications ADD COLUMN purpose ENUM(''SIGNUP'',''PHONE_CHANGE'',''EMAIL_CHANGE'') NOT NULL DEFAULT ''SIGNUP'', ADD COLUMN verified_at DATETIME NULL, ADD COLUMN consumed_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'sms_verifications' AND column_name = 'verified_at');
SET @s := IF(@c = 0, 'ALTER TABLE sms_verifications ADD COLUMN purpose ENUM(''SIGNUP'',''PHONE_CHANGE'',''EMAIL_CHANGE'') NOT NULL DEFAULT ''SIGNUP'', ADD COLUMN verified_at DATETIME NULL, ADD COLUMN consumed_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
