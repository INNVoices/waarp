import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import './layout.css'
import { createRoot } from 'react-dom/client'
import { loadLocale } from '../../shared/localization'

async function mount() {
  const locale = await loadLocale(navigator.languages)
  document.documentElement.lang = locale
  document.documentElement.dir = locale === 'ar' || locale === 'fa' ? 'rtl' : 'ltr'
  const { App } = await import('./App')
  createRoot(document.getElementById('root')!).render(<App />)
}
void mount()
