import { describe, it, expect } from 'vitest'
import { classifyErrorStep } from './steps.js'

describe('classifyErrorStep', () => {
  it('routes the elevation-range error to the Origin section, whatever numbers it contains', () => {
    for (const target of ['1500', '3000', '12']) {
      const msg = `Target elevation ${target} is outside the DEM's valid elevation range [0, 2999].`
      expect(classifyErrorStep(msg)).toBe('coordinates')
    }
  })

  it('routes origin/extent errors to coordinates and file errors to upload', () => {
    expect(classifyErrorStep('Origin is outside the DEM extent')).toBe('coordinates')
    expect(classifyErrorStep('The file is corrupted')).toBe('upload')
  })

  it('returns null for anything else', () => {
    expect(classifyErrorStep('Processing failed: boom')).toBeNull()
    expect(classifyErrorStep(undefined)).toBeNull()
  })
})
