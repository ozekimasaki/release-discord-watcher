interface AiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: {
      gateway?: {
        id: string;
        skipCache?: boolean;
        cacheTtl?: number;
      };
    },
  ): Promise<unknown>;
}

interface Env {
  STATE: KVNamespace;
  AI?: AiBinding;
  ADMIN_TOKEN?: string;
  AI_GATEWAY_CACHE_TTL?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_SKIP_CACHE?: string;
  DISCORD_API_BASE?: string;
  DISCORD_AVATAR_URL?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DELIVERY_MODE?: string;
  DISCORD_DM_USER_ID?: string;
  DISCORD_USERNAME?: string;
  DISCORD_WEBHOOK_URL?: string;
  GITHUB_API_BASE?: string;
  GITHUB_TOKEN?: string;
  INITIAL_SYNC_MODE?: string;
  MAX_COMMITS_PER_RUN?: string;
  MAX_RELEASES_PER_RUN?: string;
  REPO_BRANCH?: string;
  REPO_NAME?: string;
  REPO_OWNER?: string;
  USE_WORKERS_AI?: string;
  WATCH_COMMITS?: string;
  WATCH_RELEASES?: string;
  WORKERS_AI_MODEL?: string;
}

type DiscordDeliveryMode = "webhook" | "bot-dm";
type InitialSyncMode = "skip" | "notify";
type MonitorTopic = "release" | "commit";
type TriggerSource = "cron" | "manual";

interface BaseAppConfig {
  aiGatewayCacheTtl?: number;
  aiGatewayId?: string;
  aiGatewaySkipCache: boolean;
  discordApiBase: string;
  discordAvatarUrl?: string;
  discordDeliveryMode: DiscordDeliveryMode;
  discordUsername?: string;
  githubApiBase: string;
  githubToken?: string;
  initialSyncMode: InitialSyncMode;
  maxCommitsPerRun: number;
  maxReleasesPerRun: number;
  repoBranch?: string;
  repoName: string;
  repoOwner: string;
  useWorkersAi: boolean;
  watchCommits: boolean;
  watchReleases: boolean;
  workersAiModel: string;
}

interface WebhookAppConfig extends BaseAppConfig {
  discordDeliveryMode: "webhook";
  discordWebhookUrl: string;
}

interface BotDmAppConfig extends BaseAppConfig {
  discordBotToken: string;
  discordDeliveryMode: "bot-dm";
  discordDmUserId: string;
}

type AppConfig = WebhookAppConfig | BotDmAppConfig;

interface MonitorResult {
  detail: string;
  itemCount?: number;
  sent: boolean;
  status: "initialized" | "no_data" | "notified" | "unchanged";
  topic: MonitorTopic;
}

interface GitHubRepository {
  default_branch: string;
}

interface GitHubRelease {
  author?: {
    login: string;
  };
  body: string | null;
  html_url: string;
  id: number;
  name: string | null;
  prerelease: boolean;
  published_at: string | null;
  tag_name: string;
}

interface GitHubCommit {
  author?: {
    login: string;
  } | null;
  commit: {
    author: {
      date: string | null;
      name: string;
    };
    message: string;
  };
  html_url: string;
  sha: string;
}

interface LocalizedNotification {
  aiNote?: string;
  easyExplanation: string;
  highlights: string[];
  summary: string;
  translatedTitle: string;
  translatedUpdateText?: string;
}

interface DiscordEmbedField {
  inline?: boolean;
  name: string;
  value: string;
}

interface DiscordEmbed {
  color: number;
  description?: string;
  fields?: DiscordEmbedField[];
  footer?: {
    text: string;
  };
  timestamp?: string;
  title: string;
  url: string;
}

interface DiscordMessage {
  avatar_url?: string;
  content: string;
  embeds?: DiscordEmbed[];
  username?: string;
}

interface DiscordDmChannel {
  id: string;
}

const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_DISCORD_API_BASE = "https://discord.com/api/v10";
const DEFAULT_AI_MODEL = "@cf/meta/llama-3-8b-instruct";
const THINKING_DISABLED_MODELS = new Set(["@cf/zai-org/glm-4.7-flash"]);
const JSON_AI_SYSTEM_PROMPT =
  "You translate GitHub updates into natural Japanese and explain them in plain Japanese. Return JSON only.";
const TEXT_AI_SYSTEM_PROMPT =
  "You translate GitHub updates into natural Japanese. Output only the requested content. Do not add introductions, explanations, or JSON unless explicitly asked. Keep product names, version tags, URLs, file paths, commands, option names, and code identifiers as-is when appropriate.";

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleHttpRequest(request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      console.error("Request failed", error);
      return jsonResponse({ ok: false, error: getErrorMessage(error) }, status);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runMonitor(env, "cron").catch((error) => {
        console.error("Scheduled run failed", error);
      }),
    );
  },
};

