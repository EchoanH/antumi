import { Appearance } from 'react-native'
import { setStatusBarStyle } from 'expo-status-bar'

// The status bar's icons, set again for the theme. Android lets what opens over the app (the photo
// picker, the camera, the fingerprint prompt, the system on a return) leave them as it set them,
// light on a light page, and the app sets them only when the theme changes.
export function restoreStatusBar(): void {
  setStatusBarStyle(Appearance.getColorScheme() === 'dark' ? 'light' : 'dark', false)
}
