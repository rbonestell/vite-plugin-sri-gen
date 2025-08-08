# Contributing to vite-plugin-sri-gen

Thanks for your interest in improving this project! This guide outlines a simple, GitHub-friendly workflow to help your contributions land smoothly.

## TL;DR

- Fork the repository from the `main` branch
- Create a topic branch off your fork’s `main` (use prefixes like `feat/` or `fix/` / `bug/`)
- Make changes with tests, keep coverage strong
- Run lint and tests locally
- Open a Pull Request from your fork/branch to this repository’s `main`

### 1. Fork and clone

1. Fork this repo on GitHub (ensure the default branch is `main`).
2. Clone your fork locally and set the upstream remote:

- origin → your fork
- upstream → <https://github.com/rbonestell/vite-plugin-sri-gen>

### 2. Create a feature/fix branch

Follow a git-flow-like convention. Prefixes are encouraged:

- Features: `feat/<short-summary>`
- Bug fixes: `fix/<short-summary>` or `bug/<short-summary>`

Start your work from the latest `main`.

### 3. Environment & install

- Requires Node.js 18+ (ESM-only project)
- Install dependencies using npm

Helpful scripts:

- Build: `npm run build`
- Lint: `npm run lint` (or `npm run lint:fix`)
- Test (watch/interactive): `npm test`
- Test with coverage report: `npm run test:cov` (outputs HTML and lcov under `coverage/`)

### 4. Tests are required

- Write or update tests for every code change you make
- Strive for optimal coverage. Aim not to reduce overall coverage and add tests for new branches, edge cases, and failure modes
- The test runner is Vitest. Coverage is generated via V8; HTML reports live at `coverage/lcov-report/index.html`

### 5. Code style

- TypeScript-first, ESM-only
- Linting is enforced via ESLint
  - Tabs for indentation, semicolons required
  - Common TypeScript rules (e.g., consistent type imports, no unused vars)
- Please run `npm run lint` and address issues (or `npm run lint:fix` where safe)

### 6. Commit messages

Use clear, descriptive commit messages. Multiple small, focused commits are fine. Squash on merge may be used. Conventional Commits are welcome but not required.

### 7. Open a Pull Request

- Push your branch to your fork
- Open a PR from `your-fork:your-branch` → `rbonestell/vite-plugin-sri-gen:main`
- Fill out the description with:
  - What changed and why
  - Any related issues or links
  - Notes on tests and potential impacts

PR checklist (please verify before submitting):

- [ ] Branch created from `main` and targets `main`
- [ ] Tests added/updated for all changes
- [ ] `npm test` passes locally
- [ ] Coverage is strong (no meaningful regressions); `npm run test:cov` reviewed
- [ ] `npm run lint` passes (or is fixed)
- [ ] `npm run build` completes successfully
- [ ] Docs and types updated where relevant

### 8. Reviews & merges

A maintainer will review your PR and may request changes. Once approved and checks pass, it will be merged.

## Questions or issues?

- File a GitHub Issue for bugs or feature discussions
- For security-sensitive concerns, please consider responsible disclosure via a private channel if applicable

## License

By contributing, you agree that your contributions will be licensed under the MIT License of this repository.
