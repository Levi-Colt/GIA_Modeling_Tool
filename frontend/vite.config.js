import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' is the whole ballgame for CryoCloud deployment. The app is
// served under a per-user, per-session path prefix via jupyter-server-proxy
// (e.g. /user/<name>/proxy/<port>/), which is not knowable at build time.
// Relative asset paths mean the build works under any prefix, unmodified.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // Dev-only convenience: forwards /api calls to a local FastAPI instance
    // running on 8000 so `npm run dev` works without CORS juggling. This
    // config has no effect in production — FastAPI serves the built
    // frontend directly there, so /api and the frontend share an origin.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist'
  },
  // Vitest reads this same `test` key from the shared vite config -- no
  // separate vitest.config.js. jsdom gives the component tests a DOM;
  // setupFiles wires up @testing-library/jest-dom's matchers globally.
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js']
  }
})
