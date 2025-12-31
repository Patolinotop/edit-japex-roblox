import axios from "axios";

// ================= CONFIG =================
const GROUP_ID = process.env.GROUP_ID;
const COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;

// TESTE: exila com 1 aceitação
const LIMITE = 1;            // 1 aceitação já pune
const JANELA_MS = 5000;      // 5 segundos
const INTERVALO = 4000;      // checa a cada 4s
// ==========================================

let csrfToken = null;
const historico = new Map(); // userId -> timestamps
const processados = new Set(); // evita processar o mesmo log

const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "User-Agent": "RobloxBot/1.0"
  },
  validateStatus: () => true
});

// ================= CSRF =================
async function refreshCSRF() {
  const res = await roblox.post("https://auth.roblox.com/v2/logout");
  csrfToken = res.headers["x-csrf-token"];
  roblox.defaults.headers["X-CSRF-TOKEN"] = csrfToken;
}

// ================= AÇÕES =================
async function exilarUsuario(userId) {
  if (!csrfToken) await refreshCSRF();

  let res = await roblox.delete(
    `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`
  );

  if (res.status === 403) {
    await refreshCSRF();
    await roblox.delete(
      `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`
    );
  }
}

async function enviarRelatorio(username, qtd) {
  const agora = new Date().toLocaleString("pt-BR");

  const msg = `**🚨 ANTI ACCEPT-ALL 🚨**\n\n` +
              `👤 Usuário: **${username}**\n` +
              `📌 Ações detectadas: **${qtd} aceitações**\n` +
              `⏱️ Janela: ${JANELA_MS / 1000}s\n` +
              `🕒 Data/Hora: ${agora}`;

  await axios.post(WEBHOOK, { content: msg });
}

// ================= LOGS =================
async function getGroupLogs(limit = 20) {
  const payload = {
    query: `
      query GroupAuditLog($groupId: ID!, $limit: Int!) {
        groupAuditLog(groupId: $groupId, limit: $limit) {
          data {
            id
            created
            actionType
            description
            actor {
              userId
              username
            }
          }
        }
      }
    `,
    variables: {
      groupId: GROUP_ID,
      limit
    }
  };

  const res = await roblox.post("https://groups.roblox.com/graphql", payload);

  if (res.status !== 200) {
    console.error("Erro ao puxar logs", res.status);
    return [];
  }

  return res.data.data.groupAuditLog.data;
}

// ================= MONITOR =================
async function monitorar() {
  try {
    const agora = Date.now();
    const logs = await getGroupLogs();

    for (const log of logs) {
      if (processados.has(log.id)) continue;
      processados.add(log.id);

      // aceitações de pedido (confere por texto, mais confiável)
      if (!log.description?.toLowerCase().includes("aceitou o pedido")) continue;

      const userId = log.actor.userId;
      const username = log.actor.username;
      const ts = new Date(log.created).getTime();

      if (!historico.has(userId)) historico.set(userId, []);

      historico.get(userId).push(ts);
      const recentes = historico
        .get(userId)
        .filter(t => agora - t <= JANELA_MS);

      historico.set(userId, recentes);

      if (recentes.length >= LIMITE) {
        console.log(`Punindo ${username} por accept-all`);
        await exilarUsuario(userId);
        await enviarRelatorio(username, recentes.length);
        historico.delete(userId);
      }
    }

  } catch (e) {
    console.error("Erro monitor:", e.message);
  }
}

// ================= START =================
(async () => {
  await refreshCSRF();
  console.log("🛡️ Anti Accept-All ATIVO (logs reais do grupo)");
  setInterval(monitorar, INTERVALO);
})();
