// HTML escaping, page layout and a small, safe Markdown renderer for agreement
// text. Everything is escaped first; only a fixed subset of Markdown becomes
// markup, and links must be https.

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface LayoutOptions {
  title: string;
  user?: { login: string; admin: boolean } | null;
  csrf?: string;
}

export function layout(body: string, opts: LayoutOptions): string {
  const nav = opts.user
    ? `<nav><span>Signed in as <strong>@${esc(opts.user.login)}</strong></span>
        <a href="/my">My agreements</a>${opts.user.admin ? ' <a href="/admin">Admin</a>' : ""}
        <form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${esc(opts.csrf ?? "")}"><button class="link">Sign out</button></form></nav>`
    : `<nav><a href="/recover">Find my signed agreements</a></nav>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} · PactDock</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header><a class="brand" href="/">PactDock</a>${nav}</header>
<main>
${body}
</main>
<footer>PactDock Server · contributor agreements stored on this server</footer>
</body>
</html>`;
}

function inline(text: string): string {
  // Input is already escaped; markers are plain ASCII so they survive escaping.
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
}

/** Renders the Markdown subset used by agreements: headings, paragraphs, lists, tables, rules. */
export function markdown(source: string): string {
  const cleaned = source.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const lines = cleaned.split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(esc(para.join(" ")))}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(esc(heading[2]))}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flush();
      out.push("<hr>");
      continue;
    }
    if (/^<sub>.*<\/sub>$/.test(trimmed)) {
      flush();
      out.push(`<p><small>${inline(esc(trimmed.slice(5, -6)))}</small></p>`);
      continue;
    }
    if (/^\|.*\|$/.test(trimmed)) {
      flush();
      const rows: string[][] = [];
      let j = i;
      while (j < lines.length && /^\|.*\|$/.test((lines[j] ?? "").trim())) {
        rows.push((lines[j] ?? "").trim().slice(1, -1).split("|").map((c) => c.trim()));
        j++;
      }
      i = j - 1;
      const isSep = (r: string[]) => r.every((c) => /^:?-{3,}:?$/.test(c) || c === "");
      const header = rows[0] ?? [];
      const body = rows.slice(rows[1] && isSep(rows[1]) ? 2 : 1);
      out.push(
        `<table><thead><tr>${header.map((c) => `<th>${inline(esc(c))}</th>`).join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }
    const bullet = /^([-*]|\d+\.)\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flush();
      const ordered = /\d/.test(bullet[1]!);
      const items: string[] = [];
      let j = i;
      let m: RegExpExecArray | null;
      while (j < lines.length && (m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[j] ?? ""))) {
        items.push(`<li>${inline(esc(m[2]))}</li>`);
        j++;
      }
      i = j - 1;
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    para.push(trimmed);
  }
  flush();
  return out.join("\n");
}
