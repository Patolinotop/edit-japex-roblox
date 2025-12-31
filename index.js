import axios from "axios";

// ================= CONFIG =================
const GROUP_ID = process.env.GROUP_ID;              // somente números
const COOKIE = process.env.ROBLOSECURITY;           // cookie válido (conta com permissão)
const WEBHOOK = process.env.DISCORD_WEBHOOK;        // webhook discord

// ===== MODO TESTE/DEBUG =====
// Objetivo: descobrir por que o accept não aparece nos logs.
// - NÃO depende de texto específico.
// - Mostra/manda no webhook os logs novos detectados.
// - Se detectar um log que pareça "aceitação", exila o actor (teste).
const INTERVALO = 4000;          // 4s
const AUDIT_LIMIT = 100;         // 1..100
const LOOKBACK_MS = 2 * 60_000;  // 2 minutos (tolerância para atraso do audit-log)
const DEBUG_WEBHOOK_LOGS = true; // manda logs pro webhook (cuidado com spam)
const DEBUG_CONSOLE = true;      // imprime no console
// ===========================

// ================= VALIDAÇÕES =================
function assertEnv() {
  const faltando = [];
  if (!GROUP_ID) faltando.push("GROUP_ID");
  if (!COOKIE) faltando.push("ROBLOSECURITY");
  if (!WEBHOOK) faltando.push("DISCORD_WEBHOOK");
  if (faltando.length) {
    console.error("❌ Variáveis faltando:", faltando.join(", "));
    process.exit(1);
  }
  if (!/^\d+$/.test(String(GROUP_ID))) {
    console.error("❌ GROUP_ID inválido (use apenas números):", GROUP_ID);
    process.exit(1);
  }
  if (!COOKIE.includes("_|WARNING:")) {
    console.error("⚠️ Seu ROBLOSECURITY não parece completo. Verifique se colou inteiro (incluindo _|WARNING:...|). Mesmo assim vou tentar.");
  }
}
// ==============================================

let csrfToken = null;

// baseline: só processa logs com created >= baselineTime
let baselineTime = 0;

// evita duplicação
const seenIds = new Set();

// ================= CLIENT ROBLOX =================
const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RobloxBotDebug/1.0",
    "Referer": `https://www.roblox.com/groups/${GROUP_ID}/audit-log`
  },
  timeout: 20_000,
  validateStatus: () => true
});
// ================================================

