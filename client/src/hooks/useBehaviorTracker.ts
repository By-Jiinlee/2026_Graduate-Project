import { useState, useEffect, useRef, useCallback } from 'react'

export interface BehaviorData {
  mouseMoveCount: number
  clickCount: number
  keyPressCount: number
  avgTypingInterval: number // 타자 치는 평균 간격(ms)
  timeOnPage: number // 페이지 체류 시간(ms)
}

export const useBehaviorTracker = () => {
  const [mouseMoveCount, setMouseMoveCount] = useState(0)
  const [clickCount, setClickCount] = useState(0)
  const [keyPressCount, setKeyPressCount] = useState(0)
  
  const lastKeyTime = useRef<number>(0)
  const typingIntervals = useRef<number[]>([])
  const startTime = useRef<number>(Date.now())

  // 마우스 이동 추적 (과도한 렌더링 방지를 위해 쓰로틀링 적용 가능하나, 여기선 단순 카운트)
  const handleMouseMove = useCallback(() => {
    setMouseMoveCount(prev => prev + 1)
  }, [])

  // 클릭 추적
  const handleClick = useCallback(() => {
    setClickCount(prev => prev + 1)
  }, [])

  // 키보드 입력 및 타자 속도(간격) 추적
  const handleKeyDown = useCallback(() => {
    const now = Date.now()
    if (lastKeyTime.current > 0) {
      const interval = now - lastKeyTime.current
      if (interval < 3000) { // 3초 이내의 연속 입력만 유효한 타자로 간주
        typingIntervals.current.push(interval)
      }
    }
    lastKeyTime.current = now
    setKeyPressCount(prev => prev + 1)
  }, [])

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleMouseMove, handleClick, handleKeyDown])

  // 수집된 데이터를 하나로 묶어서 반환하는 함수
  const getBehaviorData = useCallback((): BehaviorData => {
    const intervals = typingIntervals.current
    const avgTypingInterval = intervals.length > 0 
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length 
      : 0

    return {
      mouseMoveCount,
      clickCount,
      keyPressCount,
      avgTypingInterval: Math.round(avgTypingInterval),
      timeOnPage: Date.now() - startTime.current
    }
  }, [mouseMoveCount, clickCount, keyPressCount])

  return { getBehaviorData }
}