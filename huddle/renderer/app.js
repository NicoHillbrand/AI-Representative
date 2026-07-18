// Huddle renderer — all product logic. Framework-agnostic vanilla JS on
// purpose: everything native goes through window.huddle (preload.js), so
// porting the shell to Tauri later leaves this file untouched.
const $ = (id) => document.getElementById(id);

// cfg: { serverUrl, deviceToken, memberId, displayName, callLink, myCallLink,
//        activities: [{id, label, visibleTo: "all"|[memberId], selected}],
//        notify, quietPings }
let cfg = {};
const members = new Map(); // memberId -> roster entry (as this viewer sees it)
const opps = new Map(); // opportunityId -> post (as this viewer sees it)
let selectedMins = 60;
// Post composer state: audience + how long the post stands.
let postAll = true;
const postSelected = new Set(); // memberIds, when postAll is false
let postGroup = null; // group name, when the selection came from a group untouched
let postMins = 240;
// Named friend groups — server-side (shared with Telegram), synced via the
// roster payload and "groups" events.
let myGroups = [];
const openGroupPickers = new Set(); // group names with the member picker expanded
let streamAbort = null;
let backoffMs = 1000;
let reconnectTimer = null;
const openPickers = new Set(); // activity ids with the visibility picker expanded

const DEFAULT_ACTIVITIES = [
  "get unstuck on a task",
  "help me escape a local minimum",
  "meditation",
  "coworking",
  "body doubling",
];

// --- helpers -------------------------------------------------------------------
const authHeaders = () => ({ Authorization: `Bearer ${cfg.deviceToken}` });
const api = (path, opts = {}) =>
  fetch(cfg.serverUrl + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers ?? {}) },
  });

const self = () => members.get(cfg.memberId);
const selfAvailable = () => !!self()?.available;
const friends = () =>
  [...members.values()]
    .filter((m) => m.memberId !== cfg.memberId)
    .sort((a, b) =>
      a.available !== b.available ? (a.available ? -1 : 1) : a.displayName.localeCompare(b.displayName),
    );

function remainingMin(entry) {
  if (!entry?.availableUntil) return 0;
  return Math.max(0, Math.round((new Date(entry.availableUntil) - Date.now()) / 60_000));
}