async function handleHttpRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const config = loadConfig(env);

  if (request.method === "GET" && url.pathname === "/") {
    return jsonResponse({
      ok: true,
      repo: `${config.repoOwner}/${config.repoName}`,
      discordDeliveryMode: config.discordDeliveryMode,
      watchReleases: config.watchReleases,
      watchCommits: config.watchCommits,
      repoBranch: config.repoBranch ?? "auto-detect",
      useWorkersAi: config.useWorkersAi,
      initialSyncMode: config.initialSyncMode,
    });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/run") {
    authorizeManualTrigger(request, env);
    const results = await runMonitor(env, "manual");
    return jsonResponse({ ok: true, results });
  }

  throw new HttpError(404, "Not found.");
}

function authorizeManualTrigger(request: Request, env: Env): void {
  const adminToken = env.ADMIN_TOKEN?.trim();
  if (!adminToken) {
    throw new HttpError(403, "ADMIN_TOKEN must be configured before using /run.");
  }

  const authorizationHeader = request.headers.get("Authorization");
  if (authorizationHeader !== `Bearer ${adminToken}`) {
    throw new HttpError(401, "Unauthorized.");
  }
}

async function runMonitor(env: Env, triggerSource: TriggerSource): Promise<MonitorResult[]> {
  const config = loadConfig(env);
  const repository = config.watchCommits && !config.repoBranch ? await fetchRepository(env, config) : undefined;
  const branch = config.watchCommits ? config.repoBranch ?? repository?.default_branch : undefined;

  if (config.watchCommits && !branch) {
    throw new Error("Could not determine the branch to watch. Set REPO_BRANCH explicitly.");
  }

  const tasks: Array<Promise<MonitorResult>> = [];

  if (config.watchReleases) {
    tasks.push(processReleaseUpdates(env, config));
  }

  if (config.watchCommits && branch) {
    tasks.push(processCommitUpdates(env, config, branch));
  }

  const results = await Promise.all(tasks);
  console.log(
    JSON.stringify({
      triggerSource,
      repo: `${config.repoOwner}/${config.repoName}`,
      results,
    }),
  );
  return results;
}

async function processReleaseUpdates(env: Env, config: AppConfig): Promise<MonitorResult> {
  const releases = await fetchGitHubJson<GitHubRelease[]>(
    env,
    config,
    `/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}/releases?per_page=${config.maxReleasesPerRun}`,
    "list releases",
  );

  if (releases.length === 0) {
    return {
      topic: "release",
      sent: false,
      status: "no_data",
      detail: "No releases were returned by the GitHub API.",
    };
  }

  const stateKey = buildStateKey(config, "release");
  const previousReleaseId = await env.STATE.get(stateKey);
  const newestReleaseId = String(releases[0].id);

  if (!previousReleaseId) {
    await env.STATE.put(stateKey, newestReleaseId);

    if (config.initialSyncMode === "notify") {
      await sendReleaseNotifications(env, config, releases.slice(0, 1));
      return {
        topic: "release",
        sent: true,
        status: "notified",
        detail: "Initialized state and notified the latest release.",
        itemCount: 1,
      };
    }

    return {
      topic: "release",
      sent: false,
      status: "initialized",
      detail: "Initialized release state without sending historical notifications.",
    };
  }

  const newReleases = collectNewItems(releases, (release) => String(release.id), previousReleaseId);
  if (newReleases.length === 0) {
    return {
      topic: "release",
      sent: false,
      status: "unchanged",
      detail: "No new releases were found.",
    };
  }

  await sendReleaseNotifications(env, config, [...newReleases].reverse());
  await env.STATE.put(stateKey, newestReleaseId);

  return {
    topic: "release",
    sent: true,
    status: "notified",
    detail: `Sent ${newReleases.length} release notification(s).`,
    itemCount: newReleases.length,
  };
}

