import JSZip from "jszip";

const PROXY_PREFIX = "/crisp-api";
const PER_PAGE_CONV = 50;
const BULK_DELAY_MS = 250;

const $ = (id) => document.getElementById(id);

const els = {
  loadConversations: $("loadConversations"),
  pickExportFolder: $("pickExportFolder"),
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
  folderMeta: $("folderMeta"),
};

/** From server `/api/config` (WEBSITE_ID in .env). */
let websiteId = "";

/** @type {Array<Record<string, unknown>>} */
let conversations = [];
/** Full list before applying the "skip already exported" filter. */
let allConversations = [];
/** @type {any} */
let exportDirHandle = null;
let exportDirScanned = false;
/** @type {Set<string>} */
let existingExportSessionIds = new Set();
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

async function scanExportFolderForSessionIds(dirHandle, { maxDepth = 3, _depth = 0 } = {}) {
  /** @type {Set<string>} */
  const found = new Set();

  for await (const entry of dirHandle.entries()) {
    const [name, handle] = entry;
    if (!name || typeof name !== "string") continue;
    if (!handle) continue;

    // Recurse into subfolders (eg. if you extracted a ZIP into a folder).
    if (handle.kind === "directory") {
      if (_depth >= maxDepth) continue;
      const nested = await scanExportFolderForSessionIds(handle, { maxDepth, _depth: _depth + 1 });
      for (const sid of nested) found.add(sid);
      continue;
    }

    if (handle.kind !== "file") continue;
    if (!name.endsWith(".json")) continue;

    try {
      const file = await handle.getFile();
      const text = await file.text();
      const obj = JSON.parse(text);
      // We only care about our export format, but we detect it by the presence of `session_id`.
      const sid = obj?.session_id ?? obj?.crisp_session_id;
      if (typeof sid === "string" && sid.trim()) found.add(sid.trim());
    } catch {
      // Ignore invalid/partial files.
    }
  }

  return found;
}

