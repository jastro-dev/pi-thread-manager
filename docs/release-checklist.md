# Release checklist

1. Run `pnpm install --frozen-lockfile`.
2. Run `pnpm exec tsc --noEmit`.
3. Run `pnpm node --import tsx --test tests/*.test.ts`.
4. Search for local paths, private repo names, tokens, and secret-like content.
5. Update `CHANGELOG.md`.
6. Tag the release after CI passes.
