import { describe, expect, test } from "bun:test";
import { renderDiscordMarkdown } from "../src/discord-markdown.ts";

describe("Discord markdown table rendering", () => {
  test("converts a pipe table into one aligned fenced block", () => {
    expect(renderDiscordMarkdown([
      "Before text.",
      "| Name | Count |",
      "| --- | ---: |",
      "| a | 12 |",
      "| longer | 3 |",
      "After text.",
    ].join("\n"))).toBe([
      "Before text.",
      "```",
      "| Name   | Count |",
      "| ------ | ----- |",
      "| a      |    12 |",
      "| longer |     3 |",
      "```",
      "After text.",
    ].join("\n"));
  });

  test("pads every column to its widest cell and honours alignment markers", () => {
    expect(renderDiscordMarkdown([
      "| left | center | right |",
      "| :--- | :----: | ----: |",
      "| a | b | c |",
      "| wide cell | mid | d |",
    ].join("\n"))).toBe([
      "```",
      "| left      | center | right |",
      "| --------- | ------ | ----- |",
      "| a         |   b    |     c |",
      "| wide cell |  mid   |     d |",
      "```",
    ].join("\n"));
  });

  test("pads by display width so CJK columns align with ASCII", () => {
    const rendered = renderDiscordMarkdown([
      "| 이름 | 값 |",
      "| --- | --- |",
      "| 한글 | 1 |",
      "| ab | 22 |",
    ].join("\n"));
    const lines = rendered.split("\n");
    expect(lines[0]).toBe("```");
    expect(lines.at(-1)).toBe("```");
    // Every fenced line occupies the same number of display columns, which is
    // only true when padding counts CJK glyphs as two cells rather than one unit.
    expect(new Set(lines.slice(1, -1).map(line => Bun.stringWidth(line))).size).toBe(1);
    expect(lines).toEqual([
      "```",
      "| 이름 | 값  |",
      "| ---- | --- |",
      "| 한글 | 1   |",
      "| ab   | 22  |",
      "```",
    ]);
  });

  test("leaves a pipe table without a delimiter row untouched", () => {
    const source = ["| a | b |", "| just text |", "| c | d |"].join("\n");
    expect(renderDiscordMarkdown(source)).toBe(source);
  });

  test("leaves a delimiter row whose cell count differs from the header untouched", () => {
    const source = ["| a | b |", "| --- |", "| c | d |"].join("\n");
    expect(renderDiscordMarkdown(source)).toBe(source);
  });

  test("never treats pipes inside an existing fenced block as a table", () => {
    const source = ["```", "| a | b |", "| --- | --- |", "| c | d |", "```"].join("\n");
    expect(renderDiscordMarkdown(source)).toBe(source);
    const tilde = ["~~~~", "| a | b |", "|---|---|", "~~~~"].join("\n");
    expect(renderDiscordMarkdown(tilde)).toBe(tilde);
  });

  test("passes prose, lists, headings, links, blockquotes, and inline code through untouched", () => {
    const source = [
      "# Heading | with pipe",
      "",
      "- list item | pipe",
      "1. ordered | pipe",
      "",
      "> quote | pipe",
      "",
      "[link](https://example.invalid/a|b) and `inline | code`",
      "",
      "plain prose",
    ].join("\n");
    expect(renderDiscordMarkdown(source)).toBe(source);
  });

  test("does not split a row on an escaped pipe or a pipe inside inline code", () => {
    const lines = renderDiscordMarkdown([
      "| expr | note |",
      "| --- | --- |",
      "| a \\| b | `x | y` |",
    ].join("\n")).split("\n");
    // Two source cells stay two cells: the escaped pipe and the fenced-looking
    // pipe are content, so the separator row never grows past two columns.
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("```");
    expect(lines[2]).toBe("| ----- | ------- |");
    expect(lines[4]).toBe("```");
  });

  test("is idempotent: an already converted table is not converted again", () => {
    const once = renderDiscordMarkdown(["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
    expect(renderDiscordMarkdown(once)).toBe(once);
  });

  test("always emits a closed fence", () => {
    const rendered = renderDiscordMarkdown(["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n"));
    expect(rendered.startsWith("```\n")).toBe(true);
    expect(rendered.endsWith("\n```")).toBe(true);
    expect(rendered.split("```")).toHaveLength(3);
  });
});
