#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const CONFIG_PATH = path.join(HOME, ".codex-receipts.config.json");
const STATE_PATH = path.join(HOME, ".codex-receipts", "codex-watch-state.json");
const OUTPUT_DIR = path.join(HOME, ".codex-receipts", "projects");
const LOG_PREFIX = "[codex-watch-launchd]";
const STATE_DB_PATH = path.join(CODEX_HOME, "state_5.sqlite");
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

async function main() {
  log("Starting watcher run");

  if (await isCodexRunning()) {
    log("Codex is still running; skipping receipt generation.");
    return;
  }

  const config = await loadConfig();
  const threads = await listThreads(25);
  const state = await loadState();
  const now = Date.now();
  const idleSeconds = 10;
  let changed = false;

  for (const thread of threads) {
    const updatedAtMs = Number(thread.updated_at || thread.updatedAt || 0) * 1000;
    if ((state.printedThreads[thread.id] || 0) >= updatedAtMs) {
      continue;
    }

    if (now - updatedAtMs < idleSeconds * 1000) {
      continue;
    }

    log(`Generating receipt for ${thread.title || thread.id}`);
    await generateReceipt(thread, config);
    state.printedThreads[thread.id] = updatedAtMs;
    changed = true;
  }

  if (!changed) {
    log("No eligible Codex sessions to generate.");
  }

  await saveState(state);
}

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function execFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(command, args, { maxBuffer: 20 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function isCodexRunning() {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFile("osascript", ["-e", 'application "Codex" is running']);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  return false;
}

async function loadConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { version: "1.0.0" };
  }
}

async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      printedThreads: parsed.printedThreads || {},
    };
  } catch {
    return { printedThreads: {} };
  }
}

