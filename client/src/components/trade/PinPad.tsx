import { useState, useEffect, useRef } from 'react'

interface Props {
  title: string
  subtitle?: string
  onConfirm: (pin: string) => void
  onCancel: () => void
}

const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫']

export default function PinPad({ title, subtitle, onConfirm, onCancel }: Props) {
  const [pin, setPin] = useState('')
  const submitted = useRef(false)

  const handleKey = (k: string) => {
    if (k === '' || submitted.current) return
    if (k === '⌫') {
      setPin(p => p.slice(0, -1))
      return
    }
    if (pin.length >= 6) return

    const next = pin + k
    setPin(next)

    // 6자리가 채워지면 그 자리에서 제출한다.
    //
    // 예전에는 useEffect([pin]) 에서 제출했는데, effect 는 커밋 이후 비동기로 돌아
    // 부모가 PinPad 를 key 로 재마운트하는 타이밍과 겹쳤다. StrictMode 의 effect
    // 이중 실행까지 얹히면 제출이 두 번 불리거나 단계 전이가 어긋날 수 있다.
    // 입력 시점에 직접 부르면 그 경로가 통째로 사라진다.
    if (next.length === 6) {
      submitted.current = true
      onConfirm(next)
    }
  }

  // ESC로 닫기
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
      }}
    >
      <div
        style={{
          backgroundColor: '#fff',
          borderRadius: '24px',
          padding: '36px 32px 28px',
          width: '320px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
          animation: 'pin-slide-up 0.22s cubic-bezier(0.34,1.56,0.64,1)',
        }}
      >
        {/* 타이틀 */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{ fontSize: '16px', fontWeight: '800', color: '#111', marginBottom: '4px' }}>{title}</div>
          {subtitle && <div style={{ fontSize: '12px', color: '#9ca3af', fontWeight: '500' }}>{subtitle}</div>}
        </div>

        {/* 도트 인디케이터 */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '14px', marginBottom: '32px' }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              style={{
                width: '13px',
                height: '13px',
                borderRadius: '50%',
                backgroundColor: i < pin.length ? '#111' : 'transparent',
                border: `2px solid ${i < pin.length ? '#111' : '#d1d5db'}`,
                transition: 'all 0.15s ease',
                transform: i === pin.length - 1 ? 'scale(1.15)' : 'scale(1)',
              }}
            />
          ))}
        </div>

        {/* 숫자 패드 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '20px' }}>
          {KEYS.map((k, i) => (
            <button
              key={i}
              onClick={() => handleKey(k)}
              disabled={k === ''}
              style={{
                height: '56px',
                borderRadius: '14px',
                border: 'none',
                backgroundColor: k === '' ? 'transparent' : k === '⌫' ? '#f3f4f6' : '#f9fafb',
                color: k === '⌫' ? '#6b7280' : '#111',
                fontSize: k === '⌫' ? '20px' : '20px',
                fontWeight: k === '⌫' ? '400' : '600',
                cursor: k === '' ? 'default' : 'pointer',
                transition: 'all 0.1s',
                outline: 'none',
                userSelect: 'none',
                WebkitTapHighlightColor: 'transparent',
              }}
              onMouseDown={e => { if (k !== '') (e.currentTarget.style.backgroundColor = k === '⌫' ? '#e5e7eb' : '#f0fdf4'); (e.currentTarget.style.transform = 'scale(0.94)') }}
              onMouseUp={e => { if (k !== '') (e.currentTarget.style.backgroundColor = k === '⌫' ? '#f3f4f6' : '#f9fafb'); (e.currentTarget.style.transform = 'scale(1)') }}
              onMouseLeave={e => { if (k !== '') (e.currentTarget.style.backgroundColor = k === '⌫' ? '#f3f4f6' : '#f9fafb'); (e.currentTarget.style.transform = 'scale(1)') }}
            >
              {k}
            </button>
          ))}
        </div>

        {/* 취소 */}
        <button
          onClick={onCancel}
          style={{
            width: '100%',
            padding: '12px',
            border: 'none',
            background: 'none',
            color: '#9ca3af',
            fontSize: '14px',
            fontWeight: '600',
            cursor: 'pointer',
            borderRadius: '10px',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = '#6b7280')}
          onMouseLeave={e => (e.currentTarget.style.color = '#9ca3af')}
        >
          취소
        </button>
      </div>

      <style>{`
        @keyframes pin-slide-up {
          from { opacity: 0; transform: translateY(20px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  )
}
