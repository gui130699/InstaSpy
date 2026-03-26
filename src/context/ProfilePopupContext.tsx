import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

interface ProfilePopupState {
  username: string | null
  open: boolean
}

interface ProfilePopupContextValue {
  openProfile: (username: string) => void
  closeProfile: () => void
  state: ProfilePopupState
}

const ProfilePopupContext = createContext<ProfilePopupContextValue | null>(null)

export function ProfilePopupProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProfilePopupState>({ username: null, open: false })

  const openProfile = useCallback((username: string) => {
    setState({ username: username.replace('@', '').trim(), open: true })
  }, [])

  const closeProfile = useCallback(() => {
    setState(prev => ({ ...prev, open: false }))
  }, [])

  return (
    <ProfilePopupContext.Provider value={{ openProfile, closeProfile, state }}>
      {children}
    </ProfilePopupContext.Provider>
  )
}

export function useProfilePopup() {
  const ctx = useContext(ProfilePopupContext)
  if (!ctx) throw new Error('useProfilePopup deve ser usado dentro de ProfilePopupProvider')
  return ctx
}
