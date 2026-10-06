# G-HEX — Backend próprio (Node.js + MongoDB, sem Supabase)

Você pediu para não usar Supabase. Este pacote substitui inteiramente
aquela arquitetura por um servidor Node.js comum (Express) que você
mesmo controla, com MongoDB como banco. É um servidor de verdade, sempre
ligado — o job de 2 minutos roda dentro dele mesmo (não é `setTimeout`
no navegador, nem depende da landing page ficar aberta).

Nada abaixo está deployado por mim — não tenho rede de saída nem conta
nos serviços externos (Render, MongoDB Atlas, Lovable). Todo o código
está completo, com sintaxe validada aqui no sandbox; os passos de deploy
abaixo são exatamente o que falta rodar do seu lado.

## Arquitetura

```
Landing page (gheximobiliaria.netlify.app)
        │  POST /api/leads
        ▼
Servidor Node.js (Render, sempre ligado)
        │  grava
        ▼
MongoDB Atlas (free tier)
        ▲  lê/grava (x-api-key)
        │
CRM G-HEX (ghex-crm.html, Configurações → Banco de dados)

Dentro do mesmo processo Node: a cada 30s, um job interno (src/dispatch.js)
verifica leads com 2+ minutos sem contato e aciona a IA no WhatsApp.
```

## 1) Criar o banco (MongoDB Atlas — gratuito)

1. Crie uma conta em mongodb.com/cloud/atlas (gratuito, sem cartão).
2. Crie um cluster **M0 (Free)**.
3. Em "Database Access", crie um usuário com senha.
4. Em "Network Access", libere `0.0.0.0/0` (qualquer IP) — o Render usa IPs variáveis.
5. Em "Database" → "Connect" → "Drivers", copie a connection string
   (algo como `mongodb+srv://usuario:senha@cluster0.xxxxx.mongodb.net/ghex`).
   Essa é a sua `MONGODB_URI`.

## 2) Subir o código para o GitHub (sem precisar saber Git)

1. Entre em github.com → "New repository" → dê um nome (ex: `ghex-backend`) → Create.
2. Na página do repositório vazio, clique em "uploading an existing file"
   e arraste **todos os arquivos deste pacote** (`package.json`, `server.js`,
   a pasta `src/`, o `.env.example`) → Commit changes.
   (Não suba um arquivo `.env` de verdade — ele não existe aqui, e mesmo
   que existisse, segredos nunca devem ir para o GitHub.)

## 3) Deploy no Render (gratuito)

1. Crie uma conta em render.com (pode entrar com a conta do GitHub).
2. "New +" → "Web Service" → conecte o repositório `ghex-backend` que você acabou de criar.
3. Configurações do serviço:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free (para testar) — veja o aviso sobre isso abaixo.
4. Em "Environment Variables", adicione (veja `.env.example` para a lista completa):
   - `MONGODB_URI` → a connection string do passo 1
   - `LANDING_PAGE_ORIGIN` → `https://gheximobiliaria.netlify.app`
   - `CRM_API_KEY` → qualquer string longa e aleatória seu (ex: gere em passwordsgenerator.net)
   - `LEAD_WEBHOOK_SECRET` → opcional, mesma ideia (camada simples anti-bot)
   - `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` → quando for ligar o WhatsApp de verdade (veja seção 6)
   - `ANTHROPIC_API_KEY` → opcional, para a 1ª mensagem ser gerada por IA real
5. Deploy. Ao terminar, o Render te dá uma URL fixa, algo como:
   `https://ghex-backend.onrender.com`
   Esse é o endereço do seu servidor — guarde-o, você vai usar nos passos 4 e 5.

### ⚠️ Aviso importante sobre o plano gratuito do Render

No plano **Free**, o Render "desliga" o serviço depois de 15 minutos sem
nenhuma requisição HTTP chegando — e só liga de novo quando alguém acessa.
Isso **pode atrasar o job de 2 minutos** se ninguém tiver visitado o
servidor há mais de 15 minutos (o lead chega, acorda o servidor via
`POST /api/leads`, mas se o processo for suspenso antes do minuto 2, o
job só roda de novo quando outra requisição chegar).

Duas soluções, as duas de graça:
- **Recomendada:** crie uma conta grátis em uptimerobot.com e configure um
  monitor HTTP batendo em `https://SEU-SERVICO.onrender.com/health` a cada
  5 minutos. Isso mantém o servidor sempre acordado.
- **Alternativa paga:** mude o Render para o plano "Starter" (~US$7/mês),
  que não suspende o serviço.

## 4) Conectar a landing page (Lovable)

Cole este prompt no chat do Lovable do projeto `gheximobiliaria`:

```
Quando o formulário "ATENDIMENTO EXCLUSIVO" for enviado, em vez do
comportamento atual, faça um fetch POST para:
https://SEU-SERVICO.onrender.com/api/leads

Content-Type: application/json

Body (mapeando os campos do formulário):
{
  "name": <valor de "Nome completo">,
  "phone": <valor de "WhatsApp", só dígitos ou com DDI>,
  "email": <valor de "E-mail">,
  "interest": `${<O que você procura?>} - ${<Tipo de imóvel>} - ${<Faixa de valor>} - ${<Cidade ou região de interesse>}${<campo aberto> ? " - " + <campo aberto> : ""}`,
  "source": "landing_page",
  "source_url": window.location.href,
  "utm_source": new URLSearchParams(window.location.search).get("utm_source"),
  "utm_medium": new URLSearchParams(window.location.search).get("utm_medium"),
  "utm_campaign": new URLSearchParams(window.location.search).get("utm_campaign"),
  "utm_content": new URLSearchParams(window.location.search).get("utm_content"),
  "utm_term": new URLSearchParams(window.location.search).get("utm_term")
}

Depois do envio, mostre a mensagem de sucesso que já existe na página se
a resposta vier com success:true, e um erro amigável se vier
success:false. Não exponha nenhuma chave de API no código — este
endpoint não exige autenticação do navegador.
```

