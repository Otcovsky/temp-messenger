import { registerPlugin } from '@capacitor/core'

/**
 * То, что в Android-приложении делается иначе, чем в браузере. Плагины Capacitor грузятся
 * только по требованию, чтобы не утяжелять сайт.
 */

/** Обычный base64 (не url-вариант), кусками — строка на 25 МиБ через один btoa не пройдёт */
function toBase64(data: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < data.length; i += CHUNK) {
    s += String.fromCharCode(...data.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

/**
 * Имя файла пришло от собеседника: оставляем только безопасные символы,
 * без каталогов и «..», чтобы запись не ушла за пределы своей папки.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return clean || 'file'
}

/**
 * Сохранить файл: WebView не умеет скачивать blob-ссылки, поэтому файл кладётся во временную
 * папку приложения и открывается системное меню «Поделиться» — оттуда его сохраняют в «Файлы»,
 * на Диск или открывают в нужной программе.
 */
export async function saveFileNative(name: string, data: Uint8Array): Promise<void> {
  const { Directory, Filesystem } = await import('@capacitor/filesystem')
  const { Share } = await import('@capacitor/share')
  const path = `shared/${safeFileName(name)}`
  // Прошлые файлы больше не нужны: меню «Поделиться» уже отдало их другой программе
  await Filesystem.rmdir({ path: 'shared', directory: Directory.Cache, recursive: true }).catch(() => {})
  const { uri } = await Filesystem.writeFile({
    path,
    data: toBase64(data),
    directory: Directory.Cache,
    recursive: true,
  })
  try {
    await Share.share({ title: name, files: [uri] })
  } catch {
    /* человек закрыл меню */
  }
}

/** Поделиться ссылкой через системное меню Android */
export async function shareLinkNative(title: string, url: string): Promise<void> {
  const { Share } = await import('@capacitor/share')
  try {
    await Share.share({ title, url })
  } catch {
    /* человек закрыл меню */
  }
}

// --- уведомления (свой плагин TmPush, android/app/src/main/java/.../push) ---

export type NativePermission = 'granted' | 'denied' | 'prompt'

interface TmPushPlugin {
  /** available — в сборке есть Firebase (google-services.json) */
  status(): Promise<{ available: boolean; permission: NativePermission }>
  requestPermission(): Promise<{ available: boolean; permission: NativePermission }>
  /** Токен FCM и ключ, которым сервер шифрует пометку в пуше */
  register(): Promise<{ token: string; key: string }>
  unregister(): Promise<void>
  /** Уведомление от самого приложения; пока оно на экране, ничего не показывается (кроме stop) */
  show(o: { kind: 'msg' | 'call' | 'stop' | 'missed' }): Promise<void>
  /** Следующие 20 с пуш покажется и при открытом приложении — для кнопки «Проверить» */
  expectTest(): Promise<void>
  /** Язык уведомлений, которые приложение показывает само (ru, en…) */
  setLanguage(o: { lang: string }): Promise<void>
}

/**
 * Плагин нельзя отдавать через Promise: прокси Capacitor отвечает на любое свойство,
 * в том числе на then, и await принял бы его за обещание. Поэтому — обычный объект модуля.
 */
export const TmPush = registerPlugin<TmPushPlugin>('TmPush')
