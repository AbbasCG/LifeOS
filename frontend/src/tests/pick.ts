import { fireEvent, screen } from '@testing-library/react'

/** Set a value through the app's own date/time picker: open the field, type into the picker's Date or Time box, and press Done. */
export function pick(label: string | RegExp, value: string) {
  fireEvent.click(screen.getByLabelText(label))
  const [date, time] = value.includes('T') ? value.split('T') : /^\d{4}-/.test(value) ? [value, ''] : ['', value]
  for (const [name, text] of [['Date', date], ['Time', time]] as const) {
    if (!text) continue
    const box = screen.getByRole('textbox', { name })
    fireEvent.change(box, { target: { value: text } })
    fireEvent.keyDown(box, { key: 'Enter' })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
}
