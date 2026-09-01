import path from 'path'

// ─────────────────────────────────────────────────────────────
// 상태 파일의 기준 경로
//
// 컨테이너 파일시스템은 재배포·재시작마다 초기화된다. KIS 토큰이나 백필 진행상황처럼
// 살아남아야 하는 파일은 영속 볼륨에 둬야 하므로, 기준 경로를 환경변수로 뽑아낸다.
//
//   배포(레일웨이) : 볼륨을 /data 에 마운트하고 DATA_DIR=/data
//   로컬 개발      : 환경변수 없이 기존과 동일하게 server/ 아래를 쓴다
//
// 빌드 후 경로도 같다 — dist/utils → dist → server 로 두 단계다.
// ─────────────────────────────────────────────────────────────
const ROOT = process.env.DATA_DIR ?? path.join(__dirname, '../..')

export const dataPath = (...segments: string[]): string => path.join(ROOT, ...segments)
