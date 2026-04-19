# AGENTS.MD

## 概要

このフォルダは **Cloudflare Workers 上で動く GitHub 更新監視ツール** です。  
対象リポジトリ群の **Release / Commit** を定期監視し、必要に応じて **Workers AI で日本語化・要約** して **Discord** に通知します。

実装はほぼ `src/index.ts` の単一ファイルに集約されており、**小規模・単機能な Worker** として整理されています。

## ルート構成

```text
copilot_update/
|- src/
|  `- index.ts           # Worker 本体。HTTP API / cron / GitHub取得 / Discord通知 / AI整形を集約
|- package.json          # npm scripts と依存関係
|- package-lock.json     # lockfile
|- tsconfig.json         # TypeScript 設定
|- wrangler.jsonc        # Cloudflare Workers 設定、KV/AI binding、cron、vars
|- .dev.vars.example     # ローカル開発用の環境変数サンプル
|- .dev.vars             # ローカル実値（秘匿、コミット対象外）
|- .gitignore            # node_modules, .wrangler, .dev.vars などを除外
|- .wrangler/            # Wrangler のローカル生成物
|- node_modules/         # 依存パッケージ
`- AGENTS.MD             # このドキュメント
```

## 主要ファイルの役割

| パス | 役割 |
| --- | --- |
| `src/index.ts` | アプリケーション本体。設定読込、HTTP エンドポイント、cron 実行、GitHub API、Discord 通知、Workers AI 整形、KV state 管理を担当 |
| `wrangler.jsonc` | Worker 名、エントリーポイント、`compatibility_date`、KV namespace `STATE`、AI binding `AI`、cron、デフォルト変数を定義 |
| `package.json` | `npm run check`、`npm run dev`、`npm run deploy` を提供 |
| `.dev.vars.example` | ローカルで必要なシークレットや通知方式の例 |
| `tsconfig.json` | Workers 向けに `ES2022` + `WebWorker` + strict mode を有効化 |

## 実装の内部構成

`src/index.ts` は大きく次の責務に分かれています。

1. **型定義と設定モデル**
   - `Env`
   - `AppConfig`
   - GitHub / Discord / AI 関連の型

2. **Worker エントリーポイント**
   - `fetch(...)`
   - `scheduled(...)`

3. **HTTP ハンドラ**
   - `GET /` : 現在の設定概要を返す
   - `GET /health` : ヘルスチェック
   - `POST /run` : `ADMIN_TOKEN` による手動実行

4. **監視フロー**
   - `runMonitor(...)`
   - `processReleaseUpdates(...)`
   - `processCommitUpdates(...)`

5. **通知生成**
   - Release: 日本語タイトル、要約、やさしい説明、ポイント、本文翻訳を生成
   - Commit: バッチ要約を生成し、失敗時はコミット一覧ベースのフォールバックを返す

6. **外部連携**
   - GitHub API 読み出し
   - Discord Webhook / Bot DM
   - Workers AI
   - Cloudflare KV (`STATE`) で既読位置を保持

7. **ユーティリティ**
   - AI 応答の JSON/テキスト正規化
   - Markdown / bullet / chunk 分割
   - 文字数制限対応

## 実行モデル

### 1. 定期実行

- `wrangler.jsonc` の cron は `*/30 * * * *`
- 30 分ごとに Worker が起動し、Release / Commit をチェック

### 2. 状態管理

- KV namespace `STATE` に前回通知済みの ID を保存
- 初回は `INITIAL_SYNC_MODE` に応じて:
  - `skip`: 既存履歴は通知せず状態のみ初期化
  - `notify`: 最新データを通知して初期化

### 3. 通知先

- `DISCORD_DELIVERY_MODE=webhook`
  - `DISCORD_WEBHOOK_URL` を利用
- `DISCORD_DELIVERY_MODE=bot-dm`
  - `DISCORD_BOT_TOKEN`
  - `DISCORD_DM_USER_ID`
  を利用

## 設定の要点

