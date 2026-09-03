import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// vitest.config's `test.globals` isn't enabled, so RTL's automatic
// Jest-global-detected cleanup doesn't kick in on its own -- without this,
// each test's rendered DOM stays mounted into the next test.
afterEach(() => {
  cleanup()
})
