# UI screenshots

These images are a visual snapshot of the UI rendered from deterministic Storybook fixtures. They cover the public status page (operational, active incident, and empty states), login, active and resolved incident details, escalation timeline, postmortem editor, audit log, decision guide, and the open command palette.

## Refreshing

From the repository root, install web dependencies if needed and run:

```sh
npm --prefix web ci
npm --prefix web run build-storybook
npm --prefix web run shoot
cp web/screenshots/*.png screenshots/
```

The capture script uses Chrome headless; set `CHROME_SHELL` to a Chrome/Chromium executable path if it is not installed at a standard location. Update the Storybook stories and the story list in `web/scripts/shoot-stories.mjs` when adding UI states. The committed screenshots are copied from the same script output so they reflect those fixtures.
