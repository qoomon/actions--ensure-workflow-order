# actions--ensure-workflow-order

A GitHub Action that **ensures workflow execution order** by waiting for all preceding runs of a workflow (or a specific job within those runs) to complete before the current run continues.

This is useful when you need to guarantee FIFO ordering of deployments or other operations that must not run concurrently with an earlier-triggered run.

---

## How it works

1. The action determines the **run number** of the current workflow run.
2. It queries the GitHub API for all **active** (queued / in-progress / waiting) runs of the **current workflow** with a lower run number on the same branch.
3. It **polls** until all preceding runs (or the specified job within them) have finished.
4. If the configurable **timeout** is exceeded the action fails.

---

## Usage

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Ensure deploy order
        uses: qoomon/actions--ensure-workflow-order@v1
        with:
          # All inputs are optional – defaults shown below
          job: ''                 # job name to wait for (default: entire run)
          run-on-branch: ''       # branch filter (default: current branch)
          poll-interval: '10'     # seconds between polls
          timeout: '600'          # max seconds to wait before failing
          token: ${{ github.token }}
```

### Wait for a specific job in preceding runs

```yaml
- uses: qoomon/actions--ensure-workflow-order@v1
  with:
    job: deploy   # wait until 'deploy' job is done in all preceding runs
```

---

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `job` | No | *(entire run)* | Name of the job to wait for inside each preceding run. When omitted the action waits for the entire run to complete. |
| `run-on-branch` | No | current branch | Only consider runs on this branch. |
| `poll-interval` | No | `10` | Seconds between GitHub API polls. |
| `timeout` | No | `600` | Maximum seconds to wait before the action fails with a timeout error. |
| `token` | No | `${{ github.token }}` | GitHub token used to call the API. Needs `actions: read` permission. |

---

## Permissions

The workflow (or the token provided) needs the following permission:

```yaml
permissions:
  actions: read
```

---

## Development

```bash
npm install          # install dependencies
npm run typecheck    # run TypeScript type-checking
npm run build        # bundle src/main.ts → dist/index.js
```
