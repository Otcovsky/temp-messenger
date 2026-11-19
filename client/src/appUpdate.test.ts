import { describe, expect, it } from 'vitest'
import { APP_VERSION, decide, parseLatest } from './appUpdate'

const v = (versionCode: number, minVersionCode = 1) => ({ versionCode, versionName: `0.${versionCode}.0`, minVersionCode })

describe('parseLatest', () => {
  it('принимает объект и строку JSON', () => {
    expect(parseLatest({ versionCode: 5, versionName: '0.4.0', minVersionCode: 2 })).toEqual({
      versionCode: 5,
      versionName: '0.4.0',
      minVersionCode: 2,
    })
    expect(parseLatest('{"versionCode":5,"versionName":"0.4.0","minVersionCode":1}')).toEqual({
      versionCode: 5,
      versionName: '0.4.0',
      minVersionCode: 1,
    })
  })

  it('без minVersionCode обновление не обязательное', () => {
    expect(parseLatest({ versionCode: 5, versionName: '0.4.0' })?.minVersionCode).toBe(1)
  })

  it('мусор и подозрительное имя — null', () => {
    for (const bad of [null, 'не json', 42, {}, { versionCode: '5', versionName: '1' }, { versionCode: 0, versionName: '1' }, { versionCode: 1.5, versionName: '1' }, { versionCode: 5, versionName: '<img src=x>' }, { versionCode: 5, versionName: 'x'.repeat(33) }]) {
      expect(parseLatest(bad)).toBeNull()
    }
  })
})

describe('decide', () => {
  it('молчит, если на сайте не новее', () => {
    expect(decide(4, null, 0)).toBeNull()
    expect(decide(4, v(4), 0)).toBeNull()
    expect(decide(4, v(3), 0)).toBeNull()
  })

  it('предлагает новую версию', () => {
    expect(decide(4, v(5), 0)).toEqual({ name: '0.5.0', required: false })
  })

  it('«Позже» скрывает эту версию, но не следующую', () => {
    expect(decide(4, v(5), 5)).toBeNull()
    expect(decide(4, v(6), 5)).toEqual({ name: '0.6.0', required: false })
  })

  it('обязательное обновление не скрывается', () => {
    expect(decide(4, v(6, 5), 6)).toEqual({ name: '0.6.0', required: true })
    expect(decide(5, v(6, 5), 6)).toBeNull()
  })
})

it('версия сборки взята из build.gradle', () => {
  expect(Number.isInteger(APP_VERSION.code)).toBe(true)
  expect(APP_VERSION.name).toMatch(/^\d+\.\d+\.\d+$/)
})
