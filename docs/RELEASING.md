# Releasing

## Releasing a version

1. Run the local checks:

   ```bash
   npm run check
   npm test
   npm run build
   ```

2. Set the version in `manifest.json` and `package.json` with `npm run bump -- <version>`, commit, and push to `main`.

The **Release** workflow notices that the version changed. It checks that both version fields match the tag, runs checks and tests, builds `VictorLoad-vX.Y.Z.zip` and `SHA256SUMS.txt`, then creates the tag and the GitHub release, with notes generated from the commit history.

Pushes to `main` without a version change, and pull requests, only run checks and tests. No package is built.

## Tags and manual builds

- You can push a version tag yourself instead of relying on version detection. The tag must match `manifest.json` and `package.json`.
- To rebuild a published version, open **Actions → Release → Run workflow** and enter its existing tag. This replaces the ZIP and checksum files on that release.

## Package contents

Only `manifest.json`, `_locales/`, `icons/`, `rules/`, `src/` and `vendor/` are included (see `scripts/build.mjs`). Tests, `dev/` pages, scripts, docs and CI files are excluded. The ZIP is reproducible: the same sources produce the same bytes.

`npm run check` verifies that files referenced by the manifest are included in the package.

## Local builds

`npm run build` writes the ZIP to `dist/`, which is ignored by Git. Unzip it and use **Load unpacked** in `chrome://extensions` to try the packaged extension.

## Icons

Edit the design in `scripts/make-icons.mjs` and run `npm run icons` to regenerate the icons.
