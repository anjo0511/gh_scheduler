# GitHub Actions Scheduler

A small local web UI for externally scheduling GitHub Actions workflows from schedule blocks committed in the workflow YAML files.

## Setup

1. Create a GitHub token with access to the target repository and workflow dispatch permissions.
2. Copy `.env.example` to `.env`.
3. Fill in:

```sh
GITHUB_TOKEN=github_pat_your_token_here
GITHUB_REPOS=your-org/first-repo,your-org/second-repo
PORT=4173
HOST=127.0.0.1
MOCK_DATA=false
```

4. Start the app:

```sh
npm start
```

Open `http://localhost:4173`.

## Mock Data

If GitHub configuration is missing, the app automatically uses mock workflows and mock schedules so the UI can be tested immediately.

You can also force mock mode:

```sh
MOCK_DATA=true npm start
```

Mock mode includes sample workflows, external schedule comments, and fake successful dispatches.

## Repositories

Configure one or more repositories with `GITHUB_REPOS` as a comma-separated list of `owner/repo` values. The UI shows a repository selector, then loads externally defined schedules, active runs, and latest-run links for the selected repository only.

The older `GITHUB_OWNER` and `GITHUB_REPO` variables are still accepted for a single repository.

## What It Does

- Reads workflow files and extracts `# @external-schedule:` comment blocks.
- Dispatches due workflows with `workflow_dispatch`.
- Tracks the dispatched workflow run and blocks duplicate runs while it is queued or in progress.
- Stores runtime state such as last run and last error in `data/schedules.json`.
- Checks due schedules every 30 seconds while the server is running.

## Workflow Schedule Blocks

Add a commented schedule block to a workflow file:

```yaml
# @external-schedule:
#   enabled: true
#   timezone: "Europe/Stockholm"
#   schedule:
#     - cron: "0 12 * * *"
#     - cron: "0 18 * * 1-5"
```

Optional fields:

```yaml
#   ref: "main"
#   inputs:
#     environment: "staging"
#   schedule:
#     - cron: "0 9 * * 1-5"
#       inputs:
#         message: "Scheduled run"
```

## Cron Syntax

Schedules use five fields:

```txt
minute hour day-of-month month day-of-week
```

Examples:

```txt
0 9 * * 1-5    Every weekday at 09:00
*/15 * * * *    Every 15 minutes
30 22 * * 0     Every Sunday at 22:30
```

Supported field patterns are `*`, exact values, comma lists, ranges, and steps such as `*/10` or `1-5`.

## Notes

The GitHub token stays on the Node server and is never sent to the browser. For a workflow to be triggered, the workflow file must support the `workflow_dispatch` event.
