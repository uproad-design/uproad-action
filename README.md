# Uproad Push (GitHub Action)

Uploads HTML prototypes to [Uproad](https://uproad.design) on every push and comments the share link on the pull request — "PR previews your client can actually open." No account required to view; works for whatever generated the HTML (Claude, v0, Lovable, bolt, or your own build).

## Usage

```yaml
name: Preview

on:
  pull_request:

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run build   # produces dist/index.html, or whatever your build does
      - uses: uproad-design/uproad-action@main
        with:
          files: dist/index.html
          token: ${{ secrets.UPROAD_TOKEN }}
```

Create `UPROAD_TOKEN` as a repository secret from your Uproad workspace under **Members → API Tokens**.

Every push updates the *same* design (keyed by file path by default) instead of creating a new one each time, so the link in the PR comment never changes — reviewers can just keep the tab open across pushes.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `files` | yes | — | Glob of HTML files to upload (e.g. `dist/**/*.html`) |
| `token` | yes | — | Uproad API token |
| `api` | no | `https://uproad.design` | Uproad app URL |
| `docs` | no | — | Glob of documents to attach to every design pushed in this run (e.g. `docs/**/*.md`) |
| `docs-sync` | no | `false` | Also delete attached documents missing from the `docs` glob |
| `comment` | no | `true` | Post/update a sticky PR comment with the share link(s) |
| `github-token` | no | `${{ github.token }}` | Token used to post the PR comment |

### Attaching documents

`docs` attaches specs alongside the prototype, so a reviewer or an agent can open the preview and the API design it is meant to satisfy from the same place:

```yaml
      - uses: uproad-design/uproad-action@main
        with:
          files: dist/**/*.html
          docs: docs/**/*.md
          docs-sync: true
          token: ${{ secrets.UPROAD_TOKEN }}
```

Paths are stored relative to the repository root, and pushing the same path overwrites it — no versions are kept. `docs-sync: true` additionally removes documents that no longer exist in the repo; it is off by default so a wrong glob cannot wipe everything. Document failures are reported as warnings and never fail the job on their own.

## Outputs

| Output | Description |
| --- | --- |
| `urls` | Newline-separated share URLs for the uploaded designs |
| `results` | Raw JSON array: `{file, designId, versionNo, url}` per file, or `{file, error}` on failure |

## How it works

This action has no npm dependencies of its own. It runs the published [`uproad`](https://www.npmjs.com/package/uproad) CLI through `npx --yes uproad@^1`, and posts the PR comment with a plain `fetch` call to the GitHub REST API. On repeat pushes to the same PR, it edits its own previous comment instead of piling up new ones.

Pinning the CLI to a major range means bug fixes reach you without a new action release, while a breaking CLI change cannot.

**Requirements:** the runner needs `npx` on its PATH. Every GitHub-hosted runner does; a self-hosted runner needs Node installed (`actions/setup-node` before this step is enough).

An earlier version shelled out to a CLI checked into the same repository. That fails the moment anyone else uses the action: GitHub checks out the repository as committed, `node_modules` is gitignored, and the CLI's `glob` import dies before a single file uploads. Set `UPROAD_CLI` to a local CLI entry point if you need to bypass npx (used by this repo's own tests).
