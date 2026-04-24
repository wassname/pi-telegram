/**
 * Regression tests for Telegram markdown rendering helpers
 * Covers nested lists, code blocks, tables, links, quotes, chunking, and other Telegram-specific render edge cases
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MESSAGE_LENGTH,
  renderBlockMessage,
  renderTelegramMessage,
  type DisplayMode,
} from "../lib/rendering.ts";

test("renderBlockMessage returns undefined for text blocks in all modes", () => {
  const block = { type: "text" as const, text: "hello" };
  for (const mode of ["full", "compact", "text"] as DisplayMode[]) {
    assert.equal(renderBlockMessage(block, mode), undefined);
  }
});

test("renderBlockMessage renders thinking block with blockquote", () => {
  const block = { type: "thinking" as const, text: "Need to inspect the config first." };
  const result = renderBlockMessage(block, "full");
  assert.ok(result?.startsWith("**Thinking**\n>"));
  assert.ok(result?.includes("Need to inspect the config first."));
});

test("renderBlockMessage truncates thinking in compact mode", () => {
  const longText = "x".repeat(600);
  const block = { type: "thinking" as const, text: longText };
  const compact = renderBlockMessage(block, "compact")!;
  const full = renderBlockMessage(block, "full")!;
  assert.ok(compact.length < full.length);
  assert.match(compact, /\[compact trace truncated; use \/trace for full\]/);
  assert.ok(full.includes(longText));
});

test("renderBlockMessage renders tool_call block", () => {
  const block = { type: "tool_call" as const, name: "read_config", argsText: '{"path":"config.json"}' };
  const result = renderBlockMessage(block, "full")!;
  assert.ok(result.includes("**Tool call**"));
  assert.ok(result.includes("`read_config`"));
});

test("renderBlockMessage uses code fence for long tool_call args", () => {
  const block = {
    type: "tool_call" as const,
    name: "write_file",
    argsText: '{\n  "path": "out/report.md",\n  "content": "long body"\n}',
  };
  const result = renderBlockMessage(block, "full")!;
  assert.match(result, /\*\*Tool call\*\* `write_file`/);
  assert.match(result, /```json/);
});

test("renderBlockMessage renders tool_result and hides it in text mode", () => {
  const block = { type: "tool_result" as const, text: "file contents here", toolName: "read_file" };
  assert.equal(renderBlockMessage(block, "text"), undefined);
  const compact = renderBlockMessage(block, "compact")!;
  assert.ok(compact.includes("**Tool result**"));
  assert.ok(compact.includes("`read_file`"));
  assert.ok(compact.includes("file contents here"));
  const full = renderBlockMessage(block, "full")!;
  assert.ok(full.includes("file contents here"));
});

test("renderBlockMessage truncates tool_result in compact mode", () => {
  const block = { type: "tool_result" as const, text: "x".repeat(600) };
  const compact = renderBlockMessage(block, "compact")!;
  const full = renderBlockMessage(block, "full")!;
  assert.ok(compact.length < full.length);
  assert.match(compact, /\[compact trace truncated; use \/trace for full\]/);
  assert.ok(full.includes("x".repeat(600)));
});

test("renderBlockMessage marks truncated tool_call args in compact mode", () => {
  const block = {
    type: "tool_call" as const,
    name: "write_file",
    argsText: "x".repeat(600),
  };
  const compact = renderBlockMessage(block, "compact")!;
  const full = renderBlockMessage(block, "full")!;
  assert.match(compact, /\[compact trace truncated; use \/trace for full\]/);
  assert.ok(full.includes("x".repeat(600)));
});

test("Nested lists stay out of code blocks", () => {
  const chunks = renderTelegramMessage(
    "- Level 1\n  - Level 2\n    - Level 3 with **bold** text",
    { mode: "markdown" },
  );
  assert.ok(chunks.length > 0);
  assert.equal(
    chunks.some((chunk) => chunk.text.includes("<pre><code>")),
    false,
  );
  assert.equal(
    chunks.some((chunk) =>
      chunk.text.includes("<code>-</code> Level 3 with <b>bold</b> text"),
    ),
    true,
  );
});

test("Fenced code blocks preserve literal markdown", () => {
  const chunks = renderTelegramMessage(
    '~~~ts\nconst value = "**raw**";\n~~~',
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]?.text ?? "", /<pre><code class="language-ts">/);
  assert.match(chunks[0]?.text ?? "", /\*\*raw\*\*/);
});

