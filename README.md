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

| Variable | Description | Default |
| --- | --- | --- |
| `WATCH_MODE` | Default monitoring mode for repositories that do not override it. `release`, `commit`, or `both` | `release` |
| `MONITORED_REPOSITORIES` | JSON array of repositories to watch (required) | — |
| `MAX_RELEASES_PER_RUN` | Max number of releases fetched per run | `3` |
| `MAX_COMMITS_PER_RUN` | Max number of commits fetched per run | `5` |
| `INITIAL_SYNC_MODE` | `skip` or `notify` | `skip` |
| `USE_WORKERS_AI` | Enables AI-based translation and summarization | `true` |
| `WORKERS_AI_MODEL` | Workers AI model name | `@cf/meta/llama-3-8b-instruct` |
| `GITHUB_TOKEN` | Optional, recommended to avoid stricter rate limits | — |
| `ADMIN_TOKEN` | Bearer token required to authorize `POST /run` | — |

When `USE_WORKERS_AI` is `true`, the `AI` binding must be configured (see `wrangler.jsonc`); otherwise the Worker fails to start.

### Workers AI Gateway (optional)

| Variable | Description | Default |
| --- | --- | --- |
| `AI_GATEWAY_ID` | Routes Workers AI requests through a Cloudflare AI Gateway when set | — |
| `AI_GATEWAY_SKIP_CACHE` | Skip the AI Gateway cache | `false` |
| `AI_GATEWAY_CACHE_TTL` | AI Gateway cache TTL in seconds (used only when caching is not skipped) | — |

### Advanced overrides (optional)

| Variable | Description | Default |
| --- | --- | --- |
| `GITHUB_API_BASE` | Override the GitHub API base URL | `https://api.github.com` |
| `DISCORD_API_BASE` | Override the Discord API base URL (bot DM delivery) | `https://discord.com/api/v10` |

### Discord delivery

| Variable | Description |
| --- | --- |
| `DISCORD_DELIVERY_MODE` | `webhook` or `bot-dm` (defaults to `webhook`) |
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
- If `branch` is omitted for a watched repository, the default branch is auto-detected via the GitHub API
- Duplicate `owner/name` entries are rejected; use `mode: "both"` to watch releases and commits for one repository

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
npm run check   # runs the TypeScript type check (tsc --noEmit)
npm run dev     # starts the Worker locally with wrangler dev
```

Create a local `.dev.vars` file based on `.dev.vars.example`. `.dev.vars` is git-ignored and should never be committed.

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
- The deployed Worker name is `copilot-cli-discord-watcher` (see `wrangler.jsonc`)

## License

No license file is currently included in this repository, so all rights are reserved by default. Add a `LICENSE` file if you intend to make the project reusable under specific terms.
