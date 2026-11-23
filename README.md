# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ayukwulan/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ayukwulan/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads all four to one written specification:

- a unified diff, often with wrong line numbers,
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

Each format is read as `SPEC.md` says, and every file is changed or nothing is.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The working directory is the root of the tree. Every path in a patch is relative to
it. `PATCH` is the path of the patch file, relative to the working directory; when
it is absent or is `-`, the patch is read from standard input.

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without
  it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Matching

An edit names old lines that are replaced by new lines. The old lines are found in
the file at the first of three tiers at which they occur at least once:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed from both;
- tier 2: every line equal once leading and trailing spaces and tabs are removed
  from both.

With `--strict` only tier 0 is tried. A context line is written as the file's own
matched line, never the patch's. At tier 2 every other new line is re-indented to
the file's indentation.

## Output and exit codes

- Exit 2, one line, nothing written: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.
- Exit 1, nothing written: one line `error: <code> <path>` for each edit that
  failed, in the patch's order, then `failed: <k> of <n> edits`.
- Exit 0: one line for each path whose state changed (`A`, `D`, `M`, or
  `R <old> -> <new>` for a move), in byte order of the paths, then
  `ok: <n> files`.

## Requirements

Node 22 and its standard library only. Deterministic: no clock, no network, no
randomness.

## License

MIT. See `LICENSE`.
