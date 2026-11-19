import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { type Plugin, type ResolvedConfig, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { DICTS } from './src/i18n/dicts'

/** Тексты уведомлений для sw.js — из тех же словарей, что и приложение */
function notificationTexts(): string {
  const keys = { message: 'notify.message', call: 'notify.call', callBody: 'notify.callBody', missed: 'notify.missed' } as const
  const out: Record<string, Record<string, unknown>> = {}
  for (const [lang, dict] of Object.entries(DICTS)) {
    out[lang] = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, dict[key]]))
  }
  return JSON.stringify(out)
}

/**
 * Собирает dist/sw.js из шаблона sw.js: список всех файлов сборки (кроме карт исходников),
 * версию — хеш их содержимого — и тексты уведомлений. В режиме разработки service worker не используется.
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
        .replace('__TEXTS__', notificationTexts())
      writeFileSync(join(outDir, 'sw.js'), sw)
      config.logger.info(`sw.js: версия ${version}, файлов в кеше: ${urls.length}`)
    },
  }
}

/**
 * Версия Android-приложения из android/app/build.gradle: по ней APK сверяется
 * с download/version.json на сайте (src/appUpdate.ts).
 */
function apkVersion(): { code: number; name: string } {
  const gradle = readFileSync(new URL('./android/app/build.gradle', import.meta.url), 'utf8')
  const code = Number(/^\s*versionCode\s+(\d+)/m.exec(gradle)?.[1])
  const name = /^\s*versionName\s+"([^"]+)"/m.exec(gradle)?.[1]
  if (!Number.isInteger(code) || !name) throw new Error('В android/app/build.gradle не найдены versionCode/versionName')
  return { code, name }
}

// В разработке WebSocket и файлы проксируются на локальный Python-сервер.
export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  define: { __APK_VERSION__: JSON.stringify(apkVersion()) },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8100', ws: true },
      '/blob': { target: 'http://127.0.0.1:8100' },
    },
  },
  build: { target: 'es2022', sourcemap: true },
})
