import fs from 'node:fs'

import { describe, expect, test } from 'vp/test'

import { userAgent, version } from './version.js'

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string }

describe('version', () => {
  test('matches the package version', () => {
    expect(version).toBe(packageJson.version)
    expect(userAgent).toBe(`mppx/${packageJson.version}`)
  })
})
