import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

/** Starts Express + Gemini API so `/api` proxy always has a target in dev. */
function geminiApiDevPlugin() {
  let child

  return {
    name: 'gemini-api-dev',
    apply: 'serve',
    configureServer(viteServer) {
      if (child && !child.killed) {
        child.kill('SIGTERM')
        child = undefined
      }

      const entry = path.join(rootDir, 'server', 'index.mjs')
      child = spawn(process.execPath, [entry], {
        cwd: rootDir,
        env: { ...process.env },
        stdio: 'inherit',
      })

      child.on('error', (err) => {
        console.error('[gemini-api] failed to start:', err.message)
      })

      const stop = () => {
        if (child && !child.killed) {
          child.kill('SIGTERM')
          child = undefined
        }
      }

      viteServer.httpServer?.on('close', stop)
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)

      // Brief pause so Express binds before the first proxied /api request.
      return new Promise((resolve) => setTimeout(resolve, 500))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [geminiApiDevPlugin(), react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