async function processCommitUpdates(env: Env, config: AppConfig, branch: string): Promise<MonitorResult> {
  const commits = await fetchGitHubJson<GitHubCommit[]>(
    env,
    config,
    `/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}/commits?sha=${encodeURIComponent(branch)}&per_page=${config.maxCommitsPerRun}`,
    "list commits",
  );

  if (commits.length === 0) {
    return {
      topic: "commit",
      sent: false,
      status: "no_data",
      detail: "No commits were returned by the GitHub API.",
    };
  }

  const stateKey = buildStateKey(config, "commit");
  const previousCommitSha = await env.STATE.get(stateKey);
  const newestCommitSha = commits[0].sha;

  if (!previousCommitSha) {
    await env.STATE.put(stateKey, newestCommitSha);

    if (config.initialSyncMode === "notify") {
      const initialCommits = [...commits].reverse();
      await sendCommitNotification(env, config, branch, initialCommits, undefined);
      return {
        topic: "commit",
        sent: true,
        status: "notified",
        detail: "Initialized state and notified the latest commit batch.",
        itemCount: initialCommits.length,
      };
    }

    return {
      topic: "commit",
      sent: false,
      status: "initialized",
      detail: "Initialized commit state without sending historical notifications.",
    };
  }

  const newCommits = collectNewItems(commits, (commit) => commit.sha, previousCommitSha);
  if (newCommits.length === 0) {
    return {
      topic: "commit",
      sent: false,
      status: "unchanged",
      detail: "No new commits were found.",
    };
  }

  const orderedCommits = [...newCommits].reverse();
  await sendCommitNotification(env, config, branch, orderedCommits, previousCommitSha);
  await env.STATE.put(stateKey, newestCommitSha);

  return {
    topic: "commit",
    sent: true,
    status: "notified",
    detail: `Sent 1 commit summary notification for ${orderedCommits.length} commit(s).`,
    itemCount: orderedCommits.length,
  };
}

async function sendReleaseNotifications(env: Env, config: AppConfig, releases: GitHubRelease[]): Promise<void> {
  for (const release of releases) {
    const localized = await localizeRelease(env, config, release);
    const messages = buildReleaseNotificationMessages(config, release, localized);
    for (const message of messages) {
      await postDiscordMessage(config, message);
    }
  }
}

async function sendCommitNotification(
  env: Env,
  config: AppConfig,
  branch: string,
  commits: GitHubCommit[],
  previousCommitSha?: string,
): Promise<void> {
  const localized = await localizeCommitBatch(env, config, branch, commits);
  const latestCommit = commits[commits.length - 1];
  const compareUrl = previousCommitSha
    ? `https://github.com/${config.repoOwner}/${config.repoName}/compare/${previousCommitSha}...${latestCommit.sha}`
    : `https://github.com/${config.repoOwner}/${config.repoName}/commits/${encodeURIComponent(branch)}`;

  await postDiscordMessage(config, {
    username: config.discordUsername,
    avatar_url: config.discordAvatarUrl,
    content: `🛠️ \`${config.repoOwner}/${config.repoName}\` に新しいコミットが ${commits.length} 件あります。`,
    embeds: [
      {
        title: truncateText(localized.translatedTitle, 256),
        url: compareUrl,
        description: truncateText(localized.summary, 4096),
        color: 0x2ecc71,
        fields: compactFields([
          createField("ブランチ", branch, true),
          createField("件数", String(commits.length), true),
          createField("やさしい説明", localized.easyExplanation),
          createField("主なポイント", formatBullets(localized.highlights)),
          createField("コミット一覧", formatCommitList(commits)),
          createField("補足", localized.aiNote),
        ]),
        footer: {
          text: `${config.repoOwner}/${config.repoName} / commit`,
        },
        timestamp: latestCommit.commit.author.date ?? new Date().toISOString(),
      },
    ],
  });
}

