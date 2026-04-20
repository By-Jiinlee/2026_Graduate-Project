import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ProfileStore {
  profileImage: string | null
  setProfileImage: (url: string | null) => void
}

export const useProfileStore = create<ProfileStore>()(
  persist(
    (set) => ({
      profileImage: null,
      setProfileImage: (url) => set({ profileImage: url }),
    }),
    { name: 'upTick_profile' },
  ),
)
