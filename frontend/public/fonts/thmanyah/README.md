# Thmanyah fonts

The Thmanyah licence forbids redistributing or hosting the font files, so they are **not in Git** (`.woff2` files here are ignored).

Install them on every machine that builds or serves the app (before `npm run build`, or in the served `dist/fonts/thmanyah/`):

```
thmanyahsans-Light.woff2
thmanyahsans-Regular.woff2
thmanyahsans-Medium.woff2
thmanyahsans-Bold.woff2
thmanyahsans-Black.woff2
thmanyahserifdisplay-Bold.woff2
thmanyahserifdisplay-Black.woff2
```

Without them the app still works and falls back to Inter or the system font. The faces are declared in `frontend/src/styles/fonts.css`.