// "45 min" below two hours, "3h" above — posts can stand for a day.
function fmtLeft(iso) {
  const mins = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60_000));
  return mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins} min`;
}

function setConnected(on) {
  const dot = $("conn-dot");
  dot.className = `dot ${on ? "on" : "off"}`;
  dot.title = on ? "Connected" : "Reconnecting…";
}

async function persistActivities() {
  cfg = await window.huddle.storeSet({ activities: cfg.activities });
  syncPresets();
}

// Mirror the preset catalog to the server (debounced — visibility pickers
// fire one persist per click) so the Telegram bot's /up picker offers the
// same call types. Best-effort: the overlay never depends on it.
let presetSyncTimer = null;
function syncPresets() {
  if (!cfg.deviceToken || !cfg.serverUrl || !Array.isArray(cfg.activities)) return;
  clearTimeout(presetSyncTimer);
  presetSyncTimer = setTimeout(() => {
    api("/api/presence/presets", {
      method: "POST",
      body: JSON.stringify({
        presets: cfg.activities.map(({ label, visibleTo, visibleToGroups, durationMinutes }) => ({
          label,
          visibleTo,
          visibleToGroups,
          durationMinutes,
        })),
      }),
    }).catch(() => {});
  }, 800);
}

/** Take the server's catalog (edited from Telegram, or our own echo) as
 * truth, keeping local-only state — ids, ticked-state, offer minutes — for
 * labels that survive. Persists locally WITHOUT pushing back (no echo loop). */
async function adoptPresets(presets) {
  const byLabel = new Map(cfg.activities.map((a) => [a.label, a]));
  cfg.activities = presets.map((p) => {
    const prev = byLabel.get(p.label);
    return {
      id: prev?.id ?? crypto.randomUUID(),
      label: p.label,
      visibleTo: p.visibleTo,
      ...(p.visibleToGroups?.length ? { visibleToGroups: p.visibleToGroups } : {}),
      durationMinutes: p.durationMinutes,
      selected: prev?.selected ?? false,
      ...(prev?.minutes ? { minutes: prev.minutes } : {}),
    };
  });
  cfg = await window.huddle.storeSet({ activities: cfg.activities });
  renderActivityEditor();
  renderActivitySelect();
}

/** Boot-time preset sync, two-way: if the member has a server-side catalog
 * (possibly edited from Telegram while we were closed), adopt it; if the
 * server has never seen one, ours becomes it. */
async function reconcilePresets() {
  if (!cfg.deviceToken || !cfg.serverUrl) return;
  try {
    const res = await api("/api/presence/presets");
    if (!res.ok) return;
    const body = await res.json();
    if (body.customized) await adoptPresets(body.presets);
    else syncPresets();
  } catch {
    /* offline — the next edit or launch retries */
  }
}

/** Chips for signal activities: "eval project (~5min call)". The offer
 * countdown lives in the row above ("Available for N min" / "N min left"),
 * so a chip only shows its own countdown when it expires meaningfully
 * earlier than the overall signal. */
function activityChips(activities, overallEntry) {
  const overall = remainingMin(overallEntry);
  const wrap = document.createElement("div");
  wrap.className = "chips";
  for (const a of activities) {
    const c = document.createElement("span");
    c.className = "chip";
    const left = remainingMin(a);
    c.textContent =
      a.label +
      (a.durationMinutes ? ` (~${a.durationMinutes}min call)` : "") +
      (overall - left > 1 ? ` · ${left}min left` : "");
    wrap.append(c);
  }
  return wrap;
}

// --- toasts -------------------------------------------------------------------
function toast(message, ms = 8000, action) {
  const el = document.createElement("div");
  el.className = "toast";
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = message;
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el.append(msg);
  if (action) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      el.remove();
      action.onAction();
    });
    el.append(btn);
  }
  el.append(when);
  el.addEventListener("click", () => el.remove());
  $("toasts").append(el);
  setTimeout(() => el.remove(), ms);
}

// --- activities editor -------------------------------------------------------
// Group names on an activity that still exist (deleted groups linger in the
// stored list harmlessly — the server resolves them to nobody).
const liveGroupNames = (a) =>
  (a.visibleToGroups ?? []).filter((n) =>
    myGroups.some((g) => g.name.toLowerCase() === n.toLowerCase()),
  );

function visChipText(a) {
  if (a.visibleTo === "all") return "everyone";
  const groups = liveGroupNames(a);
  const parts = [];
  if (groups.length) parts.push(groups.length === 1 ? groups[0] : `${groups.length} groups`);
  if (a.visibleTo.length)
    parts.push(
      a.visibleTo.length === 1
        ? members.get(a.visibleTo[0])?.displayName ?? "1 friend"
        : `${a.visibleTo.length} friends`,
    );
  return parts.join(" + ") || "nobody";
}

/** Composer: tick what you're up for this session, each with its own time. */
function renderActivitySelect() {
  const wrap = $("act-select");
  wrap.replaceChildren(
    ...cfg.activities.map((a) => {
      const row = document.createElement("div");
      row.className = "act-row";
      const main = document.createElement("div");
      main.className = "act-main";
      const label = document.createElement("label");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = !!a.selected;
      // Two independent times: how long the OFFER stands, and how long the
      // call itself would be ("next 60 min I'm up for a 5-min call on X").
      const mins = document.createElement("input");
      mins.type = "number";
      mins.className = "act-min";
      mins.min = 15;
      mins.max = 180;
      mins.placeholder = "offer";
      mins.title = "How long this offer stands, in minutes (defaults to the window above)";
      mins.value = a.minutes ?? "";
      mins.hidden = !a.selected;
      mins.addEventListener("input", () => {
        const v = Number(mins.value);
        a.minutes = mins.value && v >= 15 && v <= 180 ? Math.round(v) : undefined;
        persistActivities();
      });
      const dur = document.createElement("input");
      dur.type = "number";
      dur.className = "act-min";
      dur.min = 1;
      dur.max = 240;
      dur.placeholder = "~call";
      dur.title = "Expected call length in minutes (optional — shown to friends)";
      dur.value = a.durationMinutes ?? "";
      dur.hidden = !a.selected;
      dur.addEventListener("input", () => {
        const v = Number(dur.value);
        a.durationMinutes = dur.value && v >= 1 && v <= 240 ? Math.round(v) : undefined;
        persistActivities();
      });
      check.addEventListener("change", () => {
        a.selected = check.checked;
        mins.hidden = !a.selected;
        dur.hidden = !a.selected;
        persistActivities();
      });
      label.append(check, document.createTextNode(a.label));
      main.append(label, mins, dur);
      row.append(main);
      return row;
    }),
  );
}

/** Settings: manage the preset catalog — add, remove, visibility. */
function renderActivityEditor() {
  const wrap = $("act-editor");
  wrap.replaceChildren(
    ...cfg.activities.map((a) => {
      const row = document.createElement("div");
      row.className = "act-row";

      const main = document.createElement("div");
      main.className = "act-main";

      const label = document.createElement("label");
      label.append(document.createTextNode(a.label));

      const vis = document.createElement("button");
      vis.className = `vis-chip${a.visibleTo === "all" ? "" : " limited"}`;
      vis.textContent = visChipText(a);
      vis.title = "Who can see this call type";
      vis.addEventListener("click", () => {
        openPickers.has(a.id) ? openPickers.delete(a.id) : openPickers.add(a.id);
        renderActivityEditor();
      });

      const del = document.createElement("button");
      del.className = "act-del";
      del.textContent = "×";
      del.title = "Remove";
      del.addEventListener("click", () => {
        cfg.activities = cfg.activities.filter((x) => x.id !== a.id);
        openPickers.delete(a.id);
        persistActivities();
        renderActivityEditor();
      });

      main.append(label, vis, del);
      row.append(main);
      if (openPickers.has(a.id)) row.append(visPicker(a));
      return row;
    }),
  );
}

function visPicker(a) {
  const box = document.createElement("div");
  box.className = "vis-picker";

  const everyone = document.createElement("label");
  const evCheck = document.createElement("input");
  evCheck.type = "checkbox";
  evCheck.checked = a.visibleTo === "all";
  evCheck.addEventListener("change", () => {
    a.visibleTo = evCheck.checked ? "all" : [];
    if (evCheck.checked) delete a.visibleToGroups;
    persistActivities();
    renderActivityEditor();
  });
  everyone.append(evCheck, document.createTextNode("everyone"));
  box.append(everyone);

  if (a.visibleTo !== "all") {
    // Groups first — a LIVE reference: whoever is in the group when someone
    // looks, sees it (edit "close" later and visibility follows).
    for (const g of myGroups) {
      const row = document.createElement("label");
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = (a.visibleToGroups ?? []).includes(g.name);
      c.addEventListener("change", () => {
        const rest = (a.visibleToGroups ?? []).filter((n) => n !== g.name);
        a.visibleToGroups = c.checked ? [...rest, g.name] : rest;
        if (!a.visibleToGroups.length) delete a.visibleToGroups;
        persistActivities();
        renderActivityEditor();
      });
      const name = document.createElement("span");
      name.textContent = `${g.name} `;
      const count = document.createElement("span");
      count.className = "muted small";
      count.textContent = `group · ${g.memberIds.length}`;
      row.append(c, name, count);
      box.append(row);
    }
    const others = friends();
    if (!others.length && !myGroups.length) {
      const none = document.createElement("span");
      none.className = "muted";
      none.textContent = "no friends yet";
      box.append(none);
    }
    for (const f of others) {
      const row = document.createElement("label");
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = a.visibleTo.includes(f.memberId);
      c.addEventListener("change", () => {
        a.visibleTo = c.checked
          ? [...a.visibleTo, f.memberId]
          : a.visibleTo.filter((id) => id !== f.memberId);
        persistActivities();
        renderActivityEditor();
      });
      row.append(c, document.createTextNode(f.displayName));
      box.append(row);
    }
  }
  return box;
}

function addActivity() {
  const input = $("act-add-input");
  const label = input.value.trim();
  if (!label) return;
  cfg.activities.push({ id: crypto.randomUUID(), label, visibleTo: "all", selected: true });
  input.value = "";
  persistActivities();
  renderActivityEditor();
}

// --- coordination opportunities ------------------------------------------------
function oppAudienceText(o) {
  if (o.audience === "all") return "to everyone";
  if (o.audienceLabel) return `to ${o.audienceLabel}`;
  if (!o.audience) return "";
  return o.audience.length === 1
    ? `to ${members.get(o.audience[0])?.displayName ?? "1 friend"}`
    : `to ${o.audience.length} friends`;
}

/** Main view: active posts addressed to you (or by you), newest first. */
function renderOpps() {
  const list = $("opps");
  const items = [...opps.values()].sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));
  $("opps-head").hidden = !items.length;
  list.hidden = !items.length;
  list.replaceChildren(
    ...items.map((o) => {
      const row = document.createElement("div");
      row.className = "opp";

      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = o.mine ? "You" : o.from.displayName;
      const text = document.createElement("div");
      text.className = "opp-text";
      text.textContent = o.text;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${fmtLeft(o.expiresAt)} left${o.mine ? ` · ${oppAudienceText(o)}` : ""}`;
      info.append(name, text, meta);

      const actions = document.createElement("div");
      actions.className = "actions";
      if (o.mine) {
        const del = document.createElement("button");
        del.className = "act-del";
        del.textContent = "×";
        del.title = "Take this post down";
        del.addEventListener("click", () => removePost(o.id));
        actions.append(del);
      } else {
        const ping = document.createElement("button");
        ping.textContent = "👋";
        ping.title = `Interested — ping ${o.from.displayName}`;
        ping.addEventListener("click", () => sendPing(o.from));
        actions.append(ping);
      }

      row.append(info, actions);
      return row;
    }),
  );
}

