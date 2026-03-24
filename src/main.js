import JSZip from "jszip";

const PROXY_PREFIX = "/crisp-api";
const PER_PAGE_CONV = 50;
const BULK_DELAY_MS = 250;

const $ = (id) => document.getElementById(id);

const els = {
  loadConversations: $("loadConversations"),
  conversationSelect: $("conversationSelect"),
  convMeta: $("convMeta"),
  fetchMessages: $("fetchMessages"),
  downloadOne: $("downloadOne"),
  preview: $("preview"),
  bulkExport: $("bulkExport"),
  progressWrap: $("progressWrap"),
  progressBar: $("progressBar"),
  progressText: $("progressText"),
  statusPanel: $("statusPanel"),
  statusMsg: $("statusMsg"),
};

/** From server `/api/config` (WEBSITE_ID in .env). */
let websiteId = "";

/** @type {Array<Record<string, unknown>>} */
let conversations = [];
/** @type {unknown[] | null} */
let currentMessages = null;
/** @type {string | null} */
let currentSessionId = null;
/** @type {number | null} */
let currentSessionIndex = null;

async function loadWebsiteConfig() {
  const res = await fetch("/api/config", { credentials: "omit" });
  if (!res.ok) {
    throw new Error("Could not load /api/config — restart Vite (npm run dev).");
  }
  const data = await res.json();
  websiteId = String(data.websiteId ?? "").trim();
}

function showStatus(msg, isError) {
  els.statusPanel.hidden = false;
  els.statusPanel.classList.toggle("error", !!isError);
  els.statusMsg.textContent = msg;
}

function clearStatus() {
  els.statusPanel.hidden = true;
  els.statusMsg.textContent = "";
}

/**
 * @param {string} path - e.g. /v1/website/{wid}/conversations/1?per_page=50
 */