async function saveState(state) {
  await fsp.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fsp.writeFile(
    STATE_PATH,
    JSON.stringify(
      {
        printedThreadIds: Object.keys(state.printedThreads).slice(-500),
        printedThreads: Object.fromEntries(Object.entries(state.printedThreads).slice(-500)),
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function listThreads(limit) {
  if (!fs.existsSync(STATE_DB_PATH)) {
    throw new Error(`Codex state database not found: ${STATE_DB_PATH}`);
  }

  const sql = `
    select id, title, rollout_path, tokens_used, model, created_at, updated_at
    from threads
    where archived = 0 and rollout_path != ''
    order by updated_at desc
    limit ${Math.max(1, Math.min(limit, 500))}
  `;

  const { stdout } = await execFile("sqlite3", ["-json", STATE_DB_PATH, sql]);
  return JSON.parse(stdout || "[]");
}

async function generateReceipt(thread, config) {
  if (!thread.rollout_path || !fs.existsSync(thread.rollout_path)) {
    throw new Error(`Missing rollout file: ${thread.rollout_path}`);
  }

  const rolloutText = await fsp.readFile(thread.rollout_path, "utf8");
  const transcript = parseRollout(rolloutText, thread);
  const usage = transcript.usage;

  const inputTokens = Math.max(0, (usage.input_tokens || thread.tokens_used || 0) - (usage.cached_input_tokens || 0));
  const cacheReadTokens = usage.cached_input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const totalTokens = usage.total_tokens || inputTokens + outputTokens + cacheReadTokens;
  const model = (thread.model || transcript.model || "codex").replace(/-\d{8}$/, "");
  const totalCost = estimateCost({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    config,
    model,
  });

  const receiptData = {
    id: thread.id,
    title: thread.title || thread.id,
    sessionSlug: transcript.sessionSlug || thread.id,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
    totalCost,
    endTime: transcript.endTime || new Date(thread.updated_at * 1000).toISOString(),
    customerName: config.customerName || transcript.sessionSlug || thread.id,
    location: await detectLocation(config),
    timezone: config.timezone,
  };

  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  const htmlPath = path.join(OUTPUT_DIR, `${receiptData.sessionSlug}.html`);
  const pngPath = path.join(OUTPUT_DIR, `${receiptData.sessionSlug}.png`);

  await fsp.writeFile(htmlPath, buildHtml(receiptData), "utf8");
  await renderPng(htmlPath, pngPath);
  await openInChrome(htmlPath);

  if (config.notionUpload && config.notionApiKey && (config.notionDataSourceId || config.notionDatabaseId || config.notionPageId) && fs.existsSync(pngPath)) {
    await uploadToNotion(pngPath, receiptData, config);
  }

  log(`Receipt saved to ${htmlPath}`);
}

function parseRollout(text, thread) {
  const lines = text.split("\n");
  let latestUsage = {};
  let endTime = null;
  let sessionSlug = null;
  let model = thread.model || null;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (!endTime && item.timestamp) {
        endTime = item.timestamp;
      }
      if (!sessionSlug) {
        sessionSlug =
          item.payload?.session_slug ||
          item.payload?.info?.session_slug ||
          item.session_slug ||
          null;
      }
      if (!model) {
        model =
          item.payload?.model ||
          item.payload?.info?.model ||
          item.model ||
          null;
      }
      if (item.type === "token_count") {
        latestUsage = item.payload?.info?.total_token_usage || latestUsage;
      }
      if (item.timestamp) {
        endTime = item.timestamp;
      }
    } catch {
      // ignore partial lines
    }
  }

  return {
    usage: latestUsage,
    endTime,
    sessionSlug: sessionSlug || thread.id,
    model,
  };
}

function estimateCost({ inputTokens, outputTokens, cacheReadTokens, config, model }) {
  const defaults = getDefaultRates(model);
  const inputRate = config.codexInputUsdPerMillion ?? defaults.input;
  const cacheRate = config.codexCachedInputUsdPerMillion ?? defaults.cache;
  const outputRate = config.codexOutputUsdPerMillion ?? defaults.output;

  return (
    (inputTokens / 1_000_000) * inputRate +
    (cacheReadTokens / 1_000_000) * cacheRate +
    (outputTokens / 1_000_000) * outputRate
  );
}

function getDefaultRates(model) {
  const normalized = String(model || "").toLowerCase();
  if (normalized.includes("mini")) return { input: 0.75, cache: 0.075, output: 4.5 };
  if (normalized.includes("nano")) return { input: 0.2, cache: 0.02, output: 1.2 };
  return { input: 2.5, cache: 0.25, output: 15 };
}

async function detectLocation(config) {
  if (config.location && config.location !== "auto") return config.location;
  const tz = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const map = {
    "America/New_York": "New York, NY",
    "America/Los_Angeles": "Los Angeles, CA",
    "America/Chicago": "Chicago, IL",
    "America/Vancouver": "Vancouver, BC",
    "Europe/London": "London, UK",
    "Europe/Paris": "Paris, France",
    "Asia/Tokyo": "Tokyo, Japan",
    "Asia/Shanghai": "Shanghai, China",
  };
  return map[tz] || tz || "Unknown";
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatDateTime(value, timezone) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(",", "");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildHtml(data) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Receipt - ${escapeHtml(data.sessionSlug)}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      background: #fff;
      color: #222;
      font-family: Menlo, Monaco, "Courier New", monospace;
    }
    .sheet {
      width: 430px;
      margin: 0 auto;
      padding: 18px 22px 28px;
      box-sizing: border-box;
      background: #fff;
    }
    .logo {
      white-space: pre;
      text-align: center;
      font-size: 15px;
      line-height: 1.05;
      margin: 8px 0 18px;
      font-weight: 700;
    }
    .meta, .line-item, .total {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 10px;
      align-items: baseline;
      font-size: 13px;
      margin: 4px 0;
    }
    .dots {
      border-bottom: 1px dotted #999;
      transform: translateY(-2px);
    }
    hr {
      border: none;
      border-top: 2px solid #333;
      margin: 18px 0;
    }
    .line-item {
      grid-template-columns: auto 1fr auto;
      margin: 8px 0;
    }
    .minor {
      color: #666;
    }
    .total {
      font-size: 16px;
      font-weight: 700;
      margin-top: 18px;
    }
    .footer {
      text-align: center;
      color: #666;
      margin-top: 26px;
      font-size: 12px;
      line-height: 1.8;
      border-top: 1px dashed #aaa;
      padding-top: 20px;
    }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="logo">  ______ ____  ____  ______ _  __
 / ____// __ \\/ __ \\/ ____/| |/ /
/ /    / / / / / / / __/   |   /
/ /___ / /_/ / /_/ / /___  /   |
\\____/ \\____/_____/_____/ /_/|_|</div>

    <div class="meta"><div>Location</div><div class="dots"></div><div>${escapeHtml(data.location)}</div></div>
    <div class="meta"><div>Customer</div><div class="dots"></div><div>${escapeHtml(data.customerName)}</div></div>
    <div class="meta"><div>Date</div><div class="dots"></div><div>${escapeHtml(formatDateTime(data.endTime, data.timezone))}</div></div>

    <hr>

    <div class="line-item"><div><strong>${escapeHtml(data.model)}</strong></div><div></div><div><strong>${formatCurrency(data.totalCost)}</strong></div></div>
    <div class="line-item minor"><div>Input tokens</div><div></div><div>${formatNumber(data.inputTokens)}</div></div>
    <div class="line-item minor"><div>Output tokens</div><div></div><div>${formatNumber(data.outputTokens)}</div></div>
    <div class="line-item minor"><div>Cache read</div><div></div><div>${formatNumber(data.cacheReadTokens)}</div></div>

    <hr>

    <div class="total"><div>TOTAL</div><div></div><div>${formatCurrency(data.totalCost)}</div></div>

    <div class="footer">
      CASHIER: ${escapeHtml(data.model)}<br>
      Thank you for building!
    </div>
  </div>
</body>
</html>`;
}

async function renderPng(htmlPath, pngPath) {
  const chromePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!chromePath) return;

  await execFile(chromePath, [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=470,920",
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ]);
}

async function openInChrome(htmlPath) {
  try {
    await execFile("open", ["-a", "Google Chrome", htmlPath]);
  } catch {
    try {
      await execFile("open", [htmlPath]);
    } catch {
      // ignore
    }
  }
}

async function uploadToNotion(imagePath, receiptData, config) {
  const token = config.notionApiKey;
  const pageId = config.notionPageId;
  const databaseId = config.notionDatabaseId;
  const dataSourceId = config.notionDataSourceId;
  const filename = `${receiptData.sessionSlug}.png`;
  const notionVersion = "2026-03-11";

  const jsonHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Notion-Version": notionVersion,
  };

  const createUpload = await fetch("https://api.notion.com/v1/file_uploads", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ filename, content_type: "image/png" }),
  });
  const uploadPayload = await parseResponse(createUpload);

  const buffer = await fsp.readFile(imagePath);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "image/png" }), filename);

  const uploadFile = await fetch(uploadPayload.upload_url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": notionVersion,
    },
    body: form,
  });
  await parseResponse(uploadFile);

  const date = formatDateTime(receiptData.endTime, receiptData.timezone);

  if (dataSourceId || databaseId) {
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        parent: dataSourceId
          ? { type: "data_source_id", data_source_id: dataSourceId }
          : { database_id: databaseId },
        properties: {
          Name: {
            title: [{ type: "text", text: { content: `Codex receipt ${date} ${formatCurrency(receiptData.totalCost)}` } }],
          },
        },
        children: [
          {
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: `${date} · ${formatNumber(receiptData.totalTokens)} tokens` } }],
            },
          },
          {
            type: "image",
            image: {
              caption: [{ type: "text", text: { content: receiptData.sessionSlug } }],
              type: "file_upload",
              file_upload: { id: uploadPayload.id },
            },
          },
        ],
      }),
    });
    await parseResponse(response);
    return;
  }

  if (pageId) {
    const response = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({
        children: [
          {
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: `${date} · ${formatNumber(receiptData.totalTokens)} tokens` } }],
            },
          },
          {
            type: "image",
            image: {
              caption: [{ type: "text", text: { content: receiptData.sessionSlug } }],
              type: "file_upload",
              file_upload: { id: uploadPayload.id },
            },
          },
        ],
      }),
    });
    await parseResponse(response);
  }
}

async function parseResponse(response) {
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(parsed.message || parsed.error || `Notion API error ${response.status}`);
  }
  return parsed;
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`${LOG_PREFIX} ${message}`);
  process.exitCode = 1;
});
