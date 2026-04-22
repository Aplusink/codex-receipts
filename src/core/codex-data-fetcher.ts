import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { execa } from "execa";
import type { UsageSession, ModelBreakdown } from "../types/usage.js";
import type { ReceiptConfig } from "../types/config.js";

interface CodexThreadRow {
  id: string;
  title: string;
  rollout_path: string;
  tokens_used: number;
  model: string | null;
  created_at: number;
  updated_at: number;
}

interface CodexTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  total_tokens?: number;
}

export interface CodexThreadSnapshot {
  id: string;
  title: string;
  rolloutPath: string;
  tokensUsed: number;
  model: string;
  createdAt: Date;
  updatedAt: Date;
}

export class CodexDataFetcher {
  private codexHome: string;
  private stateDbPath: string;

  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    this.codexHome = process.env.CODEX_HOME || join(home, ".codex");
    this.stateDbPath = join(this.codexHome, "state_5.sqlite");
  }

  async fetchSessionData(
    sessionQuery?: string,
    config: ReceiptConfig = { version: "1.0.0" },
  ): Promise<UsageSession> {
    const thread = await this.findThread(sessionQuery);
    const usage = await this.readLatestTokenUsage(thread.rolloutPath);

    const rawInputTokens = usage?.input_tokens || thread.tokensUsed || 0;
    const outputTokens = usage?.output_tokens || 0;
    const cacheReadTokens = usage?.cached_input_tokens || 0;
    const inputTokens = Math.max(0, rawInputTokens - cacheReadTokens);
    const totalTokens =
      inputTokens + outputTokens + cacheReadTokens || usage?.total_tokens || 0;
    const modelName = thread.model || "codex";
    const cost = this.estimateCost(
      inputTokens,
      outputTokens,
      config,
      modelName,
      cacheReadTokens,
    );

    const modelBreakdowns: ModelBreakdown[] = [
      {
        modelName,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens: 0,
        cost,
      },
    ];

    return {
      sessionId: thread.title || thread.id,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0,
      totalTokens,
      totalCost: cost,
      modelsUsed: [modelName],
      modelBreakdowns,
      projectPath: thread.rolloutPath,
    };
  }

  async findThread(sessionQuery?: string): Promise<CodexThreadSnapshot> {
    if (!existsSync(this.stateDbPath)) {
      throw new Error(`Codex state database not found: ${this.stateDbPath}`);
    }

    const rows = await this.queryThreads();
    if (rows.length === 0) {
      throw new Error("No Codex threads found");
    }

    const match = sessionQuery
      ? rows.find(
          (row) =>
            row.id === sessionQuery ||
            row.id.startsWith(sessionQuery) ||
            row.title === sessionQuery ||
            row.title.includes(sessionQuery),
        )
      : rows[0];

    if (!match) {
      const available = rows
        .slice(0, 10)
        .map((row) => `  ${row.id.slice(0, 8)}  ${row.title}`)
        .join("\n");
      throw new Error(
        `No Codex session matching "${sessionQuery}". Available sessions:\n${available}`,
      );
    }

    return this.toSnapshot(match);
  }

  async listThreads(limit: number = 20): Promise<CodexThreadSnapshot[]> {
    const rows = await this.queryThreads(limit);
    return rows.map((row) => this.toSnapshot(row));
  }

  private async queryThreads(limit: number = 100): Promise<CodexThreadRow[]> {
    const sql = `
      select id, title, rollout_path, tokens_used, model, created_at, updated_at
      from threads
      where archived = 0 and rollout_path != ''
      order by updated_at desc
      limit ${Math.max(1, Math.min(limit, 500))}
    `;

    const { stdout } = await execa("sqlite3", ["-json", this.stateDbPath, sql], {
      timeout: 10000,
    });

    return JSON.parse(stdout || "[]") as CodexThreadRow[];
  }

  private toSnapshot(row: CodexThreadRow): CodexThreadSnapshot {
    return {
      id: row.id,
      title: row.title,
      rolloutPath: row.rollout_path,
      tokensUsed: Number(row.tokens_used || 0),
      model: row.model || "codex",
      createdAt: new Date(Number(row.created_at) * 1000),
      updatedAt: new Date(Number(row.updated_at) * 1000),
    };
  }

  private async readLatestTokenUsage(
    rolloutPath: string,
  ): Promise<CodexTokenUsage | null> {
    if (!existsSync(rolloutPath)) {
      return null;
    }

    const content = await readFile(rolloutPath, "utf-8");
    let latest: CodexTokenUsage | null = null;

    for (const line of content.split("\n")) {
      if (!line.includes('"type":"token_count"')) continue;

      try {
        const item = JSON.parse(line);
        const usage = item.payload?.info?.total_token_usage;
        if (usage) {
          latest = usage;
        }
      } catch {
        // Ignore partially-written JSONL rows while Codex is still active.
      }
    }

    return latest;
  }

  private estimateCost(
    inputTokens: number,
    outputTokens: number,
    config: ReceiptConfig,
    modelName: string = "gpt-5.4",
    cachedInputTokens: number = 0,
  ): number {
    const defaultRates = this.getDefaultRates(modelName);
    const inputRate =
      config.codexInputUsdPerMillion ?? defaultRates.inputUsdPerMillion;
    const cachedInputRate =
      config.codexCachedInputUsdPerMillion ??
      defaultRates.cachedInputUsdPerMillion;
    const outputRate =
      config.codexOutputUsdPerMillion ?? defaultRates.outputUsdPerMillion;
    return (
      (inputTokens / 1_000_000) * inputRate +
      (cachedInputTokens / 1_000_000) * cachedInputRate +
      (outputTokens / 1_000_000) * outputRate
    );
  }

  private getDefaultRates(modelName: string): {
    inputUsdPerMillion: number;
    cachedInputUsdPerMillion: number;
    outputUsdPerMillion: number;
  } {
    const normalized = modelName.toLowerCase();

    if (normalized.includes("mini")) {
      return {
        inputUsdPerMillion: 0.75,
        cachedInputUsdPerMillion: 0.075,
        outputUsdPerMillion: 4.5,
      };
    }

    return {
      inputUsdPerMillion: 2.5,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
    };
  }
}
