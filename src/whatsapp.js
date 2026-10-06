// ============================================================
// Integração com WhatsApp — agnóstica de provedor (formato padrão:
// Meta WhatsApp Cloud API). Nenhuma credencial fica no código: tudo
// vem de variáveis de ambiente (nunca expostas ao frontend/CRM).
// ============================================================

function getCreds() {
  const apiUrl = process.env.WHATSAPP_API_URL || '';
  const apiKey = process.env.WHATSAPP_API_KEY || '';
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  return { apiUrl, apiKey, phoneNumberId, configured: !!(apiUrl && apiKey && phoneNumberId) };
}

async function sendWhatsAppMessage(phone, message) {
  const { apiUrl, apiKey, phoneNumberId, configured } = getCreds();
  if (!configured) {
    return { ok: false, error: 'whatsapp_not_configured: defina WHATSAPP_API_URL, WHATSAPP_API_KEY e WHATSAPP_PHONE_NUMBER_ID.' };
  }
  try {
    const res = await fetch(`${apiUrl}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: message } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `provider_error_${res.status}: ${JSON.stringify(data)}` };
    return { ok: true, providerMessageId: data?.messages?.[0]?.id };
  } catch (err) {
    return { ok: false, error: `network_error: ${String(err)}` };
  }
}

// Interpreta o payload de webhook inbound da Meta Cloud API. Para outro
// provedor, reescreva só esta função (o resto do sistema não muda).
function parseInboundWhatsAppPayload(body) {
  try {
    const entry = body?.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg) return null;
    return { phone: msg.from, content: msg.text?.body ?? '[mensagem não-textual]', providerMessageId: msg.id };
  } catch {
    return null;
  }
}

module.exports = { sendWhatsAppMessage, parseInboundWhatsAppPayload, getCreds };
