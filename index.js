import axios from "axios";

// ================= CONFIG =================
const GROUP_ID = process.env.GROUP_ID;              // ID do grupo (somente números)
const COOKIE = process.env.ROBLOSECURITY;           // Cookie da conta com permissão
const WEBHOOK = process.env.DISCORD_WEBHOOK;        // Webhook Discord

// ===== MODO TESTE FORÇADO =====
// QUALQUER pessoa que aceitar 1 pedido após o bot iniciar será expulsa
const INTERVALO = 3000;       // checa a cada 3s
const AUDIT_LIMIT = 50;       // quantos logs puxar
// =============================

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
}
// ==============================================

let csrfToken = null;
const logsProcessados = new Set();
const botStartTime = Date.now(); // <<< MUITO IMPORTANTE: só pune após iniciar

// ================= CLIENT ROBLOX =================
const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 RobloxBot",
    "Accept": "application/json",
    "Referer": `https://www.roblox.com/groups/${GROUP_ID}/audit-log`
  },
  validateStatus: () => true
});
// ================================================

// ================= CSRF =================
async function refreshCSRF() {
  const res = await roblox.post("https://auth.roblox.com/v2/logout");
  csrfToken = res.headers["x-csrf-token"];
  if (csrfToken) roblox.defaults.headers["X-CSRF-TOKEN"] = csrfToken;
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
  console.log("🔨 Exílio status:", res.status);
}

async function enviarRelatorio(username, desc) {
  const agora = new Date().toLocaleString("pt-BR");
  const msg = `**🧪 TESTE – ACCEPT DETECTADO**\n\n` +
              `👤 Executor: **${username}**\n` +
              `🧾 Ação: ${desc}\n` +
              `🕒 ${agora}`;
  await axios.post(WEBHOOK, { content: msg });
}
// =========================================

// ================= LOGS DO GRUPO =================
async function getGroupLogs() {
  const url = `https://groups.roblox.com/v1/groups/${GROUP_ID}/audit-log?limit=${AUDIT_LIMIT}&sortOrder=Desc`;
  const res = await roblox.get(url);

  if (res.status !== 200 || !res.data?.data) {
    console.error("Erro ao puxar logs", res.status, JSON.stringify(res.data));
    return [];
  }
  return res.data.data;
}
// ===============================================

// ================= MONITOR =================
async function monitorar() {
  const logs = await getGroupLogs();

  for (const log of logs) {
    if (!log?.id || logsProcessados.has(log.id)) continue;
    logsProcessados.add(log.id);

    const createdAt = new Date(log.created).getTime();
    if (createdAt < botStartTime) continue; // <<< só após iniciar

    const desc = (log.description || "").toLowerCase();
    const aceitouPT = desc.includes("aceitou o pedido");
    const aceitouEN = desc.includes("accepted") && desc.includes("join");
    if (!aceitouPT && !aceitouEN) continue;

    const userId = log.actor?.userId;
    const username = log.actor?.username;
    if (!userId || !username) continue;

    console.log("🚨 ACEITAÇÃO DETECTADA – TESTE", username);
    await enviarRelatorio(username, log.description);
    await exilarUsuario(userId); // <<< QUALQUER UM É EXPULSO (TESTE)
  }

  if (logsProcessados.size > 5000) logsProcessados.clear();
}
// =========================================

// ================= START =================
(async () => {
  assertEnv();
  await refreshCSRF();
  console.log("🛡️ BOT EM MODO TESTE – QUALQUER ACCEPT = EXÍLIO");
  setInterval(monitorar, INTERVALO);
})();
