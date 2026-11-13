/** Аватар-кружок: первая буква имени на градиенте, цвет выводится из имени. */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  const sizes = {
    sm: 'size-10 text-base',
    md: 'size-13 text-lg',
    lg: 'size-14 text-xl',
    xl: 'size-20 text-3xl',
  }
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full font-semibold text-white shadow-sm ${sizes[size]}`}
      style={{ backgroundImage: `linear-gradient(135deg, hsl(${h} 80% 66%), hsl(${(h + 45) % 360} 72% 52%))` }}
      aria-hidden
    >
      {[...name.trim()][0]?.toUpperCase() ?? '?'}
    </span>
  )
}
