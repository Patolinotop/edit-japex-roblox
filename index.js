import axios from "axios";

// ===== CONFIG =====
const GROUP_ID = process.env.GROUP_ID;
const ROBLOSECURITY = process.env.ROBLOSECURITY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

// ==================

// Cliente Roblox
const roblox = axios.create({
  baseURL: "https://groups.roblox.com",
  headers: {
    Cookie: `.ROBLOSECURITY=${ROBLOSECURITY}`,
    "Content-Type": "application/json"
  }
});

// Enviar relatório no Discord (EXATO como você pediu)
async function enviarRelatorio({
  responsavel,
  permissao,
  rebaixado,
  motivo
}) {
  const agora = new Date().toLocaleString("pt-BR");

  const mensagem = `**> 『 RELATÓRIO DE DEMISSÃO 』
> =================================
> ➩ Responsável: ${responsavel}
> ➩ Permissão concedida: ${permissao}
> =================================
> ➩ Militar rebaixado: ${rebaixado}
> ➩ Motivo: ${motivo}
> =================================
> ➩ Data e hora: ${agora}
> ➩ Comprovações: N/A
> =================================**`;

  await axios.post(DISCORD_WEBHOOK, {
    content: mensagem
  });
}

// ===== EXEMPLO DE USO =====
// (depois você liga isso à detecção real)
async function teste() {
  await enviarRelatorio({
    responsavel: "Sistema Anti-AcceptAll",
    permissao: "Administrador",
    rebaixado: "UsuarioExemplo123",
    motivo: "Aceitação em massa suspeita (Accept All)"
  });

  console.log("Relatório enviado para o Discord.");
}

// Loop simples só pra manter online no Railway
setInterval(() => {
  console.log("Bot online:", new Date().toISOString());
}, 1000 * 60);

// Teste inicial
teste();
