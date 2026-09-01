// ─────────────────────────────────────────────────────────────
// 서버 기동 직후의 "초기 1회 수집" 통제
//
// 수집 스케줄러들은 등록 직후 전종목 수집을 한 번 돌리도록 돼 있었다. 로컬에서는
// 서버를 가끔 켜니 드러나지 않았지만, 배포 환경은 재배포·크래시·플랫폼 재시작이
// 잦아 그때마다 3,590종목 수집이 처음부터 다시 시작된다. 수집기 여러 개가 동시에
// 깨어나면 KIS 유량 제한에 함께 걸리고, 실패한 채로 조용히 끝난다.
//
// 그래서 기본값을 '끔'으로 두고 크론 시각에만 돌게 한다. 최초 배포처럼 즉시
// 채워야 할 때만 RUN_INITIAL_COLLECT=true 로 켠다.
// ─────────────────────────────────────────────────────────────
export function runInitialCollect(label: string, task: () => Promise<void>): void {
    if (process.env.RUN_INITIAL_COLLECT !== 'true') {
        console.log(`[${label}] 초기 수집 생략 (RUN_INITIAL_COLLECT=true 로 활성화)`)
        return
    }

    task().catch((err) => console.error(`[${label}] 초기 수집 오류:`, err?.message ?? err))
}