// ================= HELPERS =================
function clip(str, n = 700) {
  if (str == null) return "";
  const s = typeof str === "string" ? str : JSON.stringify(str);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function discord(content) {
  try {
    await axios.post(WEBHOOK, { content: clip(content, 1800) });
  } catch (e) {
    console.error("❌ Falha ao enviar webhook:", e.response?.status || e.message);
  }
}

function log(...args) {
  if (DEBUG_CONSOLE) console.log(...args);
}
// =========================================

// ================= CSRF =================
async function refreshCSRF() {
  const res = await roblox.post("https://auth.roblox.com/v2/logout");
  csrfToken = res.headers["x-csrf-token"];
  if (csrfToken) roblox.defaults.headers["X-CSRF-TOKEN"] = csrfToken;
  log("🔑 CSRF status:", res.status, "token?", Boolean(csrfToken));
}
// =========================================

// ================= AÇÕES =================
async function exilarUsuario(userId) {
  if (!csrfToken) await refreshCSRF();

  let res = await roblox.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`);

  if (res.status === 403) {
    await refreshCSRF();
    res = await roblox.delete(`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`);
  }

  log("🔨 Exílio retornou:", res.status, clip(res.data, 400));
  return res.status;
}
// =========================================

// ================= AUDIT LOG (REST) =================
async function getAuditPage(limit = AUDIT_LIMIT, cursor = "") {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
  const url = `https://groups.roblox.com/v1/groups/${GROUP_ID}/audit-log?limit=${safeLimit}&sortOrder=Desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

  const res = await roblox.get(url);

  if (res.status !== 200) {
    log("❌ Audit status", res.status);
    log("↳ body:", clip(res.data));
    return { data: [], nextPageCursor: null, raw: res.data, status: res.status };
  }

  // Estrutura típica: { previousPageCursor, nextPageCursor, data: [...] }
  const data = res.data?.data || [];
  return {
    data,
    nextPageCursor: res.data?.nextPageCursor ?? null,
    raw: res.data,
    status: res.status
  };
}

async function getLatestAudit(limit = AUDIT_LIMIT) {
  // 1 página é suficiente para os mais recentes
  return await getAuditPage(limit);
}
// =========================================

// ================= DETECÇÃO (DEBUG) =================
function looksLikeAccept(logItem) {
  // NÃO confiar em actionType porque varia.
  const desc = (logItem.description || "").toLowerCase();

  // PT
  const pt = desc.includes("aceitou") && (desc.includes("pedido") || desc.includes("solicita"));

  // EN
  const en = (desc.includes("accepted") || desc.includes("approve")) && (desc.includes("join") || desc.includes("request"));

  // fallback: alguns audit logs usam um campo actionType
  const at = String(logItem.actionType || "").toLowerCase();
  const atMatch = at.includes("join") && (at.includes("accept") || at.includes("approve"));

  return pt || en || atMatch;
}

function formatLogLine(item) {
  const when = item.created || item.createdAt || "(sem created)";
  const actor = item.actor?.username ? `${item.actor.username} (${item.actor.userId})` : "(sem actor)";
  const actionType = item.actionType || "(sem actionType)";
  const desc = item.description || "(sem description)";
  return `• [${when}] ${actor} | ${actionType}\n  ${desc}`;
}
// =========================================

// ================= MONITOR =================
async function monitorar() {
  const page = await getLatestAudit(AUDIT_LIMIT);

  if (page.status !== 200) {
    // já logado dentro
    return;
  }

  const items = page.data;
  if (!Array.isArray(items) || items.length === 0) {
    log("ℹ️ Audit vazio ou sem data[]");
    if (DEBUG_WEBHOOK_LOGS) await discord("ℹ️ Audit vazio ou sem data[] (bot não recebeu logs).\nSe você acabou de aceitar alguém, pode ser que o Roblox esteja atrasando o audit-log.");
    return;
  }

  // Filtra itens realmente novos: created >= baselineTime - LOOKBACK_MS
  const cutoff = baselineTime ? (baselineTime - LOOKBACK_MS) : 0;

  const novos = [];
  for (const it of items) {
    const id = it.id || `${it.created}-${it.actor?.userId}-${it.description}`;
    if (seenIds.has(id)) continue;

    const createdMs = Date.parse(it.created || "") || 0;

    // Só considerar depois do baseline (com lookback)
    if (cutoff && createdMs && createdMs < cutoff) continue;

    seenIds.add(id);
    novos.push(it);
  }

  if (novos.length === 0) {
    log("… sem logs novos");
    return;
  }

  // Ordena do mais antigo para o mais novo
  novos.sort((a, b) => (Date.parse(a.created || "") || 0) - (Date.parse(b.created || "") || 0));

  // Debug: manda um resumo
  const resumo = novos.slice(-8).map(formatLogLine).join("\n");
  log("🧾 Logs novos detectados:\n" + resumo);
  if (DEBUG_WEBHOOK_LOGS) await discord("🧾 Logs novos detectados:\n" + resumo);

  // Se algum parecer aceitação, pune (TESTE)
  for (const it of novos) {
    if (!looksLikeAccept(it)) continue;

    const actorId = it.actor?.userId;
    const actorName = it.actor?.username || "(sem nome)";

    if (!actorId) {
      log("⚠️ Log parece accept, mas não tem actor.userId:", clip(it));
      continue;
    }

    log("🚨 ACCEPT DETECTADO (heurística)", actorName, actorId);
    await discord(`🚨 ACCEPT DETECTADO (heurística)\nExecutor: **${actorName}** (${actorId})\nAção: ${it.description || it.actionType || "(sem)"}`);

    const st = await exilarUsuario(actorId);
    await discord(`🔨 Tentativa de exílio: **${actorName}** (${actorId}) → status **${st}**`);
  }

  // Atualiza baselineTime para "agora" após ver novos logs
  baselineTime = Date.now();

  // limpeza do seen
  if (seenIds.size > 8000) {
    seenIds.clear();
  }
}
// =========================================

// ================= START =================
(async () => {
  assertEnv();
  await refreshCSRF();

  // baseline: captura os logs atuais e seta baseline para agora
  baselineTime = Date.now();

  const first = await getLatestAudit(10);
  if (first.status === 200) {
    const preview = (first.data || []).slice(0, 5).map(formatLogLine).join("\n");
    log("✅ Consegui puxar audit-log. Preview:\n" + preview);
    await discord("✅ Bot iniciou e puxou audit-log com sucesso. Preview (últimos 5):\n" + preview);
  } else {
    await discord("❌ Bot iniciou, mas não conseguiu puxar audit-log. Veja o console do Railway para o body do erro.");
  }

  log("🛡️ BOT DEBUG ATIVO – vai reportar logs novos e punir se parecer accept");
  setInterval(monitorar, INTERVALO);
})();
