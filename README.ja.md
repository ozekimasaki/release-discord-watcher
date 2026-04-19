# release-discord-watcher

[English README](README.md)

GitHub リポジトリの **Release** と **Commit** を監視し、必要に応じて **Workers AI** で日本語化・要約して **Discord** に通知する Cloudflare Worker です。

## 特徴

- 1つの Worker で複数 GitHub リポジトリを監視
- `owner/name` の短縮形で repo を簡単に設定可能
- repo ごとに `release` / `commit` / `both` を切り替え可能
- Release ノートを Workers AI で日本語翻訳・要約
- Commit は日本語要約を生成し、AI 失敗時はフォールバックあり
- Discord Webhook または Bot DM で通知
- Cloudflare KV に既読 state を保存

## 仕組み

Worker は cron で定期実行され、設定された各 repo を順番に確認します。

- **release**: GitHub Releases API を監視
- **commit**: GitHub Commits API を branch 単位で監視
- **both**: 同じ repo で release と commit の両方を監視

既読 state は `STATE` KV namespace に保存されるため、初回同期後は新着 update だけを通知します。

## 構成

```text
src/index.ts        Worker 本体
wrangler.jsonc      Cloudflare Worker の設定、bindings、vars
.dev.vars.example   ローカル環境変数の例
package.json        check / dev / deploy スクリプト
```

## 必要なもの

- Node.js
- npm
- Workers / KV / Workers AI が使える Cloudflare アカウント
- Discord Webhook URL もしくは Discord Bot 認証情報

## 設定

主な設定は Worker の環境変数で行います。

### 主要設定

| 変数 | 説明 |
| --- | --- |
| `WATCH_MODE` | repo 個別指定がないときの既定監視モード。`release` / `commit` / `both` |
| `MONITORED_REPOSITORIES` | 監視対象 repo 一覧を JSON 配列で指定 |
| `MAX_RELEASES_PER_RUN` | 1回で取得する Release の上限 |
| `MAX_COMMITS_PER_RUN` | 1回で取得する Commit の上限 |
| `INITIAL_SYNC_MODE` | `skip` または `notify` |
| `USE_WORKERS_AI` | AI 翻訳・要約を有効化するか |
| `WORKERS_AI_MODEL` | 使用する Workers AI モデル |
| `GITHUB_TOKEN` | 任意。API 制限回避のため推奨 |

### Discord 配信設定

| 変数 | 説明 |
| --- | --- |
| `DISCORD_DELIVERY_MODE` | `webhook` または `bot-dm` |
| `DISCORD_WEBHOOK_URL` | webhook 配信時に必須 |
| `DISCORD_BOT_TOKEN` | bot DM 配信時に必須 |
| `DISCORD_DM_USER_ID` | bot DM 配信時に必須 |
| `DISCORD_USERNAME` | 任意の表示名 |
| `DISCORD_AVATAR_URL` | 任意のアイコン URL |

## repo 設定フォーマット

`MONITORED_REPOSITORIES` は JSON 配列です。各要素は次のどちらでも書けます。

1. 短縮形の文字列

```json
["github/copilot-cli", "openai/codex"]
```

2. 詳細設定の object

```json
[
  { "repo": "cloudflare/workers-sdk", "mode": "commit", "branch": "main" },
  { "repo": "oven-sh/bun", "mode": "both" }
]
```

### ルール

- `repo` は `owner/name` 形式
- `mode` は `release` / `commit` / `both`
- `branch` は `commit` または `both` のときだけ有効
- `mode` を省略した repo は `WATCH_MODE` を引き継ぐ

## 設定例

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

## ローカル開発

```bash
npm install
npm run check
npm run dev
```

`.dev.vars.example` を元に `.dev.vars` を作成して使います。

## デプロイ

```bash
npm run deploy
```

## HTTP エンドポイント

| Method | Path | 説明 |
| --- | --- | --- |
| `GET` | `/` | 現在の設定概要を返す |
| `GET` | `/health` | ヘルスチェック |
| `POST` | `/run` | 手動実行。`Authorization: Bearer <ADMIN_TOKEN>` が必要 |

## 補足

- Release 通知は Workers AI 必須
- Commit 通知は AI 失敗時にコミット一覧ベースのフォールバックあり
- 実装は小さく、主に `src/index.ts` に集約されている
- `.dev.vars` はコミットしないこと
