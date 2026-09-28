import { describe, expect, it } from 'vitest'
import { UPDATE_SERVER_NAME } from '../src/index.ts'

describe('update-server workspace skeleton', () => {
  it('exposes the workspace identity', () => {
    expect(UPDATE_SERVER_NAME).toBe('update-server')
  })
})
