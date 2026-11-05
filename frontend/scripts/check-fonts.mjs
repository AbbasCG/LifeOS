import { FONT_FILES, fontReport } from './thmanyahFonts.mjs'

const report = fontReport('public/fonts', FONT_FILES)
if (!report.folder) {
  console.log('No Thmanyah folder found in public/fonts/ (a folder named "thmanyah", in any capitalisation, is expected).')
  console.log('The app still works and falls back to Inter / the system font. See public/fonts/thmanyah/README.md.')
} else {
  console.log(`Thmanyah folder: ${report.folder}`)
  for (const f of report.found) console.log(`  ok       ${f}`)
  for (const f of report.missing) console.log(`  missing  ${f}`)
  if (report.missing.length) console.log('Missing files fall back to the next font. Names are matched without regard to upper/lower case.')
}
