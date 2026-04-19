# release-discord-watcher

[日本語版はこちら](README.ja.md)

A Cloudflare Worker that watches GitHub repositories for **releases** and **commits**, optionally summarizes them with **Workers AI**, and sends notifications to **Discord**.

## Features

- Watch multiple GitHub repositories from one Worker
- Configure each repository with a simple `owner/name` shorthand
- Switch monitoring mode per repository: `release`, `commit`, or `both`
- Translate and summarize release notes in Japanese with Workers AI
- Summarize commit batches in Japanese, with a fallback if AI fails
- Send notifications via Discord webhook or bot DM
- Store last seen release IDs and commit SHAs in Cloudflare KV

## How it works

The Worker runs on a cron schedule and checks each configured repository.

- **release**: watches the GitHub Releases API
- **commit**: watches the GitHub Commits API for a branch
- **both**: watches both releases and commits for the same repository

State is stored in the `STATE` KV namespace so only new updates are sent after initialization.

## Project structure

```text
src/index.ts        Worker entrypoint and main application logic
wrangler.jsonc      Cloudflare Worker config, bindings, and default vars
.dev.vars.example   Local environment variable example
package.json        Scripts for check, dev, and deploy
```

## Requirements

- Node.js
- npm
- Cloudflare account with Workers, KV, and Workers AI enabled
- Discord webhook URL or Discord bot credentials

## Configuration

The main settings are defined through Worker environment variables.

### Core settings

| Variable | Description |
| --- | --- |
| `WATCH_MODE` | Default monitoring mode for repositories that do not override it. `release`, `commit`, or `both` |
| `MONITORED_REPOSITORIES` | JSON array of repositories to watch |
| `MAX_RELEASES_PER_RUN` | Max number of releases fetched per run |
| `MAX_COMMITS_PER_RUN` | Max number of commits fetched per run |
| `INITIAL_SYNC_MODE` | `skip` or `notify` |
| `USE_WORKERS_AI` | Enables AI-based translation and summarization |
| `WORKERS_AI_MODEL` | Workers AI model name |
| `GITHUB_TOKEN` | Optional, recommended to avoid stricter rate limits |

### Discord delivery

| Variable | Description |
| --- | --- |
| `DISCORD_DELIVERY_MODE` | `webhook` or `bot-dm` |
| `DISCORD_WEBHOOK_URL` | Required for webhook delivery |
| `DISCORD_BOT_TOKEN` | Required for bot DM delivery |
| `DISCORD_DM_USER_ID` | Required for bot DM delivery |
| `DISCORD_USERNAME` | Optional sender display name |
| `DISCORD_AVATAR_URL` | Optional avatar URL |

## Repository configuration format

`MONITORED_REPOSITORIES` accepts a JSON array. Each item can be either:

1. A shorthand string:

```json
["github/copilot-cli", "openai/codex"]
```

2. A detailed object:

```json
[
  { "repo": "cloudflare/workers-sdk", "mode": "commit", "branch": "main" },
  { "repo": "oven-sh/bun", "mode": "both" }
]
```

### Rules

- `repo` must use the `owner/name` format
- `mode` can be `release`, `commit`, or `both`
- `branch` is only valid for `commit` or `both`
- If `mode` is omitted, the repository uses `WATCH_MODE`

## Example configuration

```env
DISCORD_DELIVERY_MODE=webhook
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook-id/your-webhook-token
GITHUB_TOKEN=
ADMIN_TOKEN=replace-with-a-random-token-before-using-run
AI_GATEWAY_ID=discord_update_check
WATCH_MODE=release
MONITORED_REPOSITORIES=["github/copilot-cli","openai/codex",{"repo":"cloudflare/workers-sdk","mode":"commit","branch":"main"}]
MAX_RELEASES_PER_RUN=3
MAX_COMMITS_PER_RUN=5
INITIAL_SYNC_MODE=skip
USE_WORKERS_AI=true
WORKERS_AI_MODEL=@cf/zai-org/glm-4.7-flash
```

## Local development

```bash
npm install
npm run check
npm run dev
```

Create a local `.dev.vars` file based on `.dev.vars.example`.

## Deploy

```bash
npm run deploy
```

## HTTP endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Returns the current configuration summary |
| `GET` | `/health` | Health check |
| `POST` | `/run` | Manual trigger, requires `Authorization: Bearer <ADMIN_TOKEN>` |

## Notes

- Release notifications require Workers AI
- Commit notifications can fall back to commit list summaries if AI fails
- The implementation is intentionally small and mostly centered in `src/index.ts`
- `.dev.vars` should never be committed
