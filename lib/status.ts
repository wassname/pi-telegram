/**
 * Telegram status rendering helpers
 * Builds usage, cost, and context summaries for the interactive Telegram status view
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface TelegramUsageStats {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function collectUsageStats(ctx: ExtensionContext): TelegramUsageStats {
  const stats: TelegramUsageStats = {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
  };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    stats.totalInput += entry.message.usage.input;
    stats.totalOutput += entry.message.usage.output;
    stats.totalCacheRead += entry.message.usage.cacheRead;
    stats.totalCacheWrite += entry.message.usage.cacheWrite;
    stats.totalCost += entry.message.usage.cost.total;
  }
  return stats;
}

function buildStatusRow(label: string, value: string): string {
  return `<b>${escapeHtml(label)}:</b> <code>${escapeHtml(value)}</code>`;
}

function buildUsageSummary(stats: TelegramUsageStats): string | undefined {
  const tokenParts: string[] = [];
  if (stats.totalInput) tokenParts.push(`↑${formatTokens(stats.totalInput)}`);
  if (stats.totalOutput) tokenParts.push(`↓${formatTokens(stats.totalOutput)}`);
  if (stats.totalCacheRead)
    tokenParts.push(`R${formatTokens(stats.totalCacheRead)}`);
  if (stats.totalCacheWrite)
    tokenParts.push(`W${formatTokens(stats.totalCacheWrite)}`);
  return tokenParts.length > 0 ? tokenParts.join(" ") : undefined;
}

function buildCostSummary(
  stats: TelegramUsageStats,
  usesSubscription: boolean,
): string | undefined {
  if (!stats.totalCost && !usesSubscription) return undefined;
  return `$${stats.totalCost.toFixed(3)}${usesSubscription ? " (sub)" : ""}`;
}

function buildContextSummary(
  ctx: ExtensionContext,
  activeModel: Model<any> | undefined,
): string {
  const usage = ctx.getContextUsage();
  if (!usage) return "unknown";
  const contextWindow = usage.contextWindow ?? activeModel?.contextWindow ?? 0;
  const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
  return `${percent}/${formatTokens(contextWindow)}`;
}

export function buildStatusHtml(
  ctx: ExtensionContext,
  activeModel: Model<any> | undefined,
  traceVisible: boolean,
): string {
  const stats = collectUsageStats(ctx);
  const usesSubscription = activeModel
    ? ctx.modelRegistry.isUsingOAuth(activeModel)
    : false;
  const lines: string[] = [];
  const usageSummary = buildUsageSummary(stats);
  const costSummary = buildCostSummary(stats, usesSubscription);
  if (usageSummary) {
    lines.push(buildStatusRow("Usage", usageSummary));
  }
  if (costSummary) {
    lines.push(buildStatusRow("Cost", costSummary));
  }
  lines.push(buildStatusRow("Context", buildContextSummary(ctx, activeModel)));
  lines.push(buildStatusRow("Trace", traceVisible ? "on" : "off"));
  if (lines.length === 0) {
    lines.push(buildStatusRow("Status", "No usage data yet."));
  }
  return lines.join("\n");
}