/** Composer: everyone, a saved group in one tap, or tick specific friends.
 * A group chip pre-ticks its members; touching any checkbox afterwards turns
 * the selection ad-hoc again (the post then says "N friends", not the name). */
function renderPostAudience() {
  const box = $("post-audience");
  box.replaceChildren();

  const everyone = document.createElement("label");
  const evCheck = document.createElement("input");
  evCheck.type = "checkbox";
  evCheck.checked = postAll;
  evCheck.addEventListener("change", () => {
    postAll = evCheck.checked;
    renderPostAudience();
  });
  everyone.append(evCheck, document.createTextNode("everyone"));
  box.append(everyone);

  if (!postAll) {
    if (myGroups.length) {
      const chips = document.createElement("div");
      chips.className = "chips group-chips";
      for (const g of myGroups) {
        const chip = document.createElement("button");
        chip.className = `vis-chip${postGroup === g.name ? " limited" : ""}`;
        chip.textContent = `${g.name} (${g.memberIds.length})`;
        chip.title = g.memberIds.length
          ? `Post to your "${g.name}" group`
          : `"${g.name}" has no members yet (settings → Friend groups)`;
        chip.addEventListener("click", () => {
          if (postGroup === g.name) {
            postGroup = null; // back to ad-hoc, keep the ticks
          } else {
            postGroup = g.name;
            postSelected.clear();
            for (const id of g.memberIds) postSelected.add(id);
          }
          renderPostAudience();
        });
        chips.append(chip);
      }
      box.append(chips);
    }
    const others = friends();
    if (!others.length) {
      const none = document.createElement("span");
      none.className = "muted";
      none.textContent = "no friends yet";
      box.append(none);
    }
    for (const f of others) {
      const row = document.createElement("label");
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = postSelected.has(f.memberId);
      c.addEventListener("change", () => {
        postGroup = null; // hand-edited → no longer exactly the group
        c.checked ? postSelected.add(f.memberId) : postSelected.delete(f.memberId);
        renderPostAudience();
      });
      row.append(c, document.createTextNode(f.displayName));
      box.append(row);
    }
  }
}

