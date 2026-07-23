const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");

/** @type {{role:'user'|'assistant', content:string}[]} */
const history = [];

// The representative replies in GitHub-flavored markdown. Render a safe subset
// (headings, bold/italic, code, lists, links) to HTML so it doesn't show raw
// `*`/`-`. We escape first, so nothing the model emits can inject markup.
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderInline(s) {
  // `s` is already HTML-escaped; markdown punctuation (* _ ` [ ]) survives that.
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?!\s)([^_]+)_/g, "$1<em>$2</em>");
}

function renderMarkdown(src) {
  const lines = escapeHtml(src).split("\n");
  const out = [];
  let para = [];
  let listType = null;
  let listItems = [];
  let inCode = false;
  let codeBuf = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${renderInline(para.join("<br>"))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (listType) {
      out.push(
        `<${listType}>${listItems
          .map((li) => `<li>${renderInline(li)}</li>`)
          .join("")}</${listType}>`,
      );
    }
    listItems = [];
    listType = null;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushPara();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);

    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
    } else if (ul) {
      flushPara();
      if (listType !== "ul") flushList();
      listType = "ul";
      listItems.push(ul[1]);
    } else if (ol) {
      flushPara();
      if (listType !== "ol") flushList();
      listType = "ol";
      listItems.push(ol[1]);
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  if (inCode) out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`);
  flushPara();
  flushList();
  return out.join("");
}

function addMessage(role, content) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = content;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

addMessage(
  "assistant",
  "Hi — I'm Nico's AI representative. Ask me about his strategy, research, values, or how you might work together.",
);

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  sendBtn.disabled = true;

  addMessage("user", text);
  history.push({ role: "user", content: text });

  const assistantEl = addMessage("assistant", "");
  assistantEl.textContent = "…";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, stream: true }),
    });

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      assistantEl.textContent = `Error: ${err.message || res.statusText}`;
      return;
    }

    // Parse the SSE stream.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let acc = "";
    assistantEl.textContent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const evt of events) {
        const lines = evt.split("\n");
        const eventType = lines.find((l) => l.startsWith("event: "))?.slice(7);
        const dataLine = lines.find((l) => l.startsWith("data: "))?.slice(6);
        if (!dataLine) continue;
        const data = JSON.parse(dataLine);
        if (eventType === "delta") {
          acc += data.text;
          assistantEl.innerHTML = renderMarkdown(acc);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (eventType === "done") {
          acc = data.text || acc;
          assistantEl.innerHTML = renderMarkdown(acc);
        } else if (eventType === "forward") {
          // The representative flagged (or declined to flag) something for Nico.
          const note = document.createElement("div");
          note.className = `forward-note ${data.status}`;
          note.textContent =
            (data.status === "forwarded" ? "✓ " : "") + (data.reason || "");
          messagesEl.appendChild(note);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (eventType === "error") {
          assistantEl.textContent = `Error: ${data.message}`;
        }
      }
    }
    history.push({ role: "assistant", content: acc });
  } catch (e) {
    assistantEl.textContent = `Error: ${e.message}`;
  } finally {
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

sendBtn.addEventListener("click", send);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
});

document.getElementById("suggestions").addEventListener("click", (e) => {
  if (e.target.classList.contains("chip")) {
    inputEl.value = e.target.textContent;
    send();
  }
});
