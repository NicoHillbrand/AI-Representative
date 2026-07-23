// Minimal, dependency-free Markdown renderer. Supports only what Nico's
// strategy doc uses: h1-h6, horizontal rules, ordered/unordered lists,
// paragraphs, and inline **bold**, _italic_, `code`, and [links](url). The
// rest of the site ships no external libraries (no CDN), so neither does this.

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s) {
  // Escape first, then layer formatting onto the escaped text.
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  // _italic_ only when the underscores hug a word boundary (skips file_names).
  out = out.replace(
    /(^|[\s(])_([^_]+)_(?=[\s.,;:)!?]|$)/g,
    (_, pre, c) => `${pre}<em>${c}</em>`,
  );
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, t, href) => `<a href="${href}">${t}</a>`,
  );
  return out;
}

function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let listType = null; // "ul" | "ol" | null
  let para = [];
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      closeList();
      const lvl = heading[1].length;
      html.push(`<h${lvl}>${inline(heading[2])}</h${lvl}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      closeList();
      html.push("<hr />");
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(trimmed);
    if (ul) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (ol) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    closeList();
    para.push(trimmed);
  }
  flushPara();
  closeList();
  return html.join("\n");
}

const el = document.getElementById("doc");
fetch("/api/doc")
  .then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.text();
  })
  .then((md) => {
    el.innerHTML = renderMarkdown(md);
  })
  .catch(() => {
    el.innerHTML =
      '<p class="hint">Couldn\'t load the document right now. Please try again later.</p>';
  });
