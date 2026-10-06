// ============================================================
// Geração da primeira mensagem de abordagem da IA.
// Usa a Anthropic (Claude) se ANTHROPIC_API_KEY estiver definida;
// caso contrário, cai num template local (grátis, sem chamada externa).
// ============================================================

function firstName(full) {
  return (full || '').trim().split(/\s+/)[0] || 'você';
}

function templateMessage(lead) {
  const nome = firstName(lead.name);
  const interesse = lead.interest && lead.interest !== '—' ? lead.interest : null;
  if (interesse) {
    return `Oi, ${nome}! Aqui é da G-HEX 🙂 Vi que você se interessou em "${interesse}". Posso te mandar mais detalhes (fotos, valor, condições) ou já separar um horário de visita?`;
  }
  return `Oi, ${nome}! Aqui é da G-HEX 🙂 Recebemos seu contato e já estou por aqui pra te ajudar a encontrar o imóvel ideal. Pode me contar rapidinho o que você está buscando (tipo, região, faixa de valor)?`;
}

async function generateFirstContactMessage(lead) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return templateMessage(lead);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 180,
        messages: [{
          role: 'user',
          content:
            `Escreva, em português do Brasil, UMA mensagem curta (máx. 2 frases) de primeiro contato via WhatsApp de uma corretora da imobiliária G-HEX para um lead que acabou de deixar os dados num formulário. ` +
            `Nome do lead: ${lead.name}. Interesse informado: ${lead.interest || 'não informado'}. Origem: ${lead.platform || lead.source || 'não informada'}. ` +
            `Tom: humano, caloroso, consultivo — NUNCA robótico, NUNCA genérico de spam, sem emojis em excesso (no máx. 1), sem link, sem preço. ` +
            `Termine com uma pergunta aberta que convide resposta. Devolva só a mensagem, sem aspas, sem explicação.`,
        }],
      }),
    });
    if (!res.ok) return templateMessage(lead);
    const data = await res.json();
    const text = data?.content?.[0]?.text?.trim();
    return text && text.length > 0 ? text : templateMessage(lead);
  } catch {
    return templateMessage(lead);
  }
}

module.exports = { generateFirstContactMessage };
