import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: { base: './', plugins: [react()], build: { assetsInlineLimit: 0 } }
})
