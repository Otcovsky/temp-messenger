// Генерирует PNG-иконки PWA в client/public без внешних зависимостей.
// Запуск: node client/scripts/make-icons.mjs
// Рисунок: белый пузырь чата с замочной скважиной на синем фоне.
import { writeFileSync, mkdirSync } from 'node:fs'
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

/** Что в точке (координаты 0..1): null — прозрачно, иначе цвет. */
function sample(x, y, rounded) {
  if (rounded && !inRoundedBox(x, y, 0.5, 0.5, 0.5, 0.5, 0.22)) return null
  const bubble =
    inRoundedBox(x, y, 0.5, 0.46, 0.27, 0.21, 0.09) || inTriangle(x, y, [0.32, 0.6], [0.29, 0.77], [0.48, 0.66])
  const keyhole = Math.hypot(x - 0.5, y - 0.42) <= 0.058 || inTriangle(x, y, [0.5, 0.4], [0.455, 0.56], [0.545, 0.56])
  return bubble && !keyhole ? FG : BG
}

function render(size, rounded) {
  const px = Buffer.alloc(size * size * 4)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const c = sample((i + (si + 0.5) / SS) / size, (j + (sj + 0.5) / SS) / size, rounded)
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
  ['icon-192.png', 192, true],
  ['icon-512.png', 512, true],
  ['icon-maskable-512.png', 512, false], // на всю площадь: обрезку делает система
  ['apple-touch-icon.png', 180, false], // iOS скругляет сама и не любит прозрачность
  ['favicon-32.png', 32, true],
]
for (const [name, size, rounded] of icons) {
  writeFileSync(new URL(name, OUT), render(size, rounded))
  console.log(name)
}