// --- rendering -------------------------------------------------------------------
function render() {
  const me = self();
  const on = selfAvailable();
  $("self-off").hidden = on;
  $("self-on").hidden = !on;
  if (on) {
    $("self-countdown").textContent = `Available for ${remainingMin(me)} min`;
    $("self-acts-display").replaceChildren(...activityChips(me.activities ?? [], me).children);
    const note = me.note ?? "";
    $("self-note-display").textContent = note;
    $("self-note-display").hidden = !note;
  }

  const roster = $("roster");
  const others = friends();
  roster.replaceChildren(
    ...others.map((m) => {
      const row = document.createElement("div");
      row.className = `member${m.available ? " available" : ""}`;

      const dot = document.createElement("span");
      dot.className = `dot ${m.available ? "on" : ""}`;

      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = m.displayName;
      info.append(name);
      if (m.available) {
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = `${remainingMin(m)} min left${m.note ? ` · ${m.note}` : ""}`;
        info.append(meta);
        if (m.activities?.length) info.append(activityChips(m.activities, m));
      }

      const actions = document.createElement("div");
      actions.className = "actions";
      if (m.available) {
        const call = document.createElement("button");
        call.className = "call-btn";
        call.textContent = "call";
        call.title = `Ask ${m.displayName} to hop on a call`;
        call.addEventListener("click", () => sendCallRequest(m));
        actions.append(call);
      }
      const ping = document.createElement("button");
      ping.textContent = "👋";
      ping.title = `Ping ${m.displayName}`;
      ping.addEventListener("click", () => sendPing(m));
      actions.append(ping);

      row.append(dot, info, actions);
      return row;
    }),
  );
  $("roster-empty").hidden = others.length > 0;
  renderOpps();

  const availableCount = [...members.values()].filter((m) => m.available).length;
  window.huddle.setTrayState(
    on,
    availableCount ? `Huddle — ${availableCount} up for a call` : "Huddle — nobody signaled",
  );
}

// Tick countdowns; locally expire lapsed signals so the UI doesn't wait for
// the server sweep.
setInterval(() => {
  let anyAvailable = false;
  for (const m of members.values()) {
    if (!m.available) continue;
    if (m.availableUntil && Date.now() >= new Date(m.availableUntil)) {
      m.available = false;
      delete m.availableUntil;
      delete m.note;
      delete m.activities;
    } else {
      // Individually lapsed call types drop out before the signal does.
      if (m.activities) {
        m.activities = m.activities.filter((a) => Date.now() < new Date(a.availableUntil));
        if (!m.activities.length) delete m.activities;
      }
      anyAvailable = true;
    }
  }
  // Lapsed posts drop out locally — the server deletes them silently.
  for (const [id, o] of opps) if (Date.now() >= new Date(o.expiresAt)) opps.delete(id);
  // Countdown chips are visible whenever anyone is on — keep them ticking.
  if (anyAvailable || selfAvailable() || opps.size) render();
}, 1000);

// --- stream ------------------------------------------------------------------------
function applyUpdate(entry) {
  const prev = members.get(entry.memberId);
  // Notify only on someone-else's OFF→ON transition while we're also available.
  if (
    entry.available &&
    !prev?.available &&
    entry.memberId !== cfg.memberId &&
    selfAvailable() &&
    cfg.notify !== false
  ) {
    window.huddle.notify(
      `${entry.displayName} is up for a call`,
      `${remainingMin(entry)} min${
        entry.activities?.length ? ` — ${entry.activities.map((a) => a.label).join(", ")}` : ""
      }`,
      false,
    );
  }
  members.set(entry.memberId, entry);
}

