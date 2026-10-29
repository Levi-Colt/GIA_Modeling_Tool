import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Field, { Placeholder, statusBorder, valueStatus } from './Field.jsx'

describe('valueStatus', () => {
  it('empty: blue when required, plain when optional', () => {
    expect(valueStatus('', { required: true })).toBe('required')
    expect(valueStatus('  ', { required: true })).toBe('required')
    expect(valueStatus('')).toBe('default')
  })

  it('filled: green when it parses, red when not', () => {
    expect(valueStatus('12', { required: true })).toBe('valid')
    expect(valueStatus('abc', { required: true, ok: false })).toBe('invalid')
    expect(valueStatus('abc', { ok: false })).toBe('invalid')
  })
})

describe('statusBorder', () => {
  it('maps the four states to distinct colors; required is blue, never red', () => {
    expect(statusBorder('default')).toBe('border-gray-300')
    expect(statusBorder('required')).toBe('border-blue-400')
    expect(statusBorder('valid')).toBe('border-green-500')
    expect(statusBorder('invalid')).toBe('border-red-400')
    expect(statusBorder()).toBe('border-gray-300')
  })
})

describe('Field', () => {
  it('wraps the control in its label so getByLabelText finds it', () => {
    render(
      <Field label="Thing (m)">
        <input />
      </Field>
    )
    expect(screen.getByLabelText('Thing (m)')).toBeInTheDocument()
  })

  it('with htmlFor the label is a sibling, for rows holding several controls', () => {
    render(
      <Field label="Row" htmlFor="x">
        <input id="x" />
        <button type="button">Go</button>
      </Field>
    )
    expect(screen.getByLabelText('Row')).toHaveAttribute('id', 'x')
  })

  it('shows the message as a status, with a spinner only while checking', () => {
    const { container, rerender } = render(
      <Field label="A" status="checking" message="Looking up...">
        <input />
      </Field>
    )
    expect(screen.getByRole('status')).toHaveTextContent('Looking up...')
    expect(container.querySelector('.animate-spin')).not.toBeNull()
    rerender(
      <Field label="A" status="valid" message="Located.">
        <input />
      </Field>
    )
    expect(container.querySelector('.animate-spin')).toBeNull()
  })
})

describe('Placeholder', () => {
  it('is never dashed (a dashed box is the drop zone)', () => {
    render(<Placeholder>Nothing yet</Placeholder>)
    expect(screen.getByText('Nothing yet').className).not.toMatch(/dashed/)
  })
})
