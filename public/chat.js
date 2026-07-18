const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");

/** @type {{role:'user'|'assistant', content:string}[]} */
const history = [];

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
          assistantEl.textContent = acc;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (eventType === "done") {
          acc = data.text || acc;
          assistantEl.textContent = acc;
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
