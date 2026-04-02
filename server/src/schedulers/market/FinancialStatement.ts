import cron from 'node-cron'
import {
    syncCorpCodes,
    fetchFinancialStatements,
    upsertFinancialStatements,
    getActiveCorpCodes,
} from '../../services/market/FinancialStatement'

// ─── 수집 로직 ────────────────────────────────────────────────

export const collectFinancialStatements = async (): Promise<void> => {
    console.log('[FinancialStatement] 수집 시작')

    // 1) corp_code 최신화
    await syncCorpCodes()

    // 2) 활성 종목 corp_code 목록 조회
    const corps = await getActiveCorpCodes()
    if (corps.length === 0) {
        console.warn('[FinancialStatement] corp_code 매핑된 종목 없음')
        return
    }

    // 3) 당해연도 + 전년도 수집
    const currentYear = new Date().getFullYear()
    const years = [String(currentYear - 1), String(currentYear - 2)]

    // DART API는 한 번에 최대 100개 corp_code 허용
    const CHUNK_SIZE = 100
    const corpCodes = corps.map((c) => c.corp_code)

    for (const year of years) {
        for (let i = 0; i < corpCodes.length; i += CHUNK_SIZE) {
            const chunk = corpCodes.slice(i, i + CHUNK_SIZE)

            try {
                const items = await fetchFinancialStatements(chunk, year)
                await upsertFinancialStatements(items)

                console.log(
                    `[FinancialStatement] ${year}년 ${i + chunk.length}/${corpCodes.length} 완료`
                )

                // DART API rate limit 방지
                await new Promise((r) => setTimeout(r, 500))
            } catch (err) {
                console.error(`[FinancialStatement] ${year}년 청크 오류:`, err)
            }
        }
    }

    console.log('[FinancialStatement] 수집 완료')
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startFinancialStatementScheduler = (): void => {
    // 분기 1회: 매년 4/1, 8/1, 11/1 오전 2시 (공시 시즌 이후)
    cron.schedule(
        '0 2 1 4,8,11 *',
        () => {
            collectFinancialStatements().catch((err) =>
                console.error('[FinancialStatement] 스케줄러 오류:', err)
            )
        },
        { timezone: 'Asia/Seoul' }
    )

    console.log('[FinancialStatement] 스케줄러 등록 완료 (분기 1회)')

    // 서버 시작 시 누락 데이터 즉시 수집
    collectFinancialStatements().catch((err) =>
        console.error('[FinancialStatement] 초기 수집 오류:', err)
    )
}