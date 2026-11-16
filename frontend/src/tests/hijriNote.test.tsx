import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HijriNote } from '../components/HijriNote'

const info = { day: 10, month: 12, year: 1447, label: 'Dhuʻl-Hijjah 10, 1447', special: 'Eid al-Adha' }

describe('HijriNote', () => {
  it('shows nothing without a Hijri date (browser without the calendar, or Hijri off)', () => {
    const { container } = render(<HijriNote info={null} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('shows the date and names an Islamic day in words, not by colour alone', () => {
    render(<HijriNote info={info} />)
    expect(screen.getByText('Dhuʻl-Hijjah 10, 1447')).toBeInTheDocument()
    expect(screen.getByText('Eid al-Adha')).toBeInTheDocument()
  })
  it('in a small cell shows the number to the eye and the whole date to a screen reader', () => {
    const { container } = render(<HijriNote info={{ ...info, special: null }} compact />)
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent('10')
    expect(container.querySelector('.sr-only')).toHaveTextContent('Dhuʻl-Hijjah 10, 1447')
  })
})