test("Underscores inside words do not become italic", () => {
  const chunks = renderTelegramMessage(
    "Path: foo_bar_baz.txt and **bold**",
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.equal((chunks[0]?.text ?? "").includes("<i>bar</i>"), false);
  assert.match(chunks[0]?.text ?? "", /<b>bold<\/b>/);
});

test("Quoted nested lists stay in blockquote rendering", () => {
  const chunks = renderTelegramMessage(
    "> Quoted intro\n> - nested item\n>   - deeper item",
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]?.text ?? "", /<blockquote>/);
  assert.match(chunks[0]?.text ?? "", /nested item/);
  assert.match(chunks[0]?.text ?? "", /<code>-<\/code> nested item/);
  assert.equal((chunks[0]?.text ?? "").includes("<pre><code>"), false);
});

test("Numbered lists use monospace numeric markers", () => {
  const chunks = renderTelegramMessage(
    "1. first\n  2. second",
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]?.text ?? "", /<code>1\.<\/code> first/);
  assert.match(chunks[0]?.text ?? "", /<code>2\.<\/code> second/);
});

test("Nested blockquotes flatten into one Telegram blockquote with indentation", () => {
  const chunks = renderTelegramMessage(
    "> outer\n>> inner\n>>> deepest",
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.equal((chunks[0]?.text.match(/<blockquote>/g) ?? []).length, 1);
  assert.equal((chunks[0]?.text.match(/<\/blockquote>/g) ?? []).length, 1);
  assert.match(chunks[0]?.text ?? "", /outer/);
  assert.match(chunks[0]?.text ?? "", /\u00A0\u00A0inner/);
  assert.match(chunks[0]?.text ?? "", /\u00A0\u00A0\u00A0\u00A0deepest/);
});

test("Markdown tables render as literal monospace blocks without outer side borders", () => {
  const chunks = renderTelegramMessage(
    "| Name | Value |\n| --- | --- |\n| **x** | `y` |",
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]?.text ?? "", /<pre><code class="language-markdown">/);
  assert.equal((chunks[0]?.text ?? "").includes("<b>x</b>"), false);
  assert.match(chunks[0]?.text ?? "", /Name\s+\|\s+Value/);
  assert.match(chunks[0]?.text ?? "", /x\s+\|\s+y/);
  assert.equal((chunks[0]?.text ?? "").includes("| Name |"), false);
  assert.equal((chunks[0]?.text ?? "").includes("| x |"), false);
});

test("Links, code spans, and underscore-heavy text coexist safely", () => {
  const chunks = renderTelegramMessage(
    "See [docs](https://example.com), run `foo_bar()` and keep foo_bar.txt literal",
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.match(
    chunks[0]?.text ?? "",
    /<a href="https:\/\/example.com">docs<\/a>/,
  );
  assert.match(chunks[0]?.text ?? "", /<code>foo_bar\(\)<\/code>/);
  assert.equal((chunks[0]?.text ?? "").includes("<i>bar</i>"), false);
});

test("Long quoted blocks stay chunked with balanced blockquote tags", () => {
  const markdown = Array.from(
    { length: 500 },
    (_, index) => `> quoted **${index}** line`,
  ).join("\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<blockquote>/g) ?? []).length,
      (chunk.text.match(/<\/blockquote>/g) ?? []).length,
    );
  }
});

test("Long markdown replies stay chunked below Telegram limits", () => {
  const markdown = Array.from(
    { length: 600 },
    (_, index) => `- item **${index}**`,
  ).join("\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<b>/g) ?? []).length,
      (chunk.text.match(/<\/b>/g) ?? []).length,
    );
  }
});