async function localizeRelease(env: Env, config: AppConfig, release: GitHubRelease): Promise<LocalizedNotification> {
  const originalTitle = release.name?.trim() || release.tag_name;
  const releaseNotes = release.body?.trim() || "No detailed release notes were provided.";

  if (!config.useWorkersAi) {
    throw new Error("Release notifications require Workers AI translation. Set USE_WORKERS_AI=true.");
  }

  const releaseContext = [
    `Repository: ${config.repoOwner}/${config.repoName}`,
    `Tag: ${release.tag_name}`,
    `Original title: ${originalTitle}`,
    `Published at: ${release.published_at ?? "unknown"}`,
    "Release notes:",
    truncateText(releaseNotes, 6000),
  ].join("\n");

  const [
    translatedTitleRaw,
    summaryRaw,
    easyExplanationRaw,
    highlightsRaw,
    translatedUpdateTextRaw,
  ] = await Promise.all([
    runWorkersAiPlainText(
      env,
      config,
      config.workersAiModel,
      [
        "Translate the following GitHub release title into natural Japanese.",
        "Output only the translated title.",
        "Keep product names, version tags, commands, file paths, and URLs as-is when appropriate.",
        "",
        `Original title: ${originalTitle}`,
        `Tag: ${release.tag_name}`,
      ].join("\n"),
    ),
    runWorkersAiPlainText(
      env,
      config,
      config.workersAiModel,
      [
        "Explain the following GitHub release in natural Japanese.",
        "Write 2 to 4 sentences.",
        "Output only the Japanese summary.",
        "Do not leave English sentences untranslated.",
        "",
        releaseContext,
      ].join("\n"),
    ),
    runWorkersAiPlainText(
      env,
      config,
      config.workersAiModel,
      [
        "Explain the following GitHub release in very simple Japanese for someone who wants an easy explanation.",
        "Write 1 to 2 short sentences.",
        "Output only the easy Japanese explanation.",
        "",
        releaseContext,
      ].join("\n"),
    ),
    runWorkersAiPlainText(
      env,
      config,
      config.workersAiModel,
      [
        "List the key points from the following GitHub release in Japanese.",
        "Output only 2 to 4 bullet lines.",
        "Each line must start with '- '.",
        "Do not leave English sentences untranslated.",
        "",
        releaseContext,
      ].join("\n"),
    ),
    runWorkersAiPlainText(
      env,
      config,
      config.workersAiModel,
      [
        "Translate the following GitHub release notes into Japanese markdown.",
        "Output only the translated release notes.",
        "Keep headings and bullet structure when helpful.",
        "Do not add commentary before or after the translation.",
        'If there are no detailed release notes, output exactly: 詳細な更新本文は公開されていません。',
        "",
        releaseContext,
      ].join("\n"),
    ),
  ]);

  const translatedTitle = firstNonEmptyLine(extractAiTextResponse(translatedTitleRaw, [
    "translatedTitle",
    "translated_title",
    "title",
    "titleJa",
    "title_ja",
  ]));
  const summary = extractAiTextResponse(summaryRaw, ["summary", "summaryJa", "summary_ja"]);
  const easyExplanation = extractAiTextResponse(easyExplanationRaw, ["easyExplanation", "easy_explanation", "description", "説明"]);
  const translatedUpdateText = extractAiTextResponse(translatedUpdateTextRaw, [
    "translatedUpdateText",
    "translated_update_text",
    "translatedBody",
    "translated_body",
    "body",
    "translation",
    "content",
  ]);

  if (!translatedTitle || !summary || !easyExplanation || !translatedUpdateText) {
    throw new Error("Workers AI returned an incomplete Japanese release translation.");
  }

  const parsedHighlights = parseAiBulletList(highlightsRaw).slice(0, 4);
  const fallbackHighlights = extractHighlights(translatedUpdateText);

  return {
    translatedTitle,
    summary,
    easyExplanation,
    highlights:
      parsedHighlights.length > 0 ? parsedHighlights : fallbackHighlights.length > 0 ? fallbackHighlights : [easyExplanation],
    translatedUpdateText,
  };
}

