// ─────────────────────────────────────────────────────────────
// 강화된 디바이스 핑거프린팅 — 하드웨어 컴포넌트 수집 + 조합 해시
//
// 기존 서버 핑거프린트는 User-Agent 만 써서 변조가 쉬웠다. 여기서는 Canvas·WebGL·
// AudioContext·설치 폰트·타임존·화면/플랫폼을 수집해 하나의 조합 해시(SHA-256, hex)로 만든다.
// 이 값을 로그인 요청의 X-Device-Components 헤더로 보내면 서버가 신뢰 기기 식별에 쓴다.
//
// 설계 원칙
//   · 모든 수집기는 실패해도 전체가 죽지 않도록 try/catch 로 감싼다(브라우저·권한 차이).
//   · 결과는 세션 내 1회만 계산하고 캐시한다(값이 안정적이고 수집 비용이 있으므로).
//   · 개인정보가 아닌 "기기 구성"만 모은다 — 쿠키·저장소·계정 식별자는 쓰지 않는다.
// ─────────────────────────────────────────────────────────────

let cached: string | null = null
let inflight: Promise<string> | null = null

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

// Canvas 2D — 글리프 렌더링은 OS·GPU·드라이버에 따라 미세하게 달라진다.
function canvasFingerprint(): string {
  return safe(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 240
    canvas.height = 60
    const ctx = canvas.getContext('2d')
    if (!ctx) return 'no-2d'
    ctx.textBaseline = 'top'
    ctx.font = "16px 'Arial'"
    ctx.fillStyle = '#f60'
    ctx.fillRect(10, 10, 100, 30)
    ctx.fillStyle = '#069'
    ctx.fillText('Uptick 디바이스 지문 \u{1F512}', 12, 14)
    ctx.strokeStyle = 'rgba(120,180,60,0.7)'
    ctx.beginPath()
    ctx.arc(60, 30, 20, 0, Math.PI * 2)
    ctx.stroke()
    return canvas.toDataURL()
  }, 'no-canvas')
}

// WebGL — GPU 벤더/렌더러 문자열과 몇 가지 파라미터.
function webglFingerprint(): string {
  return safe(() => {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (!gl) return 'no-webgl'
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    const params = [
      gl.getParameter(gl.MAX_TEXTURE_SIZE),
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      (gl.getSupportedExtensions() || []).length,
    ]
    return `${vendor}~${renderer}~${params.join(',')}`
  }, 'no-webgl')
}

// AudioContext — 오디오 처리 스택의 미세한 수치 차이. OfflineAudioContext 로 렌더링해 합산.
async function audioFingerprint(): Promise<string> {
  try {
    const Ctx: typeof OfflineAudioContext =
      (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext
    if (!Ctx) return 'no-audio'
    const ctx = new Ctx(1, 44100, 44100)
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = 10000
    const comp = ctx.createDynamicsCompressor()
    osc.connect(comp)
    comp.connect(ctx.destination)
    osc.start(0)
    const buffer = await ctx.startRendering()
    const data = buffer.getChannelData(0)
    let sum = 0
    for (let i = 4000; i < 5000; i++) sum += Math.abs(data[i])
    return sum.toString()
  } catch {
    return 'no-audio'
  }
}

// 설치 폰트 추정 — 기준 폰트 대비 글자 폭 변화로 특정 폰트 존재 여부를 본다.
function fontFingerprint(): string {
  return safe(() => {
    const baseFonts = ['monospace', 'sans-serif', 'serif']
    const testFonts = [
      'Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana',
      'Malgun Gothic', 'Gulim', 'Batang', 'Dotum', 'NanumGothic',
      'Apple SD Gothic Neo', 'Helvetica', 'Tahoma', 'Impact',
    ]
    const text = 'mmmmmmmmmmlli가나다'
    const size = '72px'
    const span = document.createElement('span')
    span.style.position = 'absolute'
    span.style.left = '-9999px'
    span.style.fontSize = size
    span.textContent = text
    document.body.appendChild(span)

    const baseline: Record<string, { w: number; h: number }> = {}
    for (const b of baseFonts) {
      span.style.fontFamily = b
      baseline[b] = { w: span.offsetWidth, h: span.offsetHeight }
    }
    const present: string[] = []
    for (const f of testFonts) {
      let detected = false
      for (const b of baseFonts) {
        span.style.fontFamily = `'${f}',${b}`
        if (span.offsetWidth !== baseline[b].w || span.offsetHeight !== baseline[b].h) {
          detected = true
          break
        }
      }
      if (detected) present.push(f)
    }
    document.body.removeChild(span)
    return present.join(',')
  }, 'no-fonts')
}

function miscFingerprint(): string {
  const tz = safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone, 'no-tz')
  const offset = safe(() => String(new Date().getTimezoneOffset()), 'no-offset')
  const screenInfo = safe(
    () => `${screen.width}x${screen.height}x${screen.colorDepth}@${window.devicePixelRatio}`,
    'no-screen',
  )
  const platform = safe(() => navigator.platform || 'no-platform', 'no-platform')
  const cores = safe(() => String(navigator.hardwareConcurrency ?? '?'), '?')
  const mem = safe(() => String((navigator as any).deviceMemory ?? '?'), '?')
  const langs = safe(() => (navigator.languages || [navigator.language]).join(','), 'no-lang')
  return [tz, offset, screenInfo, platform, cores, mem, langs].join('|')
}

async function sha256Hex(input: string): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(input)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    // SubtleCrypto 불가(비보안 컨텍스트 등) — 간단한 폴백 해시(식별용, 보안 용도 아님).
    let h = 0
    for (let i = 0; i < input.length; i++) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0
    return `fallback-${(h >>> 0).toString(16)}`
  }
}

/**
 * 하드웨어 컴포넌트 조합 해시(SHA-256 hex)를 반환한다. 세션 내 1회만 계산하고 캐시한다.
 * 어떤 수집기가 실패해도 그 자리에 'no-*' 가 들어가 해시는 항상 계산된다.
 */
export async function getDeviceComponentsHash(): Promise<string> {
  if (cached) return cached
  if (inflight) return inflight
  inflight = (async () => {
    const parts = [
      canvasFingerprint(),
      webglFingerprint(),
      await audioFingerprint(),
      fontFingerprint(),
      miscFingerprint(),
    ]
    const hash = await sha256Hex(parts.join('###'))
    cached = hash
    return hash
  })()
  return inflight
}