test("Long mixed links and code spans stay chunked with balanced inline tags", () => {
  const markdown = Array.from(
    { length: 450 },
    (_, index) =>
      `Paragraph ${index}: see [docs ${index}](https://example.com/${index}), run \`code_${index}()\`, and keep foo_bar_${index}.txt literal`,
  ).join("\n\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<a /g) ?? []).length,
      (chunk.text.match(/<\/a>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<code>/g) ?? []).length,
      (chunk.text.match(/<\/code>/g) ?? []).length,
    );
    assert.equal((chunk.text ?? "").includes("<i>bar</i>"), false);
  }
});

test("Long multi-block markdown keeps quotes and code fences structurally balanced", () => {
  const markdown = Array.from({ length: 120 }, (_, index) => {
    return [
      `## Section ${index}`,
      `> quoted **${index}** line`,
      `- item ${index}`,
      "```ts",
      `const value_${index} = \"**raw**\";`,
      "```",
    ].join("\n");
  }).join("\n\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<blockquote>/g) ?? []).length,
      (chunk.text.match(/<\/blockquote>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<pre><code/g) ?? []).length,
      (chunk.text.match(/<\/code><\/pre>/g) ?? []).length,
    );
  }
});

test("Chunked mixed block transitions keep quote and list structure balanced", () => {
  const markdown = Array.from({ length: 260 }, (_, index) => {
    return [
      `> quoted **${index}** intro`,
      `> continuation ${index}`,
      `- item ${index}`,
      `plain paragraph ${index} with [link](https://example.com/${index})`,
    ].join("\n");
  }).join("\n\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<blockquote>/g) ?? []).length,
      (chunk.text.match(/<\/blockquote>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<a /g) ?? []).length,
      (chunk.text.match(/<\/a>/g) ?? []).length,
    );
  }
});

test("Chunked code fence transitions keep code blocks closed before following prose", () => {
  const markdown = Array.from({ length: 220 }, (_, index) => {
    return [
      "```ts",
      `const block_${index} = \"value_${index}\";`,
      "```",
      `After code **${index}** and \`inline_${index}()\``,
    ].join("\n");
  }).join("\n\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<pre><code/g) ?? []).length,
      (chunk.text.match(/<\/code><\/pre>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<code(?: class="[^"]+")?>/g) ?? []).length,
      (chunk.text.match(/<\/code>/g) ?? []).length,
    );
  }
});

test("Long inline formatting paragraphs stay balanced across chunk boundaries", () => {
  const markdown = Array.from({ length: 500 }, (_, index) => {
    return `Segment ${index} keeps **bold_${index}** with \`code_${index}()\`, [link_${index}](https://example.com/${index}), and foo_bar_${index}.txt literal.`;
  }).join(" ");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<b>/g) ?? []).length,
      (chunk.text.match(/<\/b>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<a /g) ?? []).length,
      (chunk.text.match(/<\/a>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<code>/g) ?? []).length,
      (chunk.text.match(/<\/code>/g) ?? []).length,
    );
    assert.equal(chunk.text.includes("<i>bar</i>"), false);
  }
});

test("Chunked list, code, quote, and prose cycles stay balanced across transitions", () => {
  const markdown = Array.from({ length: 180 }, (_, index) => {
    return [
      `- list item **${index}**`,
      "```ts",
      `const cycle_${index} = \"value_${index}\";`,
      "```",
      `> quoted ${index} with [link](https://example.com/${index})`,
      `Plain paragraph ${index} with \`inline_${index}()\``,
    ].join("\n");
  }).join("\n\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<pre><code/g) ?? []).length,
      (chunk.text.match(/<\/code><\/pre>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<blockquote>/g) ?? []).length,
      (chunk.text.match(/<\/blockquote>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<a /g) ?? []).length,
      (chunk.text.match(/<\/a>/g) ?? []).length,
    );
  }
});