async function runWorkersAiPlainText(env: Env, config: AppConfig, model: string, prompt: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return normalizeAiTextBlock(await runWorkersAi(env, config, model, prompt, TEXT_AI_SYSTEM_PROMPT));
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Workers AI failed to produce Japanese text. ${truncateText(getErrorMessage(lastError), 220)}`,
  );
}

async function localizeCommitBatch(
  env: Env,
  config: AppConfig,
  branch: string,
  commits: GitHubCommit[],
): Promise<LocalizedNotification> {
  const fallback = buildCommitFallback(branch, commits);

  if (!config.useWorkersAi) {
    return {
      ...fallback,
      aiNote: "Workers AI を無効にしているため、コミット原文をもとに通知しています。",
    };
  }

  try {
    const prompt = [
      "You create Discord notifications for Japanese developers.",
      "Return strict JSON only.",
      'Schema: {"translatedTitle":"...","summary":"...","easyExplanation":"...","highlights":["...","...","..."]}',
      "Rules:",
      "- Use natural Japanese.",
      "- Do not invent facts beyond the commit messages.",
      "- summary: 2 to 4 sentences.",
      "- easyExplanation: 1 to 2 very simple sentences.",
      "- highlights: 2 to 4 short bullet points.",
      "",
      `Repository: ${config.repoOwner}/${config.repoName}`,
      `Branch: ${branch}`,
      `Commit count: ${commits.length}`,
      "Commits:",
      truncateText(
        commits
          .map((commit) => {
            const author = commit.author?.login ?? commit.commit.author.name;
            return `- ${commit.sha.slice(0, 7)} | ${author} | ${firstLine(commit.commit.message)}`;
          })
          .join("\n"),
        6000,
      ),
    ].join("\n");

    const aiText = await runWorkersAi(env, config, config.workersAiModel, prompt, JSON_AI_SYSTEM_PROMPT);
    return parseLocalizedNotification(aiText, fallback);
  } catch (error) {
    return {
      ...fallback,
      aiNote: `Workers AI の要約生成に失敗したため、コミット原文を中心に通知しています。詳細: ${truncateText(getErrorMessage(error), 220)}`,
    };
  }
}

function buildCommitFallback(branch: string, commits: GitHubCommit[]): LocalizedNotification {
  return {
    translatedTitle: `${branch} に新しいコミット ${commits.length} 件`,
    summary: `${branch} ブランチに ${commits.length} 件の新しいコミットがあります。詳しい内容はコミット一覧と比較リンクを確認してください。`,
    easyExplanation: "リポジトリに新しい変更が入りました。まずはコミット一覧を見れば、大まかな更新内容を追えます。",
    highlights: commits.slice(0, 3).map((commit) => firstLine(commit.commit.message)),
  };
}

function loadConfig(env: Env): AppConfig {
  const repoOwner = requireEnv(env.REPO_OWNER, "REPO_OWNER");
  const repoName = requireEnv(env.REPO_NAME, "REPO_NAME");
  const discordDeliveryMode = parseDiscordDeliveryMode(env.DISCORD_DELIVERY_MODE);
  const watchReleases = parseBoolean(env.WATCH_RELEASES, true);
  const watchCommits = parseBoolean(env.WATCH_COMMITS, true);

  if (!watchReleases && !watchCommits) {
    throw new Error("At least one of WATCH_RELEASES or WATCH_COMMITS must be true.");
  }

  const initialSyncMode = parseInitialSyncMode(env.INITIAL_SYNC_MODE);
  const useWorkersAi = parseBoolean(env.USE_WORKERS_AI, true);
  const aiGatewayId = env.AI_GATEWAY_ID?.trim() || undefined;
  const aiGatewaySkipCache = parseBoolean(env.AI_GATEWAY_SKIP_CACHE, false);

  if (useWorkersAi && !env.AI) {
    throw new Error("USE_WORKERS_AI is true, but the AI binding is missing.");
  }

  const baseConfig: BaseAppConfig = {
    aiGatewayId,
    aiGatewaySkipCache,
    aiGatewayCacheTtl: parseOptionalPositiveInteger(env.AI_GATEWAY_CACHE_TTL),
    repoOwner,
    repoName,
    repoBranch: env.REPO_BRANCH?.trim() || undefined,
    discordApiBase: env.DISCORD_API_BASE?.trim() || DEFAULT_DISCORD_API_BASE,
    discordDeliveryMode,
    githubApiBase: env.GITHUB_API_BASE?.trim() || DEFAULT_GITHUB_API_BASE,
    githubToken: env.GITHUB_TOKEN?.trim() || undefined,
    watchReleases,
    watchCommits,
    maxReleasesPerRun: parsePositiveInteger(env.MAX_RELEASES_PER_RUN, 3),
    maxCommitsPerRun: parsePositiveInteger(env.MAX_COMMITS_PER_RUN, 5),
    initialSyncMode,
    useWorkersAi,
    workersAiModel: env.WORKERS_AI_MODEL?.trim() || DEFAULT_AI_MODEL,
    discordUsername: env.DISCORD_USERNAME?.trim() || undefined,
    discordAvatarUrl: env.DISCORD_AVATAR_URL?.trim() || undefined,
  };

  if (discordDeliveryMode === "webhook") {
    return {
      ...baseConfig,
      discordDeliveryMode: "webhook",
      discordWebhookUrl: requireEnv(env.DISCORD_WEBHOOK_URL, "DISCORD_WEBHOOK_URL"),
    };
  }

  return {
    ...baseConfig,
    discordDeliveryMode: "bot-dm",
    discordBotToken: requireEnv(env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN"),
    discordDmUserId: requireEnv(env.DISCORD_DM_USER_ID, "DISCORD_DM_USER_ID"),
  };
}

async function fetchRepository(env: Env, config: AppConfig): Promise<GitHubRepository> {
  return fetchGitHubJson<GitHubRepository>(
    env,
    config,
    `/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}`,
    "read repository",
  );
}

async function fetchGitHubJson<T>(env: Env, config: AppConfig, path: string, action: string): Promise<T> {
  const url = new URL(path, config.githubApiBase);
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "copilot-cli-discord-watcher",
    "X-GitHub-Api-Version": "2022-11-28",
  });

  if (config.githubToken) {
    headers.set("Authorization", `Bearer ${config.githubToken}`);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API failed to ${action}: ${response.status} ${truncateText(body, 500)}`);
  }

  return (await response.json()) as T;
}

async function postDiscordMessage(config: AppConfig, message: DiscordMessage): Promise<void> {
  if (config.discordDeliveryMode === "webhook") {
    await executeDiscordWebhook(config, message);
    return;
  }

  await sendDiscordDirectMessage(config, message);
}

async function executeDiscordWebhook(config: WebhookAppConfig, message: DiscordMessage): Promise<void> {
  const url = new URL(config.discordWebhookUrl);
  url.searchParams.set("wait", "true");

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook failed: ${response.status} ${truncateText(body, 500)}`);
  }
}

async function sendDiscordDirectMessage(config: BotDmAppConfig, message: DiscordMessage): Promise<void> {
  const dmChannel = await createDiscordDmChannel(config);
  const url = buildApiUrl(config.discordApiBase, `channels/${encodeURIComponent(dmChannel.id)}/messages`);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: buildDiscordBotHeaders(config),
    body: JSON.stringify({
      content: message.content,
      embeds: message.embeds,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord DM send failed: ${response.status} ${truncateText(body, 500)}`);
  }
}