async function crispGet(path) {
  const url = `${PROXY_PREFIX}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const reason = body?.reason || body?.message || res.statusText;
    throw new Error(`HTTP ${res.status}: ${reason}`);
  }
  if (body.error === true) {
    throw new Error(body.reason || "Crisp API error");
  }
  return body;
}

function visitorEmail(c) {
  const meta = c.meta && typeof c.meta === "object" ? c.meta : {};
  const e = meta.email;
  return e ? String(e).trim() : "";
}

/** Dropdown: `[index] email` only (no session_id). */
function conversationLabel(c) {
  const idx = c.session_index;
  const email = visitorEmail(c);
  const idxPart = typeof idx === "number" ? `[${idx}] ` : "";
  return `${idxPart}${email || "(no email)"}`;
}

/** Filename segment: `042-user_example_com` (index + sanitized email). */
function exportFileBase(c, sessionIndex, total) {
  const idxStr = sessionIndex > 0 ? formatExportIndex(sessionIndex, total) : "";
  const emailPart = sanitizeFilenamePart(visitorEmail(c) || "no-email");
  return idxStr ? `${idxStr}-${emailPart}` : emailPart;
}

/**
 * Paginates 50 per page. Assigns 1-based session_index in reverse API order:
 * first conversation returned (newest / page 1) gets the highest number; the last gets 1.
 * @returns {Promise<Array<Record<string, unknown> & { session_index: number }>>}
 */
async function fetchAllConversations(wid) {
  const raw = [];
  let page = 1;
  for (;;) {
    const path = `/v1/website/${encodeURIComponent(wid)}/conversations/${page}?per_page=${PER_PAGE_CONV}`;
    const body = await crispGet(path);
    const chunk = Array.isArray(body.data) ? body.data : [];
    for (const c of chunk) {
      raw.push({ ...c });
    }
    if (chunk.length < PER_PAGE_CONV) break;
    page += 1;
  }
  const n = raw.length;
  return raw.map((c, i) => ({ ...c, session_index: n - i }));
}

/**
 * @param {string} wid
 * @param {string} sessionId
 * @returns {Promise<unknown[]>}
 */
async function fetchAllMessages(wid, sessionId) {
  const byFp = new Map();
  let timestampBefore = null;

  for (;;) {
    let path = `/v1/website/${encodeURIComponent(wid)}/conversation/${encodeURIComponent(sessionId)}/messages`;
    if (timestampBefore != null) {
      path += `?timestamp_before=${timestampBefore}`;
    }
    const body = await crispGet(path);
    const batch = Array.isArray(body.data) ? body.data : [];
    if (batch.length === 0) break;

    for (const m of batch) {
      const fp = m.fingerprint;
      if (fp) byFp.set(fp, m);
      else byFp.set(`__${byFp.size}`, m);
    }

    const tsList = batch.map((m) => Number(m.timestamp)).filter((n) => !Number.isNaN(n));
    if (tsList.length === 0) break;
    const oldest = Math.min(...tsList);
    const nextBefore = oldest - 1;
    if (nextBefore === timestampBefore) break;
    timestampBefore = nextBefore;
  }

  const merged = [...byFp.values()];
  merged.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  return merged;
}

function setProgress(frac, text) {
  els.progressWrap.hidden = false;
  els.progressBar.style.setProperty("--p", `${Math.round(frac * 100)}%`);
  els.progressText.textContent = text;
}

function hideProgress() {
  els.progressWrap.hidden = true;
  els.progressBar.style.setProperty("--p", "0%");
  els.progressText.textContent = "";
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function sanitizeFilenamePart(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

/** Zero-padded index for stable sort in exports (min width 3). */
function formatExportIndex(n, totalCount) {
  const w = Math.max(3, String(Math.max(totalCount, 1)).length);
  return String(n).padStart(w, "0");
}

els.loadConversations.addEventListener("click", async () => {
  clearStatus();
  if (!websiteId) {
    showStatus("WEBSITE_ID is missing in server .env.", true);
    return;
  }
  try {
    els.loadConversations.disabled = true;
    conversations = await fetchAllConversations(websiteId);
    els.conversationSelect.innerHTML = "";
    if (conversations.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No conversations returned";
      els.conversationSelect.appendChild(opt);
      els.conversationSelect.disabled = true;
      els.fetchMessages.disabled = true;
      els.downloadOne.disabled = true;
      els.bulkExport.disabled = true;
      showStatus("API returned zero conversations (check filters or website).", false);
      return;
    }
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = `Select a conversation (${conversations.length} loaded)…`;
    els.conversationSelect.appendChild(placeholder);
    for (const c of conversations) {
      const opt = document.createElement("option");
      opt.value = c.session_id;
      opt.textContent = conversationLabel(c);
      els.conversationSelect.appendChild(opt);
    }
    els.conversationSelect.disabled = false;
    els.fetchMessages.disabled = false;
    els.bulkExport.disabled = false;
    currentMessages = null;
    currentSessionId = null;
    currentSessionIndex = null;
    els.downloadOne.disabled = true;
    els.preview.hidden = true;
    els.convMeta.textContent = `${conversations.length} conversations loaded.`;
    showStatus("Conversations loaded.", false);
  } catch (e) {
    showStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    els.loadConversations.disabled = false;
  }
});

els.conversationSelect.addEventListener("change", () => {
  currentMessages = null;
  currentSessionId = null;
  currentSessionIndex = null;
  els.downloadOne.disabled = true;
  els.preview.hidden = true;
  els.convMeta.textContent = "";
});

els.fetchMessages.addEventListener("click", async () => {
  clearStatus();
  const sessionId = els.conversationSelect.value;
  if (!websiteId || !sessionId) {
    showStatus("Select a conversation.", true);
    return;
  }
  try {
    els.fetchMessages.disabled = true;
    const messages = await fetchAllMessages(websiteId, sessionId);
    const conv = conversations.find((c) => c.session_id === sessionId);
    const sessionIndex = typeof conv?.session_index === "number" ? conv.session_index : null;
    currentMessages = messages;
    currentSessionId = sessionId;
    currentSessionIndex = sessionIndex;
    els.downloadOne.disabled = messages.length === 0;
    const email = visitorEmail(conv ?? {});
    els.convMeta.textContent =
      sessionIndex != null
        ? `#${sessionIndex} — ${email || "(no email)"} — ${messages.length} message(s).`
        : `${messages.length} message(s).`;
    const previewObj = {
      session_index: sessionIndex,
      visitor_email: email || null,
      website_id: websiteId,
      message_count: messages.length,
      messages,
    };
    els.preview.textContent = JSON.stringify(previewObj, null, 2).slice(0, 12000);
    if (JSON.stringify(previewObj, null, 2).length > 12000) {
      els.preview.textContent += "\n… (truncated in preview)";
    }
    els.preview.hidden = false;
    showStatus("Messages loaded.", false);
  } catch (e) {
    showStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    els.fetchMessages.disabled = false;
  }
});

