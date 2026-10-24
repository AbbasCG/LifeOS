# Thmanyah fonts (not included in this repository)

LifeOS uses **Thmanyah Sans** (primary Arabic UI font) and **Thmanyah Serif Display** (large Arabic headings).
The Thmanyah Font License does not allow the font files to be uploaded, hosted or redistributed, so they are
**not committed**. Without them the app works normally and falls back to Inter / system fonts.

## Install locally

1. Download the fonts from the official site: https://font.thmanyah.com (license: ask@thmanyah.com).
2. Copy these exact files into this folder (`frontend/public/fonts/thmanyah/`):

   | File | Family | Weight |
   |---|---|---|
   | `thmanyahsans-Light.woff2` | Thmanyah Sans | 300 |
   | `thmanyahsans-Regular.woff2` | Thmanyah Sans | 400 |
   | `thmanyahsans-Medium.woff2` | Thmanyah Sans | 500 |
   | `thmanyahsans-Bold.woff2` | Thmanyah Sans | 700 |
   | `thmanyahsans-Black.woff2` | Thmanyah Sans | 900 |
   | `thmanyahserifdisplay-Bold.woff2` | Thmanyah Serif Display | 700 |
   | `thmanyahserifdisplay-Black.woff2` | Thmanyah Serif Display | 900 |

3. Restart `npm run dev` or rebuild (`npm run build`). The files are git-ignored.

The `@font-face` rules live in `frontend/src/styles/fonts.css`.

**Before deploying publicly:** the license prohibits making the font files available in a way that lets end users
download or extract them "including through web embedding", while permitting embedding "as part of a compiled,
packaged, or obfuscated product". Serving WOFF2 files from a public website may fall under the prohibition —
get written confirmation from Thmanyah (ask@thmanyah.com) before a public deployment.
