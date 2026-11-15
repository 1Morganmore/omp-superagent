/**
 * Markdown table rendering for the Discord transport.
 *
 * Discord has no pipe-table support: a table sent verbatim arrives as literal
 * `| a | b |` rows. Discord does render fenced blocks in a monospaced font, so a
 * table is converted into an aligned fenced block before it leaves this package.
 *
 * Column padding uses display width, not string length, so CJK and other wide
 * characters line up. The width primitive is `Bun.stringWidth` (UAX #11 east
 * asian width, grapheme clusters, ANSI escapes ignored). OMP's own
 * `visibleWidth()` in `.upstream/omp/packages/tui/src/utils.ts` is a wrapper over
 * that same primitive, but `@oh-my-pi/pi-tui` is not a dependency of this
 * package, so this is a local adaptation rather than an import.
 */

type Align = "left" | "center" | "right";

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const DELIMITER_CELL = /^:?-+:?$/;

/**
 * Split one table row into trimmed cells.
 * Returns null when the line carries no unescaped pipe, so callers can end a
 * table body. `\|` and pipes inside backtick spans never split a cell, matching
 * how GFM reads a row.
 */
function splitRow(line: string): string[] | null {
  const cells: string[] = [];
  let cell = "";
  let pipe = false;
  let leading = false;
  let tick = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === "\\" && line[index + 1] === "|") {
      // A GFM escaped pipe is cell content, not a separator: inside the fence
      // it stays the literal `|` the author asked to display.
      cell += "|";
      index++;
      continue;
    }
    if (char === "`") {
      let run = 1;
      while (line[index + run] === "`") run++;
      tick = tick === run ? 0 : tick === 0 ? run : tick;
      cell += "`".repeat(run);
      index += run - 1;
      continue;
    }
    if (char === "|" && tick === 0) {
      if (!pipe) leading = cell.trim() === "";
      pipe = true;
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  if (!pipe) return null;
  cells.push(cell);
  if (leading) cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.length > 0 ? cells.map(value => value.trim()) : null;
}

/** The delimiter row must have the same cell count as the header, as in GFM. */
function parseDelimiter(line: string): Align[] | null {
  const cells = splitRow(line);
  if (!cells) return null;
  const aligns: Align[] = [];
  for (const cell of cells) {
    if (!DELIMITER_CELL.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    aligns.push(left && right ? "center" : right ? "right" : "left");
  }
  return aligns;
}

function pad(value: string, width: number, align: Align): string {
  const missing = width - Bun.stringWidth(value);
  if (missing <= 0) return value;
  if (align === "right") return " ".repeat(missing) + value;
  if (align === "center") {
    const left = Math.floor(missing / 2);
    return " ".repeat(left) + value + " ".repeat(missing - left);
  }
  return value + " ".repeat(missing);
}

/** Render the table lines as one fenced block with padded monospace columns. */
function formatTable(rows: string[][], aligns: Align[]): string[] {
  const columns = Math.max(aligns.length, ...rows.map(row => row.length));
  const alignOf = (column: number): Align => aligns[column] ?? "left";
  // Three cells minimum keeps every separator a readable `---` run.
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(3, ...rows.map(row => Bun.stringWidth(row[column] ?? ""))));
  const line = (cells: string[]) =>
    `| ${widths.map((width, column) => pad(cells[column] ?? "", width, alignOf(column))).join(" | ")} |`;
  // Pure dashes keep the grid exact; alignment is already visible in the padded
  // cells, and `:` markers would only shift every following column by one.
  const separator = `| ${widths.map(width => "-".repeat(width)).join(" | ")} |`;
  return ["```", line(rows[0]!), separator, ...rows.slice(1).map(line), "```"];
}

/**
 * Rewrite markdown pipe tables as aligned fenced blocks.
 *
 * Everything else passes through byte for byte: prose, lists, headings, links,
 * blockquotes, inline code, and existing fenced blocks. Pipes inside a fence are
 * never treated as a table, and an already-converted table stays inside its own
 * fence, so the transform is idempotent.
 */
export function renderDiscordMarkdown(text: string): string {
  if (!text.includes("|")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = FENCE_OPEN.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence.char && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = { char: marker[0]!, length: marker.length };
      out.push(line);
      continue;
    }
    const delimiter = index + 1 < lines.length ? parseDelimiter(lines[index + 1]!) : null;
    const header = delimiter ? splitRow(line) : null;
    if (!delimiter || !header || header.length !== delimiter.length) {
      out.push(line);
      continue;
    }
    const rows = [header];
    let next = index + 2;
    for (; next < lines.length; next++) {
      if (FENCE_OPEN.test(lines[next]!)) break;
      const row = splitRow(lines[next]!);
      if (!row) break;
      rows.push(row);
    }
    out.push(...formatTable(rows, delimiter));
    index = next - 1;
  }
  return out.join("\n");
}
