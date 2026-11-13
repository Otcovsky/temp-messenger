import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { type Plugin, type ResolvedConfig, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Собирает dist/sw.js из шаблона sw.js: список всех файлов сборки (кроме карт исходников)
 * и версию — хеш их содержимого. В режиме разработки service worker не используется.
 */
function serviceWorker(): Plugin {
  let config: ResolvedConfig
  return {
    name: 'temp-messenger-sw',
    apply: 'build',
    configResolved(c) {
      config = c
    },
    closeBundle() {
      const outDir = join(config.root, config.build.outDir)
      const files: string[] = []
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          if (e.isDirectory()) walk(p)
          else if (!e.name.endsWith('.map') && e.name !== 'sw.js') files.push(p)
        }
      }
      walk(outDir)
      files.sort()
      const hash = createHash('sha256')
      const urls = files.map((p) => {
        const url = '/' + relative(outDir, p).split('\\').join('/')
        hash.update(url).update(readFileSync(p))
        return url
      })
      const version = hash.digest('hex').slice(0, 16)
      const sw = readFileSync(join(config.root, 'sw.js'), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(urls))
      writeFileSync(join(outDir, 'sw.js'), sw)
      config.logger.info(`sw.js: версия ${version}, файлов в кеше: ${urls.length}`)
    },
  }
}

// В разработке WebSocket и файлы проксируются на локальный Python-сервер.
export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8100', ws: true },
      '/blob': { target: 'http://127.0.0.1:8100' },
    },
  },
  build: { target: 'es2022', sourcemap: true },
})