`wrangler.jsonc` にはデフォルト値が入っています。ローカルや本番では必要に応じて上書きします。

特に重要な変数:

| 変数 | 意味 |
| --- | --- |
| `WATCH_MODE` | 既定の監視モード。`release` / `commit` / `both` |
| `MONITORED_REPOSITORIES` | 監視対象 repo 一覧。`"owner/name"` の短縮形、または `{ "repo": "owner/name", "mode": "...", "branch": "..." }` の詳細形を JSON 配列で渡す |
| `MAX_RELEASES_PER_RUN` / `MAX_COMMITS_PER_RUN` | 1 回の取得上限 |
| `INITIAL_SYNC_MODE` | 初回同期の通知方針 |
| `USE_WORKERS_AI` | AI 要約・翻訳を使うか |
| `WORKERS_AI_MODEL` | 利用する Workers AI モデル |
| `AI_GATEWAY_ID` | 指定時は Workers AI リクエストを Cloudflare AI Gateway 経由で送る |
| `AI_GATEWAY_SKIP_CACHE` | AI Gateway のキャッシュをスキップするか |
| `AI_GATEWAY_CACHE_TTL` | AI Gateway のキャッシュ TTL |
| `ADMIN_TOKEN` | `POST /run` の認証トークン |
| `GITHUB_TOKEN` | GitHub API 制限回避や private repo 用 |

`MONITORED_REPOSITORIES` の例:

```json
[
  "github/copilot-cli",
  { "repo": "cloudflare/workers-sdk", "mode": "commit", "branch": "main" },
  { "repo": "oven-sh/bun", "mode": "both" }
]
```

- `release`: Release だけ監視
- `commit`: Commit だけ監視
- `both`: Release と Commit の両方を監視
- `branch` は `commit` / `both` のときだけ有効。未指定時は default branch を自動取得

## 開発コマンド

```bash
npm run check   # TypeScript 型チェック
npm run dev     # Wrangler dev
npm run deploy  # Cloudflare Workers へデプロイ
```

## このリポジトリで変更しやすい場所

### 通知文面や通知項目を変えたい

- `src/index.ts`
  - Release 通知: `localizeRelease`, `buildReleaseNotificationMessages`
  - Commit 通知: `localizeCommitBatch`, `sendCommitNotification`

### 設定項目を増やしたい

- `src/index.ts`
  - `Env`
  - `BaseAppConfig` / `AppConfig`
  - `loadConfig`
- `wrangler.jsonc`
  - `vars` / bindings
- `.dev.vars.example`
  - ローカル用サンプル

### 通知先や配信方式を変えたい

- Discord Webhook: `executeDiscordWebhook`
- Discord DM: `sendDiscordDirectMessage`, `createDiscordDmChannel`

### 監視ロジックを変えたい

- `runMonitor`
- `processReleaseUpdates`
- `processCommitUpdates`
- `buildStateKey`, `collectNewItems`

## 注意点

- **実装の中心は `src/index.ts` 1 ファイル** なので、変更時は影響範囲を広めに確認する
- Release 通知は **Workers AI 必須**
- Commit 通知は AI 失敗時に **フォールバックあり**
- `.dev.vars` には秘密情報を入れる想定のため、内容を文書化・共有しない
- `.wrangler/` と `node_modules/` は生成物として扱う

## 現状の設計評価

- **把握しやすい点**
  - 小規模 Worker として責務が明確
  - デプロイ設定が `wrangler.jsonc` に集約
  - 実行経路が `fetch` / `scheduled` に限定されていて追いやすい

- **将来的に分割候補になる点**
  - `src/index.ts` が大きく、通知整形・AI 応答解析・外部 API 呼び出しが同居している
  - 機能追加が増える場合は `config`, `github`, `discord`, `ai`, `formatters` などへの分割が自然

## 一言でいうと

**「GitHub の更新を拾って、日本語で分かりやすく Discord に流す Cloudflare Worker」** です。  
設定は `wrangler.jsonc`、本体は `src/index.ts`、ローカル秘密情報は `.dev.vars` に集約されています。
