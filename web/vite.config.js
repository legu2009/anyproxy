import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    open: '/__anyproxy/web/index.html',  // 假设你的首页在 /web/ 目录下
    proxy: {
      '^/__anyproxy/api/.*': {
        target: 'http://localhost:8005',
        changeOrigin: true,
      },
    },
  },
  
  base: '/__anyproxy/web/',
  plugins: [react()],
})