async function ensureExportFolderScanned() {
  if (!exportDirHandle) return;
  if (exportDirScanned) return;
  exportDirScanned = true; // avoid parallel scans
  els.folderMeta.textContent = "Scanning export folder…";
  existingExportSessionIds = await scanExportFolderForSessionIds(exportDirHandle);
  els.folderMeta.textContent = `Found ${existingExportSessionIds.size} exported session(s) in folder.`;
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

function assistantEmailFromMessages(crispMessages) {
  for (const m of crispMessages) {
    if (m?.from !== "operator") continue;
    const u = m.user && typeof m.user === "object" ? m.user : {};
    const candidates = [
      u.email,
      u.user_email,
      u.assistant_email,
      u.username,
      u.user_id,
      u.id,
    ];
    for (const c of candidates) {
      if (typeof c !== "string") continue;
      const s = c.trim();
      if (s && s.includes("@")) return s;
    }
  }
  return "";
}

function assistantNameFromMessages(crispMessages) {
  for (const m of crispMessages) {
    if (m?.from !== "operator") continue;
    const u = m.user && typeof m.user === "object" ? m.user : {};
    const name = maybeString(u?.nickname) || maybeString(u?.username) || maybeString(u?.name);
    if (name) return name;
  }
  return "";
}

function assistantIdentifierFromMessages(crispMessages) {
  const email = assistantEmailFromMessages(crispMessages);
  if (email) return email;
  return assistantNameFromMessages(crispMessages) || "";
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

const CONTENT_MAX_CHARS = 5000;

function normalizeWhitespace(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function messageRole(m) {
  return m?.from === "user" ? "user" : "assistant";
}

function messageContentToString(m) {
  const raw = m?.content;
  if (typeof raw === "string") return normalizeWhitespace(raw);
  try {
    if (raw == null) return "";
    return normalizeWhitespace(JSON.stringify(raw));
  } catch {
    return "";
  }
}

function maybeString(v) {
  if (typeof v !== "string") return "";
  return v.trim();
}

function userIdentifierFromUser(u) {
  const email = maybeString(u?.email);
  if (email && email.includes("@")) return email;

  const possibleName = maybeString(u?.nickname) || maybeString(u?.username) || maybeString(u?.name);
  if (possibleName) return possibleName;

  const id = maybeString(u?.user_id) || maybeString(u?.id);
  return id || "";
}

function messageSenderIdentifier(m) {
  const u = m?.user && typeof m.user === "object" ? m.user : {};
  return userIdentifierFromUser(u) || null;
}

function toTruncatedContent(s) {
  if (!s) return "";
  if (s.length <= CONTENT_MAX_CHARS) return s;
  return `${s.slice(0, CONTENT_MAX_CHARS)}…`;
}

function toAgentMessages(crispMessages) {
  const out = [];
  for (const m of crispMessages) {
    const content = toTruncatedContent(messageContentToString(m));
    if (!content) continue;
    out.push({
      role: messageRole(m),
      content,
      sender: messageSenderIdentifier(m),
    });
  }
  return out;
}

function computeSummaryAndTags(agentMessages) {
  const normalizedUserContents = new Map(); // content -> count
  for (const msg of agentMessages) {
    if (msg.role !== "user") continue;
    const k = msg.content;
    normalizedUserContents.set(k, (normalizedUserContents.get(k) ?? 0) + 1);
  }

  const tags = [];
  if ([...normalizedUserContents.values()].some((n) => n >= 2)) tags.push("duplicate");
  if (agentMessages.length && agentMessages[agentMessages.length - 1].role === "user") tags.push("no-response");

  const firstUser = agentMessages.find((m) => m.role === "user");
  const first = firstUser ?? agentMessages[0];
  const summary = first ? toTruncatedContent(first.content).slice(0, 240) : "";

  return { summary, tags };
}

function buildExportPayload({
  sessionIndex,
  email,
  assistantEmail,
  crispSessionId,
  crispMessages,
}) {
  const agentMessages = toAgentMessages(crispMessages);
  const { summary, tags } = computeSummaryAndTags(agentMessages);
  const assistantIdentifier = assistantEmail || assistantIdentifierFromMessages(crispMessages);
  return {
    session_index: sessionIndex,
    visitor_email: email || null,
    session_id: crispSessionId || null,
    assistant_identifier: assistantIdentifier || null,
    assistant_email: assistantEmail || null,
    summary,
    tags,
    messages: agentMessages,
  };
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

els.pickExportFolder.addEventListener("click", async () => {
  clearStatus();
  if (typeof window.showDirectoryPicker !== "function") {
    showStatus("Folder picker not supported in this browser (use Chrome/Edge).", true);
    return;
  }
  try {
    els.pickExportFolder.disabled = true;
    exportDirHandle = await window.showDirectoryPicker();
    exportDirScanned = false;
    existingExportSessionIds = new Set();
    await ensureExportFolderScanned();
    // Re-load conversations so the dropdown reflects the skipped ones.
    els.loadConversations.click();
  } catch (e) {
    showStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    els.pickExportFolder.disabled = false;
  }
});

els.loadConversations.addEventListener("click", async () => {
  clearStatus();
  if (!websiteId) {
    showStatus("WEBSITE_ID is missing in server .env.", true);
    return;
  }
  try {
    els.loadConversations.disabled = true;
    allConversations = await fetchAllConversations(websiteId);
    conversations = allConversations;
    let skipped = 0;
    if (exportDirHandle) {
      await ensureExportFolderScanned();
      if (existingExportSessionIds.size > 0) {
        const before = conversations.length;
        conversations = conversations.filter((c) => !existingExportSessionIds.has(c.session_id));
        skipped = before - conversations.length;
      }
    }
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
    placeholder.textContent = skipped > 0 ? `Select a conversation (${conversations.length} new, ${skipped} skipped)…` : `Select a conversation (${conversations.length} loaded)…`;
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
    els.convMeta.textContent =
      skipped > 0
        ? `${conversations.length} new conversation(s) loaded (${skipped} skipped).`
        : `${conversations.length} conversations loaded.`;
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
    const assistantEmail = assistantEmailFromMessages(messages);
    const assistantIdentifier = assistantEmail || assistantIdentifierFromMessages(messages);
    els.convMeta.textContent =
      sessionIndex != null
        ? `#${sessionIndex} — ${email || "(no email)"} / ${assistantIdentifier || "(no assistant identifier)"} — ${messages.length} message(s).`
        : `${messages.length} message(s).`;
    const payload = buildExportPayload({
      sessionIndex,
      email,
      assistantEmail: assistantEmailFromMessages(messages),
      crispSessionId: sessionId,
      crispMessages: messages,
    });
    els.preview.textContent = JSON.stringify(payload, null, 2).slice(0, 12000);
    if (JSON.stringify(payload, null, 2).length > 12000) {
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
  const payload = buildExportPayload({
    sessionIndex: currentSessionIndex,
    email,
    assistantEmail: currentMessages ? assistantEmailFromMessages(currentMessages) : "",
    crispSessionId: currentSessionId,
    crispMessages: currentMessages,
  });
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
      const payload = buildExportPayload({
        sessionIndex,
        email,
        assistantEmail: assistantEmailFromMessages(messages),
        crispSessionId: sid,
        crispMessages: messages,
      });
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
