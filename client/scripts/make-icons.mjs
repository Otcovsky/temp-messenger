// Генерирует PNG-иконки PWA в client/public и значки Android-приложения
// (client/android, если он есть) без внешних зависимостей.
// Запуск: node client/scripts/make-icons.mjs
// Рисунок: белый пузырь чата с замочной скважиной на синем фоне.
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync, crc32 } from 'node:zlib'

const OUT = new URL('../public/', import.meta.url)
const BG = [0x2f, 0x6f, 0xed]
const FG = [0xff, 0xff, 0xff]
const SS = 4 // сглаживание: SS×SS выборок на пиксель

function inRoundedBox(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r
  const qy = Math.abs(y - cy) - hh + r
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - r <= 0
}

function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const s = (a, b, c) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])
  const p = [x, y]
  const d1 = s(p, [ax, ay], [bx, by])
  const d2 = s(p, [bx, by], [cx, cy])
  const d3 = s(p, [cx, cy], [ax, ay])
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

/**
 * Что в точке (координаты 0..1): null — прозрачно, иначе цвет.
 * shape: 'square' — на всю площадь, 'rounded' — скруглённый квадрат, 'circle' — круг,
 * 'foreground' — передний слой адаптивного значка Android: только рисунок на прозрачном,
 * а система видит центральные 72 из 108 dp, поэтому рисунок ужат в эту область.
 */
function sample(x, y, shape) {
  if (shape === 'foreground') {
    x = 0.5 + (x - 0.5) * (108 / 72)
    y = 0.5 + (y - 0.5) * (108 / 72)
  }
  if (shape === 'rounded' && !inRoundedBox(x, y, 0.5, 0.5, 0.5, 0.5, 0.22)) return null
  if (shape === 'circle' && Math.hypot(x - 0.5, y - 0.5) > 0.5) return null
  const bubble =
    inRoundedBox(x, y, 0.5, 0.46, 0.27, 0.21, 0.09) || inTriangle(x, y, [0.32, 0.6], [0.29, 0.77], [0.48, 0.66])
  const keyhole = Math.hypot(x - 0.5, y - 0.42) <= 0.058 || inTriangle(x, y, [0.5, 0.4], [0.455, 0.56], [0.545, 0.56])
  if (shape === 'foreground') return bubble && !keyhole ? FG : null
  return bubble && !keyhole ? FG : BG
}

function render(size, shape) {
  const px = Buffer.alloc(size * size * 4)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const c = sample((i + (si + 0.5) / SS) / size, (j + (sj + 0.5) / SS) / size, shape)
          if (!c) continue
          r += c[0]; g += c[1]; b += c[2]; a++
        }
      }
      const o = (j * size + i) * 4
      if (a) {
        px[o] = Math.round(r / a)
        px[o + 1] = Math.round(g / a)
        px[o + 2] = Math.round(b / a)
      }
      px[o + 3] = Math.round((a / (SS * SS)) * 255)
    }
  }
  return png(size, px)
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // бит на канал
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT, { recursive: true })
const icons = [
  ['icon-192.png', 192, 'rounded'],
  ['icon-512.png', 512, 'rounded'],
  ['icon-maskable-512.png', 512, 'square'], // на всю площадь: обрезку делает система
  ['apple-touch-icon.png', 180, 'square'], // iOS скругляет сама и не любит прозрачность
  ['favicon-32.png', 32, 'rounded'],
]
for (const [name, size, shape] of icons) {
  writeFileSync(new URL(name, OUT), render(size, shape))
  console.log(name)
}

// Android: обычный значок 48 dp, круглый и передний слой адаптивного 108 dp — для каждой плотности.
// Фон адаптивного значка — цвет ic_launcher_background в res/values.
const RES = new URL('../android/app/src/main/res/', import.meta.url)
if (existsSync(RES)) {
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
  for (const [d, k] of Object.entries(densities)) {
    const dir = new URL(`mipmap-${d}/`, RES)
    mkdirSync(dir, { recursive: true })
    writeFileSync(new URL('ic_launcher.png', dir), render(48 * k, 'rounded'))
    writeFileSync(new URL('ic_launcher_round.png', dir), render(48 * k, 'circle'))
    writeFileSync(new URL('ic_launcher_foreground.png', dir), render(108 * k, 'foreground'))
  }
  // Значок на заставке при запуске
  mkdirSync(new URL('drawable-nodpi/', RES), { recursive: true })
  writeFileSync(new URL('drawable-nodpi/splash_icon.png', RES), render(384, 'rounded'))
  console.log('android: mipmap-* и drawable-nodpi/splash_icon.png')
}
