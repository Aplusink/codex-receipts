import { readFile } from "fs/promises";
import { existsSync } from "fs";
import type {
  TranscriptMessage,
  ParsedTranscript,
} from "../types/transcript.js";

export class TranscriptParser {
  /**
   * Parse a transcript JSONL file
   */
  async parseTranscript(transcriptPath: string): Promise<ParsedTranscript> {
    // Expand ~ to home directory
    const expandedPath = transcriptPath.replace(/^~/, process.env.HOME || "");

    if (!existsSync(expandedPath)) {
      throw new Error(`Transcript file not found: ${transcriptPath}`);
    }

    const content = await readFile(expandedPath, "utf-8");
    const lines = content.trim().split("\n");

    const rawMessages: any[] = lines
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));

    if (
      rawMessages[0]?.type === "session_meta" ||
      rawMessages[0]?.type === "event_msg"
    ) {
      return this.parseCodexTranscript(rawMessages);
    }

    const messages = rawMessages as TranscriptMessage[];

    // Extract session metadata
    const userMessages = messages.filter((m) => m.type === "user");
    const assistantMessages = messages.filter((m) => m.type === "assistant");

    const firstUserMessage = userMessages[0];
    const firstPrompt = this.extractPromptText(firstUserMessage);
    const sessionSlug = firstUserMessage?.slug || "unknown-session";

    // Calculate duration
    const timestamps = messages
      .filter((m) => m.timestamp)
      .map((m) => new Date(m.timestamp));

    const startTime = timestamps[0] || new Date();
    const endTime = timestamps[timestamps.length - 1] || new Date();

    return {
      sessionSlug,
      firstPrompt,
      startTime,
      endTime,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      totalMessages: messages.length,
    };
  }

  /**
   * Extract text from a user message
   */
  private extractPromptText(message: TranscriptMessage | undefined): string {
    if (!message?.message?.content) {
      return "No prompt available";
    }

    const content = message.message.content;

    // Handle string content
    if (typeof content === "string") {
      return this.truncateText(content, 100);
    }

    // Handle array content (multipart messages)
    if (Array.isArray(content)) {
      const textParts = content
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text)
        .join(" ");

      return this.truncateText(textParts, 100);
    }

    return "No prompt available";
  }

  /**
   * Parse Codex rollout JSONL files from ~/.codex/sessions.
   */
  private parseCodexTranscript(messages: any[]): ParsedTranscript {
    const meta = messages.find((m) => m.type === "session_meta")?.payload;
    const userMessages = messages.filter(
      (m) => m.type === "event_msg" && m.payload?.type === "user_message",
    );
    const assistantMessages = messages.filter(
      (m) => m.type === "event_msg" && m.payload?.type === "agent_message",
    );

    const firstPrompt =
      userMessages[0]?.payload?.message ||
      userMessages[0]?.payload?.content?.[0]?.text ||
      "No prompt available";

    const timestamps = messages
      .filter((m) => m.timestamp)
      .map((m) => new Date(m.timestamp));

    const startTime =
      (meta?.timestamp && new Date(meta.timestamp)) ||
      timestamps[0] ||
      new Date();
    const endTime = timestamps[timestamps.length - 1] || new Date();

    return {
      sessionSlug: meta?.id || "codex-session",
      firstPrompt: this.truncateText(String(firstPrompt), 100),
      startTime,
      endTime,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      totalMessages: userMessages.length + assistantMessages.length,
    };
  }

  /**
   * Truncate text to a maximum length
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }

    return text.substring(0, maxLength).trim() + "...";
  }
}
