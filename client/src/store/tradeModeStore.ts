import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type TradeMode = 'real' | 'virtual'

interface TradeModeStore {
  mode: TradeMode
  setMode: (mode: TradeMode) => void
  reset: () => void
}

export const useTradeModeStore = create<TradeModeStore>()(
  persist(
    (set) => ({
      mode: 'real',
      setMode: (mode) => set({ mode }),
      reset: () => set({ mode: 'real' }),
    }),
    { name: 'trade-mode' },
  ),
)
