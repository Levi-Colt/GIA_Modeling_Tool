import { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import CollapsibleSection from './CollapsibleSection.jsx'

function Toggleable({ status, keepMounted, initialOpen = false }) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <CollapsibleSection
      sectionId="step-demo"
      title="Demo"
      status={status}
      open={open}
      onToggle={() => setOpen(!open)}
      keepMounted={keepMounted}
    >
      <input placeholder="inside" />
    </CollapsibleSection>
  )
}

describe('CollapsibleSection', () => {
  it('toggles aria-expanded and mounts/unmounts the body', async () => {
    render(<Toggleable />)
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: /demo/i })

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByPlaceholderText('inside')).not.toBeInTheDocument()

    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByPlaceholderText('inside')).toBeInTheDocument()
    // aria-controls points at the real body element
    expect(document.getElementById(button.getAttribute('aria-controls'))).toContainElement(
      screen.getByPlaceholderText('inside')
    )

    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByPlaceholderText('inside')).not.toBeInTheDocument()
  })

  it('keepMounted keeps the body in the DOM, hidden, while collapsed', async () => {
    render(<Toggleable keepMounted initialOpen />)
    const user = userEvent.setup()
    const input = screen.getByPlaceholderText('inside')
    expect(input).toBeVisible()

    await user.click(screen.getByRole('button', { name: /demo/i }))
    expect(screen.getByPlaceholderText('inside')).toBe(input) // same node, not remounted
    expect(input).not.toBeVisible()
  })

  it('renders the complete status line with a check mark and summary', () => {
    render(<Toggleable status={{ complete: true, summary: 'dem.tif' }} />)
    expect(screen.getByText('dem.tif')).toBeInTheDocument()
    expect(screen.getByText('✓', { exact: false })).toBeInTheDocument()
    expect(screen.queryByText(/Needs:/)).not.toBeInTheDocument()
  })

  it('renders the incomplete status line as "Needs: ..."', () => {
    render(<Toggleable status={{ complete: false, summary: 'ignored', needs: ['tilt azimuth', 'tilt factor'] }} />)
    expect(screen.getByText('Needs: tilt azimuth, tilt factor')).toBeInTheDocument()
    expect(screen.queryByText('ignored')).not.toBeInTheDocument()
  })
})
