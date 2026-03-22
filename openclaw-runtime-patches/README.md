This directory stores file-level overlays for the locked `openclaw-runtime` package.

- Paths are relative to `openclaw-runtime/node_modules/`
- `apps/desktop/scripts/prepare-openclaw-sidecar.mjs` copies these files into the
  installed OpenClaw package before packaging the sidecar
- Keep patches minimal and version-specific