async function createDiscordDmChannel(config: BotDmAppConfig): Promise<DiscordDmChannel> {
  const url = buildApiUrl(config.discordApiBase, "users/@me/channels");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: buildDiscordBotHeaders(config),
    body: JSON.stringify({
      recipient_id: config.discordDmUserId,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord DM channel creation failed: ${response.status} ${truncateText(body, 500)}`);
  }

  const channel = (await response.json()) as unknown;
  if (!isRecord(channel)) {
    throw new Error("Discord DM channel creation returned a non-object response.");
  }

  const channelId = pickString(channel, ["id"]);
  if (!channelId) {
    throw new Error("Discord DM channel creation response did not include a channel ID.");
  }

  return { id: channelId };
}

function buildDiscordBotHeaders(config: BotDmAppConfig): Headers {
  return new Headers({
    Authorization: `Bot ${config.discordBotToken}`,
    "content-type": "application/json; charset=UTF-8",
  });
}

function buildApiUrl(base: string, path: string): URL {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return new URL(normalizedPath, normalizedBase);
}

async function runWorkersAi(
  env: Env,
  config: AppConfig,
  model: string,
  prompt: string,
  systemPrompt = TEXT_AI_SYSTEM_PROMPT,
): Promise<string> {
  if (!env.AI) {
    throw new Error("AI binding is not configured.");
  }

  const input: Record<string, unknown> = {
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  };

  if (THINKING_DISABLED_MODELS.has(model)) {
    input.chat_template_kwargs = {
      enable_thinking: false,
    };
  }

  const result = await env.AI.run(model, input, buildAiRunOptions(config));

  return extractAiText(result);
}

function buildAiRunOptions(config: AppConfig): { gateway?: { id: string; skipCache?: boolean; cacheTtl?: number } } | undefined {
  if (!config.aiGatewayId) {
    return undefined;
  }

  const gateway: {
    id: string;
    skipCache?: boolean;
    cacheTtl?: number;
  } = {
    id: config.aiGatewayId,
  };

  if (config.aiGatewaySkipCache) {
    gateway.skipCache = true;
  } else if (config.aiGatewayCacheTtl) {
    gateway.cacheTtl = config.aiGatewayCacheTtl;
  }

  return { gateway };
}

function extractAiText(result: unknown): string {
  const extracted = extractAiTextValue(result);
  if (extracted) {
    return extracted;
  }

  if (!isRecord(result)) {
    throw new Error("Workers AI returned a non-object response.");
  }

  throw new Error(`Workers AI returned an unexpected response shape: ${truncateText(JSON.stringify(result), 500)}`);
}

function parseLocalizedNotification(aiText: string, fallback: LocalizedNotification): LocalizedNotification {
  const parsed = parseLocalizedJsonObject(aiText);

  const translatedTitle = pickString(parsed, ["translatedTitle", "translated_title", "titleJa", "title_ja"]);
  const summary = pickString(parsed, ["summary", "summaryJa", "summary_ja"]);
  const easyExplanation = pickString(parsed, ["easyExplanation", "easy_explanation", "easyJa", "easy_ja"]);
  const highlights = pickStringArray(parsed, ["highlights", "points", "bullets"]).slice(0, 4);

  if (!translatedTitle || !summary || !easyExplanation) {
    throw new Error("Workers AI returned JSON without the expected fields.");
  }

  return {
    translatedTitle,
    summary,
    easyExplanation,
    highlights: highlights.length > 0 ? highlights : fallback.highlights,
  };
}

function parseLocalizedJsonObject(aiText: string): Record<string, unknown> {
  const candidate = extractJsonPayload(aiText);
  const parsed = JSON.parse(candidate) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Workers AI returned JSON that is not an object.");
  }

  return parsed;
}
function extractJsonPayload(text: string): string {
  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Workers AI response did not contain a JSON object.");
  }

  return text.slice(start, end + 1);
}

function buildStateKey(config: AppConfig, topic: MonitorTopic): string {
  return `repo-monitor:${config.repoOwner}/${config.repoName}:${topic}`;
}

function collectNewItems<T>(items: T[], getId: (item: T) => string, previousId: string): T[] {
  const collected: T[] = [];
  for (const item of items) {
    if (getId(item) === previousId) {
      break;
    }
    collected.push(item);
  }
  return collected;
}

function parseBoolean(rawValue: string | undefined, fallback: boolean): boolean {
  if (!rawValue) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value: ${rawValue}`);
}

function parsePositiveInteger(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${rawValue}`);
  }

  return parsed;
}

function parseOptionalPositiveInteger(rawValue: string | undefined): number | undefined {
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${rawValue}`);
  }

  return parsed;
}