els.downloadOne.addEventListener("click", () => {
  if (!currentSessionId || currentMessages == null) return;
  const total = conversations.length;
  const idx = currentSessionIndex ?? 0;
  const conv = conversations.find((c) => c.session_id === currentSessionId);
  const email = visitorEmail(conv ?? {});
  const payload = {
    session_index: currentSessionIndex,
    visitor_email: email || null,
    website_id: websiteId,
    session_id: currentSessionId,
    exported_at: new Date().toISOString(),
    message_count: currentMessages.length,
    messages: currentMessages,
  };
  const base = conv ? exportFileBase(conv, idx, total) : `${formatExportIndex(idx, total)}-export`;
  const name = `crisp-messages-${base}.json`;
  downloadJson(name, payload);
});

els.bulkExport.addEventListener("click", async () => {
  clearStatus();
  if (!websiteId || conversations.length === 0) {
    showStatus("Load conversations first.", true);
    return;
  }
  const zip = new JSZip();
  const folder = zip.folder("crisp-conversations");
  if (!folder) {
    showStatus("Could not create ZIP folder.", true);
    return;
  }

  try {
    els.bulkExport.disabled = true;
    const total = conversations.length;
    for (let i = 0; i < total; i++) {
      const c = conversations[i];
      const sid = c.session_id;
      const sessionIndex = typeof c.session_index === "number" ? c.session_index : i + 1;
      const email = visitorEmail(c);
      setProgress(
        (i + 0.25) / total,
        `Fetching #${sessionIndex} (${i + 1} / ${total}) ${email || "(no email)"}…`
      );
      const messages = await fetchAllMessages(websiteId, sid);
      const payload = {
        session_index: sessionIndex,
        visitor_email: email || null,
        website_id: websiteId,
        session_id: sid,
        exported_at: new Date().toISOString(),
        message_count: messages.length,
        messages,
      };
      const fileBase = exportFileBase(c, sessionIndex, total);
      folder.file(`${fileBase}.json`, JSON.stringify(payload, null, 2));
      setProgress((i + 1) / total, `Done #${sessionIndex} (${i + 1} / ${total})`);
      if (i < total - 1) await new Promise((r) => setTimeout(r, BULK_DELAY_MS));
    }
    setProgress(1, "Building ZIP…");
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `crisp-all-conversations-${sanitizeFilenamePart(websiteId)}-${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    hideProgress();
    showStatus("ZIP download started.", false);
  } catch (e) {
    hideProgress();
    showStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    els.bulkExport.disabled = false;
  }
});

(async function boot() {
  try {
    await loadWebsiteConfig();
    if (!websiteId) {
      showStatus("Set WEBSITE_ID in .env and restart the proxy.", true);
    }
  } catch (e) {
    showStatus(e instanceof Error ? e.message : String(e), true);
  }
})();
