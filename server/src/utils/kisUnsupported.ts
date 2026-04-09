import fs from 'fs'
import path from 'path'

const FILE = path.join(process.cwd(), 'data', 'kis_unsupported.json')

const load = (): Set<string> => {
    try {
        const codes = JSON.parse(fs.readFileSync(FILE, 'utf-8'))
        console.log(`[KisUnsupported] 403 스킵 목록 로드: ${codes.length}개`)
        return new Set(codes)
    } catch {
        return new Set()
    }
}

const save = (set: Set<string>) => {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true })
        fs.writeFileSync(FILE, JSON.stringify([...set], null, 2))
    } catch (err: any) {
        console.error('[KisUnsupported] 저장 실패:', err.message)
    }
}

export const kisUnsupported = load()

export const markUnsupported = (code: string) => {
    if (kisUnsupported.has(code)) return
    kisUnsupported.add(code)
    save(kisUnsupported)
}
