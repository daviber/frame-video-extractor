import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Sostituisci NOME_REPO con il nome esatto del repo GitHub
export default defineConfig({
  plugins: [react()],
  base: '/frame-video-extractor/',
})