function parseInitialSyncMode(rawValue: string | undefined): InitialSyncMode {
  if (!rawValue) {
    return "skip";
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "skip" || normalized === "notify") {
    return normalized;
  }

  throw new Error(`INITIAL_SYNC_MODE must be "skip" or "notify", received: ${rawValue}`);
}

function parseDiscordDeliveryMode(rawValue: string | undefined): DiscordDeliveryMode {
  if (!rawValue) {
    return "webhook";
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "webhook" || normalized === "bot-dm") {
    return normalized;
  }

  throw new Error(`DISCORD_DELIVERY_MODE must be "webhook" or "bot-dm", received: ${rawValue}`);
}

function requireEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }
  return trimmed;
}

function extractHighlights(markdown: string): string[] {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => normalizeMarkdownLine(line))
    .filter((line) => line.length > 0);

  return lines.slice(0, 4);
}

function normalizeMarkdownLine(line: string): string {
  return truncateText(
    line
      .replace(/```/g, "")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^#+\s*/, "")
      .replace(/^\s*[-*+]\s*/, "")
      .replace(/\*\*/g, "")
      .replace(/__/g, "")
      .trim(),
    140,
  );
}

function formatBullets(items: string[]): string {
  if (items.length === 0) {
    return "リンク先の原文を確認してください。";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function parseAiBulletList(text: string): string[] {
  const fromJson = extractAiStringValues(text, ["highlights", "points", "bullets"]);
  if (fromJson.length > 0) {
    return fromJson.map((item) => normalizeMarkdownLine(item)).filter((item) => item.length > 0);
  }

  return normalizeAiTextBlock(text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*here is\b/i.test(line))
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0);
}

function buildReleaseNotificationMessages(
  config: AppConfig,
  release: GitHubRelease,
  localized: LocalizedNotification,
): DiscordMessage[] {
  const translatedUpdateText = localized.translatedUpdateText?.trim();
  if (!translatedUpdateText) {
    throw new Error("Localized release data did not include the translated update text.");
  }

  const translationChunks = splitTextIntoChunks(translatedUpdateText, 1750);
  if (translationChunks.length === 0) {
    throw new Error("The translated release notes were empty.");
  }

  const totalChunks = translationChunks.length;
  const summaryEmbed: DiscordEmbed = {
    title: truncateText(localized.translatedTitle, 256),
    url: release.html_url,
    description: truncateText(localized.summary, 4096),
    color: release.prerelease ? 0xf1c40f : 0x5865f2,
    fields: compactFields([
      createField("タグ", release.tag_name, true),
      createField("やさしい説明", localized.easyExplanation),
      createField("ポイント", formatBullets(localized.highlights)),
      createField(
        "更新内容",
        totalChunks === 1
          ? "このメッセージ本文に、更新本文の日本語訳を全文載せています。"
          : `このメッセージ本文と続き ${totalChunks - 1} 通に、更新本文の日本語訳を全文載せています。`,
      ),
    ]),
    footer: {
      text: `${config.repoOwner}/${config.repoName} / release`,
    },
    timestamp: release.published_at ?? new Date().toISOString(),
  };

  const messages: DiscordMessage[] = [
    {
      username: config.discordUsername,
      avatar_url: config.discordAvatarUrl,
      content: formatReleaseTranslationChunk(translationChunks[0], 1, totalChunks),
      embeds: [summaryEmbed],
    },
  ];

  for (const [index, chunk] of translationChunks.slice(1).entries()) {
    messages.push({
      username: config.discordUsername,
      avatar_url: config.discordAvatarUrl,
      content: formatReleaseTranslationChunk(chunk, index + 2, totalChunks),
    });
  }

  return messages;
}

function formatReleaseTranslationChunk(chunk: string, index: number, total: number): string {
  const heading = total > 1 ? `📝 更新内容の日本語訳 (${index}/${total})` : "📝 更新内容の日本語訳";
  return `${heading}\n\n${chunk}`;
}

function splitTextIntoChunks(text: string, maxLength: number): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let currentChunk = "";

  for (const line of normalized.split(/\r?\n/)) {
    const candidate = currentChunk ? `${currentChunk}\n${line}` : line;
    if (candidate.length <= maxLength) {
      currentChunk = candidate;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
      currentChunk = "";
    }

    if (line.length <= maxLength) {
      currentChunk = line;
      continue;
    }

    let remainingLine = line;
    while (remainingLine.length > maxLength) {
      chunks.push(remainingLine.slice(0, maxLength));
      remainingLine = remainingLine.slice(maxLength);
    }

    currentChunk = remainingLine;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function formatCommitList(commits: GitHubCommit[]): string {
  return commits
    .map((commit) => {
      const author = commit.author?.login ?? commit.commit.author.name;
      return `- \`${commit.sha.slice(0, 7)}\` ${truncateText(firstLine(commit.commit.message), 90)} (${author})`;
    })
    .join("\n");
}

