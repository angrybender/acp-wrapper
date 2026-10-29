# Agent guide

An ACP-compatible coding agent powered by the Claude Agent SDK. Source in `src/`,
TypeScript, ESM, Node >= 22.

## Commands

```sh
npm run build         # tsc
npm run test:run      # vitest, single pass
npm run check         # eslint + prettier --check
npm run lint:fix      # eslint --fix
npm run format        # prettier --write
```

CI runs `format:check`, `lint`, `build` and `test:run`. Run `npm run check` before
opening a PR.

## Code comments

Keep comments straightforward, concise, and concrete. Say what the code does and
why, in plain terms: name the actual state, call, or failure involved instead of
alluding to it. Prefer a short concrete example over an abstract description.
Don't use vague phrases like "keeps it honest" or "the residual case" that make
the reader reconstruct the meaning.

## Pull requests

Squash merges use the PR title as the commit subject, and release-please parses it
to compute the next version. Titles must be conventional commits using one of:
`feat`, `fix`, `perf`, `revert`, `docs`, `style`, `chore`, `refactor`, `test`,
`build`, `ci`. `conventional-prs.yml` rejects anything else.

The title also decides the release: `feat:` bumps the minor, `fix:`/`perf:` the
patch, and `chore:`/`ci:`/`test:` and friends do not release at all.

## Fork maintenance

This repository contains the complete upstream 0.96.0 source snapshot with
`background-drain.patch` already applied. `UPSTREAM.json` records its origin.
Do not apply the patch again to this checkout. The upstream README is retained
as `README.upstream.md`.

`python3 install.py --test` builds this checkout in an isolated staging directory;
it does not fetch another upstream checkout. Keep the patch and its SHA256 in
`UPSTREAM.json` synchronized when updating the source changes.

Upstream workflow definitions are preserved under `docs/upstream-workflows/`
for reference. They are not active in this fork. The package is private; this
repository does not automatically publish upstream npm releases. The original
release guide in `docs/RELEASES.md` describes upstream infrastructure.