## 5) Conectar o CRM (ghex-crm.html)

No CRM, vá em **Configurações → Banco de dados** e preencha:
- **URL do servidor:** `https://SEU-SERVICO.onrender.com`
- **Chave de API do CRM:** o mesmo valor que você colocou em `CRM_API_KEY` no Render

Clique em "Salvar e sincronizar". O Dashboard passa a mostrar "Conectado
ao backend" e os leads reais aparecem em Leads/Conversas/Origem/Relatórios.

## 6) Conectar o WhatsApp de verdade

O código já está pronto no formato da **Meta WhatsApp Cloud API**:
1. Crie um app em developers.facebook.com → produto "WhatsApp".
2. Pegue o `Phone number ID` → `WHATSAPP_PHONE_NUMBER_ID`.
3. Gere um token de acesso permanente (via System User) → `WHATSAPP_API_KEY`.
4. `WHATSAPP_API_URL` = `https://graph.facebook.com/v20.0`.
5. Em "Webhooks", aponte para `https://SEU-SERVICO.onrender.com/api/whatsapp/webhook`,
   defina um `WHATSAPP_VERIFY_TOKEN` (qualquer string sua) e confirme.
6. Salve essas 4 variáveis no Render e reinicie o serviço (ele reinicia sozinho ao salvar env vars).

Sem essas variáveis, o sistema funciona normalmente, mas o envio de
WhatsApp falha graciosamente (fica registrado como `status: 'falhou'`
na tabela de mensagens, sem derrubar o resto do fluxo).

## 7) Como testar o fluxo completo

```bash
# 1. Simula a landing page
curl -X POST "https://SEU-SERVICO.onrender.com/api/leads" \
  -H "Content-Type: application/json" \
  -d '{"name":"Teste Automação","phone":"11999990000","source":"teste_manual","source_url":"https://exemplo.com/teste"}'
# -> 201, success:true, lead_id

# 2. Veja o lead no CRM (Leads) depois de clicar "Sincronizar agora"

# 3. Force o job sem esperar 2 minutos:
curl -X POST "https://SEU-SERVICO.onrender.com/api/crm/dispatch-now" \
  -H "x-api-key: SUA_CRM_API_KEY"
# -> processa qualquer lead já vencido (ou todos, se você esperar os 2 min antes)

# 4. Veja a mensagem gerada no perfil do lead, aba "Conversa" (depois de sincronizar)
```

## 8) Resumo — o que foi criado/alterado

**Novo (este pacote):**
- `server.js` — servidor Express com todas as rotas
- `src/db.js` — camada de dados (MongoDB, com fallback em memória para testes)
- `src/whatsapp.js` — envio/recebimento de WhatsApp (Meta Cloud API)
- `src/ai.js` — geração da 1ª mensagem (template local ou Claude, se configurado)
- `src/dispatch.js` — o job de 2 minutos, rodando dentro do próprio processo
- `.env.example` — todas as variáveis de ambiente necessárias

**Editado:**
- `ghex-crm.html` — toda a camada de dados que falava com Supabase foi
  reescrita para falar com este backend via `fetch` (mesma aba
  "Configurações → Banco de dados", agora pedindo URL do servidor + chave
  de API em vez de URL/chave do Supabase). Nenhum outro texto, design ou
  funcionalidade foi alterado.

**Removido:** nenhuma dependência de Supabase restou no CRM (o script
`supabase-js` foi removido do `<head>`, e todo o código de cliente Supabase
foi substituído).

## Rotas do servidor

| Rota | Método | Quem chama | Autenticação |
|---|---|---|---|
| `/api/leads` | POST | Landing page | nenhuma (opcional: `x-webhook-secret`) |
| `/api/crm/leads` | GET, POST | CRM | `x-api-key` |
| `/api/crm/leads/:id` | GET, PATCH | CRM | `x-api-key` |
| `/api/crm/leads/:id/events` | GET | CRM | `x-api-key` |
| `/api/crm/leads/:id/messages` | GET | CRM | `x-api-key` |
| `/api/crm/dispatch-now` | POST | CRM (botão "Testar job de IA agora") | `x-api-key` |
| `/api/whatsapp/webhook` | GET, POST | Provedor de WhatsApp | `hub.verify_token` (GET) |
| `/health` | GET | Render / pinger externo | nenhuma |

## O que eu não consigo fazer a partir daqui

Não tenho acesso à sua conta GitHub, Render, MongoDB Atlas, Lovable ou
Meta for Developers — por isso os passos 1 a 6 são manuais, do seu lado.
O código em si já está completo e com a sintaxe validada (`node --check`
passou em todos os arquivos); não consegui rodar `npm install` aqui porque
o registro do npm está bloqueado neste ambiente específico, mas isso roda
normalmente no Render (que não tem essa restrição).
