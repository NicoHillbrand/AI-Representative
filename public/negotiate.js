const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const matchpanel = document.getElementById("matchpanel");
const matchesEl = document.getElementById("matches");
const summaryBtn = document.getElementById("summaryBtn");
const summaryBox = document.getElementById("summaryBox");
const sessionInfo = document.getElementById("sessionInfo");

let session = null; // { sessionId, token }
const seenMatches = new Set();

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
  "You're now connected to Nico's negotiation agent. Introduce your principal and assert what they're interested in.",
);

async function ensureSession() {
  if (session) return session;
  const res = await fetch("/api/negotiate/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ principal: "Sandbox visitor" }),
  });
  session = await res.json();
  sessionInfo.textContent = `session ${session.sessionId.slice(0, 16)}…`;
  return session;
}

function renderMatch(m) {
  if (seenMatches.has(m.key)) return;
  seenMatches.add(m.key);
  matchpanel.style.display = "block";
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.style.borderColor = "var(--accent-2)";
  chip.textContent = "✓ " + m.label;
  matchesEl.appendChild(chip);
  addMessage("match", `🤝 Mutual interest confirmed: ${m.label}`);
}

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  sendBtn.disabled = true;

  addMessage("user", text);
  const thinking = addMessage("assistant", "…");

  try {
    const s = await ensureSession();
    const res = await fetch(`/api/negotiate/sessions/${s.sessionId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.token}`,
      },
      body: JSON.stringify({ message: text }),
    });
    const data = await res.json();
    if (!res.ok) {
      thinking.textContent = `Error: ${data.message || res.statusText}`;
      return;
    }
    thinking.textContent = data.reply;
    (data.newMatches || []).forEach(renderMatch);
  } catch (e) {
    thinking.textContent = `Error: ${e.message}`;
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

summaryBtn.addEventListener("click", async () => {
  if (!session) {
    summaryBox.innerHTML = `<div class="note" style="margin-top:12px;">No session yet — send a message first.</div>`;
    return;
  }
  summaryBtn.disabled = true;
  summaryBox.innerHTML = `<div class="note" style="margin-top:12px;">Summarizing…</div>`;
  try {
    const res = await fetch(`/api/negotiate/sessions/${session.sessionId}/summary`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    const data = await res.json();
    const matches = (data.confirmedMatches || []).map((m) => m.label);
    summaryBox.innerHTML = `
      <div class="card" style="margin-top:12px;">
        <h3>Session summary</h3>
        <p style="color:var(--text)">${escapeHtml(data.summary)}</p>
        <p style="margin-top:10px;"><strong>Confirmed mutual interests:</strong> ${
          matches.length ? matches.map(escapeHtml).join(", ") : "none"
        }</p>
      </div>`;
  } catch (e) {
    summaryBox.innerHTML = `<div class="note" style="margin-top:12px;">Error: ${escapeHtml(e.message)}</div>`;
  } finally {
    summaryBtn.disabled = false;
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
