/**
 * ASCII art headers for receipts
 */

export const CLAUDE_LOGO = `  ______ ____  ____  ______ _  __
 / ____// __ \\/ __ \\/ ____/| |/ /
/ /    / / / / / / / __/   |   /
/ /___ / /_/ / /_/ / /___  /   |
\\____/ \\____/_____/_____/ /_/|_|`;

/**
 * Get the Codex logo
 */
export function getHeader(): string {
  return CLAUDE_LOGO;
}

/**
 * Receipt section separators
 */
export const SEPARATOR = "━".repeat(35);
export const LIGHT_SEPARATOR = "─".repeat(35);