async function connectStream() {
  clearTimeout(reconnectTimer);
  streamAbort?.abort();
  streamAbort = new AbortController();
  try {
    const res = await fetch(cfg.serverUrl + "/api/presence/stream", {
      headers: authHeaders(),
      signal: streamAbort.signal,
    });
    if (res.status === 401) return signOut("This device was unpaired. Join again.");
    if (!res.ok) throw new Error(`stream ${res.status}`);
    setConnected(true);
    backoffMs = 1000;
    console.log("huddle: stream connected");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue;
        const payload = JSON.parse(data);
        if (event === "roster") {
          members.clear();
          for (const m of payload.members) members.set(m.memberId, m);
          opps.clear();
          for (const o of payload.opportunities ?? []) opps.set(o.id, o);
          myGroups = payload.groups ?? [];
          if (payload.callLink) cfg.callLink = payload.callLink;
          render();
          renderActivityEditor(); // visibility pickers list friends from the roster
          if (!$("settings").hidden) renderGroupsEditor();
        } else if (event === "groups") {
          // Edited elsewhere (Telegram /groups, another device) — or our echo.
          myGroups = payload.groups ?? [];
          if (!$("settings").hidden) renderGroupsEditor();
          if (!$("post").hidden) renderPostAudience();
          if (!$("manage").hidden) renderActivityEditor(); // vis pickers list groups
        } else if (event === "opportunity") {
          opps.set(payload.opportunity.id, payload.opportunity);
          render();
          if (!payload.opportunity.mine) {
            toast(`📣 ${payload.opportunity.from.displayName}: ${payload.opportunity.text}`, 20_000);
            window.huddle.notify(
              `📣 ${payload.opportunity.from.displayName} posted`,
              payload.opportunity.text,
              cfg.quietPings === true,
            );
          }
        } else if (event === "opportunity-removed") {
          opps.delete(payload.id);
          render();
        } else if (event === "update") {
          applyUpdate(payload.member);
          render();
          if (!$("settings").hidden) renderFriendsEditor(); // a new friend may have appeared
        } else if (event === "friend-removed") {
          // Mutual removal — drop them from our roster immediately.
          members.delete(payload.memberId);
          render();
          if (!$("settings").hidden) renderFriendsEditor();
        } else if (event === "presets") {
          // Catalog edited elsewhere (Telegram /presets, another device) —
          // or the echo of our own push; adoptPresets is idempotent for that.
          adoptPresets(payload.presets);
        } else if (event === "ping-from") {
          toast(`👋 ${payload.from.displayName} pinged you`, 20_000);
          window.huddle.notify(
            `👋 ${payload.from.displayName} pinged you`,
            "They want your attention on Huddle.",
            cfg.quietPings === true,
          );
        } else if (event === "call-request") {
          const from = payload.from;
          toast(`📞 ${from.displayName} wants to call`, 60_000, {
            label: "Accept",
            onAction: () => acceptCallRequest(from),
          });
          window.huddle.notify(
            `📞 ${from.displayName} wants to call`,
            "Open Huddle to accept.",
            cfg.quietPings === true,
          );
        } else if (event === "call-start") {
          // Both sides get this once the callee accepts. The room opens in
          // the browser, and the toast keeps the link copyable (e.g. to
          // reshare over Messenger).
          toast(`📞 Call with ${payload.peer.displayName} — opening room…`, 30_000, {
            label: "Copy link",
            onAction: () => {
              window.huddle.copyText(payload.url);
              toast("Link copied.", 4_000);
            },
          });
          window.huddle.openExternal(payload.url);
        }
      }
    }
    throw new Error("stream ended");
  } catch (err) {
    if (streamAbort.signal.aborted) return;
    setConnected(false);
    reconnectTimer = setTimeout(connectStream, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}

// --- actions --------------------------------------------------------------------------
function chosenMinutes() {
  const custom = Number($("custom-mins").value);
  if ($("custom-mins").value && custom >= 15 && custom <= 180) return Math.round(custom);
  return selectedMins;
}

async function setAvailable(mins) {
  const note = $("self-note").value.trim();
  const activities = cfg.activities
    .filter((a) => a.selected)
    .map(({ label, visibleTo, visibleToGroups, minutes, durationMinutes }) => ({
      label,
      visibleTo,
      visibleToGroups,
      minutes,
      durationMinutes,
    }));
  const res = await api("/api/presence/signal", {
    method: "POST",
    body: JSON.stringify({ windowMinutes: mins, ...(note ? { note } : {}), activities }),
  });
  if (!res.ok) return toast("Couldn't set your signal — are you online?");
  applyUpdate(await res.json());
  render();
  if (!$("interests").hidden) showView("main"); // composer's job is done
}

async function clearSignal() {
  await api("/api/presence/signal", { method: "DELETE" });
  const me = self();
  if (me) {
    me.available = false;
    delete me.availableUntil;
    delete me.note;
    delete me.activities;
  }
  render();
}

async function sendCallRequest(m) {
  // Your own room link (e.g. Google Meet, settings → My call link) rides
  // along; the server only falls back to minting a room without one.
  const res = await api("/api/presence/call-request", {
    method: "POST",
    body: JSON.stringify({
      toMemberId: m.memberId,
      ...(cfg.myCallLink ? { link: cfg.myCallLink } : {}),
    }),
  });
  if (res.status === 429) return toast(`You just asked ${m.displayName} — give it a moment.`);
  if (!res.ok) return toast("Call request failed.");
  const { delivered } = await res.json();
  toast(
    delivered
      ? `📞 Asked ${m.displayName} — waiting for them to accept`
      : `${m.displayName}'s overlay is offline right now`,
    20_000,
  );
}

async function acceptCallRequest(from) {
  const res = await api("/api/presence/call-accept", {
    method: "POST",
    body: JSON.stringify({ fromMemberId: from.memberId }),
  });
  if (!res.ok) return toast("That request expired — ask them to call again.");
  // Our own room-opening arrives via the call-start event; nothing else to do.
}

async function sendPing(m) {
  const res = await api("/api/presence/ping", {
    method: "POST",
    body: JSON.stringify({ toMemberId: m.memberId }),
  });
  if (res.status === 429) return toast(`Easy — you just pinged ${m.displayName}.`);
  if (!res.ok) return toast("Ping failed.");
  const { delivered } = await res.json();
  toast(delivered ? `👋 Pinged ${m.displayName}` : `${m.displayName}'s overlay is offline right now`);
}

function chosenPostMinutes() {
  const custom = Number($("post-custom-mins").value);
  if ($("post-custom-mins").value && custom >= 15 && custom <= 1440) return Math.round(custom);
  return postMins;
}

async function sendPost() {
  const text = $("post-text").value.trim();
  if (!text) return toast("Write what you're proposing first.");
  // A group posts by NAME (the server resolves it and keeps the label on
  // the post); a hand-picked set posts as ids.
  const audience = postAll ? "all" : postGroup ? { group: postGroup } : [...postSelected];
  if (Array.isArray(audience) && !audience.length)
    return toast("Pick at least one friend to post to.");
  const res = await api("/api/presence/opportunities", {
    method: "POST",
    body: JSON.stringify({ text, audience, minutes: chosenPostMinutes() }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return toast(
      body.error === "too_many"
        ? "You already have 5 open posts — take one down first."
        : body.error === "too_fast"
          ? "Easy — you just posted. Give it a moment."
          : body.error === "empty_audience" || body.error === "unknown_group"
            ? "That group is empty or gone — pick friends directly."
            : "Couldn't post — are you online?",
    );
  }
  const { opportunity } = await res.json();
  opps.set(opportunity.id, opportunity);
  $("post-text").value = "";
  showView("main");
  render();
  toast("📣 Posted.", 5_000);
}

async function removePost(id) {
  const res = await api(`/api/presence/opportunities/${id}`, { method: "DELETE" });
  if (!res.ok) return toast("Couldn't take that post down.");
  opps.delete(id);
  render();
}

async function signOut(message) {
  streamAbort?.abort();
  clearTimeout(reconnectTimer);
  members.clear();
  cfg = await window.huddle.storeSet({ deviceToken: null, memberId: null });
  showView("onboarding");
  showOnboardingError(message);
}

// --- window sizing ---------------------------------------------------------------------
// The window hugs its content: header + whichever view is active. A
// MutationObserver keeps it honest through roster changes, editors, chips.
const VIEWS = ["onboarding", "main", "settings", "interests", "manage", "post"];
let fitScheduled = false;
function fitWindow() {
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    const active = VIEWS.map($).find((el) => !el.hidden);
    if (!active) return;
    // +2 for the panel border; toasts are absolute and don't count.
    window.huddle.resizeWindow($("drag-bar").offsetHeight + active.scrollHeight + 2);
  });
}
new MutationObserver(fitWindow).observe($("panel"), {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["hidden", "style"],
});

// --- views ---------------------------------------------------------------------------
function showView(name) {
  for (const v of VIEWS) $(v).hidden = v !== name;
  fitWindow();
}

function openInterests() {
  if (!cfg.deviceToken) return;
  renderActivitySelect();
  showView("interests");
}

function openManage() {
  if (!cfg.deviceToken) return;
  renderActivityEditor();
  showView("manage");
}

function openPost() {
  if (!cfg.deviceToken) return;
  renderPostAudience();
  showView("post");
}

function showOnboardingError(error) {
  $("ob-server").value = cfg.serverUrl || "https://ai.nicohillbrand.com";
  const err = $("ob-error");
  err.textContent = error ?? "";
  err.hidden = !error;
}

async function join() {
  const serverUrl = $("ob-server").value.trim().replace(/\/+$/, "");
  const inviteCode = $("ob-code").value.trim();
  const displayName = $("ob-name").value.trim();
  const err = $("ob-error");
  err.hidden = true;
  if (!serverUrl || !inviteCode || !displayName) {
    err.textContent = "All fields are required.";
    err.hidden = false;
    return;
  }
  try {
    const res = await fetch(`${serverUrl}/api/presence/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inviteCode, displayName }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
    cfg = await window.huddle.storeSet({
      serverUrl,
      deviceToken: body.deviceToken,
      memberId: body.memberId,
      displayName: body.displayName,
      callLink: body.callLink || null,
    });
    showView("main");
    connectStream();
    reconcilePresets();
  } catch (e) {
    err.textContent = e.message === "Failed to fetch" ? "Can't reach that server." : e.message;
    err.hidden = false;
  }
}

// --- settings ---------------------------------------------------------------------------
let recordingShortcut = false;

let telegramLinked = false;

async function refreshFriendCode() {
  $("friend-code").textContent = "…";
  const res = await api("/api/presence/me").catch(() => null);
  if (!res?.ok) {
    $("friend-code").textContent = "offline";
    $("telegram-setting").hidden = true;
    return;
  }
  const me = await res.json();
  $("friend-code").textContent = me.friendCode;
  // Telegram section only exists when the server has a bot configured.
  $("telegram-setting").hidden = !me.telegram?.available;
  telegramLinked = !!me.telegram?.linked;
  $("telegram-btn").textContent = telegramLinked ? "Linked ✓ — unlink" : "Link Telegram…";
}

async function toggleTelegram() {
  if (telegramLinked) {
    const res = await api("/api/presence/telegram", { method: "DELETE" });
    if (!res.ok) return toast("Couldn't unlink.");
    telegramLinked = false;
    $("telegram-btn").textContent = "Link Telegram…";
    toast("Telegram unlinked.");
    return;
  }
  const res = await api("/api/presence/telegram/link-code", { method: "POST" });
  if (!res.ok) return toast("The server has no Telegram bot configured.");
  const { url } = await res.json();
  window.huddle.openExternal(url);
  toast("Telegram opened — press Start there, then reopen settings.", 12_000);
}

/** Settings: your friends, each removable (removal is mutual). */
function renderFriendsEditor() {
  $("friends-editor").replaceChildren(
    ...friends().map((f) => {
      const row = document.createElement("div");
      row.className = "act-row";
      const main = document.createElement("div");
      main.className = "act-main";
      const label = document.createElement("label");
      label.append(document.createTextNode(f.displayName));
      const del = document.createElement("button");
      del.className = "act-del";
      del.textContent = "×";
      del.title = `Remove ${f.displayName} (they lose you too)`;
      del.addEventListener("click", async () => {
        const res = await api(`/api/presence/friends/${f.memberId}`, { method: "DELETE" });
        if (!res.ok) return toast("Couldn't remove them.");
        members.delete(f.memberId);
        render();
        renderFriendsEditor();
      });
      main.append(label, del);
      row.append(main);
      return row;
    }),
  );
}

/** Settings: named friend groups — one-tap post audiences, shared with the
 * Telegram bot (/groups). The chip opens a member picker; edits save live. */
function renderGroupsEditor() {
  $("groups-editor").replaceChildren(
    ...myGroups.map((g) => {
      const row = document.createElement("div");
      row.className = "act-row";
      const main = document.createElement("div");
      main.className = "act-main";

      const label = document.createElement("label");
      label.append(document.createTextNode(g.name));

      const pick = document.createElement("button");
      pick.className = `vis-chip${g.memberIds.length ? " limited" : ""}`;
      pick.textContent = `${g.memberIds.length} friend${g.memberIds.length === 1 ? "" : "s"}`;
      pick.title = "Who's in this group";
      pick.addEventListener("click", () => {
        openGroupPickers.has(g.name) ? openGroupPickers.delete(g.name) : openGroupPickers.add(g.name);
        renderGroupsEditor();
      });

      const del = document.createElement("button");
      del.className = "act-del";
      del.textContent = "×";
      del.title = `Delete the "${g.name}" group (friends stay friends)`;
      del.addEventListener("click", async () => {
        const res = await api(`/api/presence/groups/${encodeURIComponent(g.name)}`, {
          method: "DELETE",
        });
        if (!res.ok) return toast("Couldn't delete that group.");
        myGroups = (await res.json()).groups;
        openGroupPickers.delete(g.name);
        renderGroupsEditor();
      });

      main.append(label, pick, del);
      row.append(main);
      if (openGroupPickers.has(g.name)) row.append(groupPicker(g));
      return row;
    }),
  );
}

function groupPicker(g) {
  const box = document.createElement("div");
  box.className = "vis-picker";
  const others = friends();
  if (!others.length) {
    const none = document.createElement("span");
    none.className = "muted";
    none.textContent = "no friends yet";
    box.append(none);
  }
  for (const f of others) {
    const row = document.createElement("label");
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = g.memberIds.includes(f.memberId);
    c.addEventListener("change", () => {
      const ids = c.checked
        ? [...g.memberIds, f.memberId]
        : g.memberIds.filter((id) => id !== f.memberId);
      saveGroup(g.name, ids);
    });
    row.append(c, document.createTextNode(f.displayName));
    box.append(row);
  }
  return box;
}

async function saveGroup(name, memberIds) {
  const res = await api("/api/presence/groups", {
    method: "POST",
    body: JSON.stringify({ name, memberIds }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return toast(
      body.error === "bad_name"
        ? 'Group names: up to 24 characters, no "," or ":", not "all"/"everyone".'
        : body.error === "too_many"
          ? "You already have 20 groups — delete one first."
          : "Couldn't save that group.",
    );
  }
  myGroups = (await res.json()).groups;
  renderGroupsEditor();
}

async function addGroup() {
  const input = $("group-add-input");
  const name = input.value.trim();
  if (!name) return;
  await saveGroup(name, []);
  input.value = "";
  // Open the new group's picker right away so members get ticked in.
  const created = myGroups.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (created) {
    openGroupPickers.add(created.name);
    renderGroupsEditor();
  }
}

async function addFriend() {
  const input = $("friend-add-input");
  const code = input.value.trim();
  if (!code) return;
  const res = await api("/api/presence/friends", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return toast(
      body.error === "self_code"
        ? "That's your own code."
        : "No one has that code — it may have been rotated.",
    );
  }
  const { friend } = await res.json();
  input.value = "";
  toast(`You and ${friend.displayName} are now friends.`, 6_000);
  // Their roster entry arrives via the stream; the editor refreshes with it.
}

async function openSettings() {
  renderActivityEditor();
  renderFriendsEditor();
  renderGroupsEditor();
  refreshFriendCode();
  $("shortcut-btn").textContent = await window.huddle.getShortcut();
  $("set-call-link").value = cfg.myCallLink || "";
  $("set-quiet-pings").checked = cfg.quietPings === true;
  $("set-notify").checked = cfg.notify !== false;
  $("set-autostart").checked = await window.huddle.getAutostart();
  $("shortcut-error").hidden = true;
  showView("settings");
}

function accelFromEvent(e) {
  const key = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push("CommandOrControl");
  if (e.metaKey) parts.push("Super");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (!parts.length) return null; // require at least one modifier
  let main = key;
  if (key === " ") main = "Space";
  else if (key.startsWith("Arrow")) main = key.slice(5);
  else if (key.length === 1) main = key.toUpperCase();
  parts.push(main);
  return parts.join("+");
}

function startShortcutRecording() {
  recordingShortcut = true;
  const btn = $("shortcut-btn");
  btn.classList.add("recording");
  btn.textContent = "press keys…";

  const onKey = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return stop();
    const accel = accelFromEvent(e);
    if (!accel) return; // modifier-only or missing modifier — keep listening
    const result = await window.huddle.setShortcut(accel);
    const err = $("shortcut-error");
    if (result.ok) {
      err.hidden = true;
    } else {
      err.textContent = result.error;
      err.hidden = false;
    }
    stop();
  };
  const stop = async () => {
    recordingShortcut = false;
    document.removeEventListener("keydown", onKey, true);
    btn.classList.remove("recording");
    btn.textContent = await window.huddle.getShortcut();
  };
  document.addEventListener("keydown", onKey, true);
}

// --- wiring ------------------------------------------------------------------------------
$("ob-join").addEventListener("click", join);
$("onboarding").addEventListener("keydown", (e) => e.key === "Enter" && join());

for (const btn of document.querySelectorAll("#interests .preset")) {
  btn.addEventListener("click", () => {
    selectedMins = Number(btn.dataset.mins);
    $("custom-mins").value = "";
    $("custom-mins").classList.remove("selected");
    document
      .querySelectorAll("#interests .preset")
      .forEach((b) => b.classList.toggle("selected", b === btn));
  });
}
$("custom-mins").addEventListener("input", () => {
  const has = !!$("custom-mins").value;
  $("custom-mins").classList.toggle("selected", has);
  document.querySelectorAll("#interests .preset").forEach((b) => b.classList.toggle("selected", false));
  if (!has)
    document
      .querySelector(`#interests .preset[data-mins="${selectedMins}"]`)
      ?.classList.add("selected");
});

// Post composer: same preset pattern, its own state (posts can stand for 24h).
for (const btn of document.querySelectorAll("#post .preset")) {
  btn.addEventListener("click", () => {
    postMins = Number(btn.dataset.mins);
    $("post-custom-mins").value = "";
    $("post-custom-mins").classList.remove("selected");
    document.querySelectorAll("#post .preset").forEach((b) => b.classList.toggle("selected", b === btn));
  });
}
$("post-custom-mins").addEventListener("input", () => {
  const has = !!$("post-custom-mins").value;
  $("post-custom-mins").classList.toggle("selected", has);
  document.querySelectorAll("#post .preset").forEach((b) => b.classList.toggle("selected", false));
  if (!has)
    document.querySelector(`#post .preset[data-mins="${postMins}"]`)?.classList.add("selected");
});

$("act-add-btn").addEventListener("click", addActivity);
$("act-add-input").addEventListener("keydown", (e) => e.key === "Enter" && addActivity());

$("self-on-btn").addEventListener("click", () => setAvailable(chosenMinutes()));
$("self-extend-btn").addEventListener("click", () => setAvailable(chosenMinutes()));
$("self-clear-btn").addEventListener("click", clearSignal);

$("min-btn").addEventListener("click", () => window.huddle.minimizeWindow());
// Close-to-tray, like other tray apps: quitting lives in the tray menu.
$("close-btn").addEventListener("click", () => window.huddle.hideWindow());
$("settings-btn").addEventListener("click", () => {
  if (cfg.deviceToken) openSettings();
});
$("settings-back").addEventListener("click", () => showView("main"));
// + toggles the composer open/closed.
$("interests-btn").addEventListener("click", () => {
  $("interests").hidden ? openInterests() : showView("main");
});
$("interests-back").addEventListener("click", () => showView("main"));
// 📣 toggles the post composer the same way.
$("post-btn").addEventListener("click", () => {
  $("post").hidden ? openPost() : showView("main");
});
$("post-back").addEventListener("click", () => showView("main"));
$("post-send").addEventListener("click", sendPost);
$("post-text").addEventListener("keydown", (e) => e.key === "Enter" && sendPost());
$("self-off").addEventListener("click", openManage);
$("open-manage").addEventListener("click", openManage);
$("manage-back").addEventListener("click", () => showView("main"));
$("signout-btn").addEventListener("click", () => signOut());
$("shortcut-btn").addEventListener("click", startShortcutRecording);
$("friend-code").addEventListener("click", () => {
  const code = $("friend-code").textContent;
  if (!code || code === "…" || code === "offline") return;
  window.huddle.copyText(code);
  toast("Friend code copied.", 4_000);
});
$("friend-code-rotate").addEventListener("click", async () => {
  const res = await api("/api/presence/me/rotate-code", { method: "POST" });
  if (!res.ok) return toast("Couldn't rotate your code.");
  $("friend-code").textContent = (await res.json()).friendCode;
  toast("New code — the old one no longer works.", 6_000);
});
$("friend-add-btn").addEventListener("click", addFriend);
$("friend-add-input").addEventListener("keydown", (e) => e.key === "Enter" && addFriend());
$("group-add-btn").addEventListener("click", addGroup);
$("group-add-input").addEventListener("keydown", (e) => e.key === "Enter" && addGroup());
$("telegram-btn").addEventListener("click", toggleTelegram);
$("set-call-link").addEventListener("change", async (e) => {
  const v = e.target.value.trim();
  if (v && !/^https:\/\/\S+$/.test(v)) {
    toast("Call link must be an https:// URL.");
    e.target.value = cfg.myCallLink || "";
    return;
  }
  cfg = await window.huddle.storeSet({ myCallLink: v || null });
});
$("set-quiet-pings").addEventListener("change", async (e) => {
  cfg = await window.huddle.storeSet({ quietPings: e.target.checked });
});
$("set-notify").addEventListener("change", async (e) => {
  cfg = await window.huddle.storeSet({ notify: e.target.checked });
});
$("set-autostart").addEventListener("change", async (e) => {
  e.target.checked = await window.huddle.setAutostart(e.target.checked);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || recordingShortcut) return;
  if (!$("settings").hidden || !$("interests").hidden || !$("manage").hidden || !$("post").hidden)
    showView("main");
  else window.huddle.hideWindow();
});

window.huddle.onQuickAvailable((mins) => cfg.deviceToken && setAvailable(mins));
window.huddle.onQuickClear(() => cfg.deviceToken && clearSignal());

// --- boot ----------------------------------------------------------------------------------
(async () => {
  cfg = await window.huddle.storeGet();
  if (!Array.isArray(cfg.activities)) {
    cfg = await window.huddle.storeSet({
      activities: DEFAULT_ACTIVITIES.map((label) => ({
        id: crypto.randomUUID(),
        label,
        visibleTo: "all",
        selected: false,
      })),
    });
  }
  if (cfg.deviceToken && cfg.serverUrl) {
    showView("main");
    connectStream();
    reconcilePresets();
  } else {
    showView("onboarding");
    showOnboardingError();
  }
})();