function firstLine(message: string): string {
  const [first = ""] = message.split(/\r?\n/, 1);
  return normalizeMarkdownLine(first);
}

function firstNonEmptyLine(text: string): string {
  const match = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return match ?? "";
}

function normalizeAiTextBlock(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:[\w-]+)?\s*([\s\S]*?)```$/);
  return fencedMatch?.[1]?.trim() || trimmed;
}

function extractAiTextResponse(text: string, preferredKeys: string[] = []): string {
  const normalized = normalizeAiTextBlock(text);
  const values = extractAiStringValues(normalized, preferredKeys);

  if (values.length > 0) {
    return normalizeAiTextBlock(values[0]);
  }

  return stripAiLeadIn(normalized);
}

function extractAiStringValues(text: string, preferredKeys: string[] = []): string[] {
  const parsed = parseAiJsonLike(text);
  if (parsed === undefined) {
    return [];
  }

  return collectAiStringValues(parsed, preferredKeys)
    .map((value) => normalizeAiTextBlock(value))
    .map((value) => stripWrappingQuotes(value))
    .filter((value) => value.length > 0);
}

function parseAiJsonLike(text: string): unknown {
  const normalized = normalizeAiTextBlock(text);

  try {
    return JSON.parse(normalized);
  } catch {
    const firstBrace = normalized.indexOf("{");
    const lastBrace = normalized.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(normalized.slice(firstBrace, lastBrace + 1));
      } catch {
        // continue
      }
    }

    const firstBracket = normalized.indexOf("[");
    const lastBracket = normalized.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      try {
        return JSON.parse(normalized.slice(firstBracket, lastBracket + 1));
      } catch {
        // continue
      }
    }

    return undefined;
  }
}

function extractAiTextValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractAiTextValue(item))
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0);

    if (parts.length > 0) {
      return parts.join("\n").trim();
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const directText = pickString(value, [
    "text",
    "response",
    "content",
    "output_text",
    "generated_text",
    "translated_text",
    "completion",
  ]);
  if (directText) {
    return directText;
  }

  const response = value.response;
  const responseText = extractAiTextValue(response);
  if (responseText) {
    return responseText;
  }

  const result = value.result;
  const resultText = extractAiTextValue(result);
  if (resultText) {
    return resultText;
  }

  const message = value.message;
  const messageText = extractAiTextValue(message);
  if (messageText) {
    return messageText;
  }

  const delta = value.delta;
  const deltaText = extractAiTextValue(delta);
  if (deltaText) {
    return deltaText;
  }

  const choices = value.choices;
  const choicesText = extractAiTextValue(choices);
  if (choicesText) {
    return choicesText;
  }

  if (Array.isArray(value.content)) {
    const contentParts = value.content
      .map((item) => {
        if (isRecord(item)) {
          return pickString(item, ["text", "content"]);
        }
        return extractAiTextValue(item);
      })
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0);

    if (contentParts.length > 0) {
      return contentParts.join("\n").trim();
    }
  }

  return undefined;
}

function collectAiStringValues(value: unknown, preferredKeys: string[] = []): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectAiStringValues(item, preferredKeys));
  }

  if (!isRecord(value)) {
    return [];
  }

  const collected: string[] = [];

  for (const key of preferredKeys) {
    if (key in value) {
      collected.push(...collectAiStringValues(value[key], preferredKeys));
    }
  }

  if (collected.length > 0) {
    return collected;
  }

  return Object.values(value).flatMap((item) => collectAiStringValues(item, preferredKeys));
}

function stripAiLeadIn(text: string): string {
  const lines = normalizeAiTextBlock(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return "";
  }

  const filtered = lines.filter((line, index) => {
    if (index === 0 && /^here is\b/i.test(line)) {
      return false;
    }

    return !/^(summary|説明|easy explanation|highlights?|points?)\s*[:：]?\s*$/i.test(line);
  });

  return filtered.join("\n");
}

function stripWrappingQuotes(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).trim();
  }

  return text;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function createField(name: string, value: string | undefined, inline = false): DiscordEmbedField | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return {
    name,
    value: truncateText(trimmed, 1024),
    inline,
  };
}

function compactFields(fields: Array<DiscordEmbedField | null>): DiscordEmbedField[] | undefined {
  const filtered = fields.filter(isDefined);
  return filtered.length > 0 ? filtered : undefined;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function pickStringArray(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
    },
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
