-- 2026-10-01 : 휴대폰 번호 로그인 — 휴대폰 인증만으로 가입한 계정은 이메일이 없다
--
--   users.email : NOT NULL → NULL 허용. 유일 인덱스는 그대로(MariaDB 는 NULL 을 여러 개 허용한다).
--   withdrawn_users.email : 같은 이유로 NULL 허용(휴대폰 가입 계정의 탈퇴 이관).
--   기존 행은 바뀌지 않는다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261001_phone_login.sql

ALTER TABLE users MODIFY COLUMN email VARCHAR(100) NULL;
ALTER TABLE withdrawn_users MODIFY COLUMN email VARCHAR(100) NULL;
