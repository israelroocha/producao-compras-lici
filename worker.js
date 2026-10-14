/**
 * Cloudflare Worker — Portal de Demandas Licitação
 *
 * Variáveis de ambiente necessárias (Settings → Variables):
 *   HUBSPOT_TOKEN  → Token do Private App HubSpot
 *   RESEND_KEY     → Chave da API do Resend  (SECRET, não Variable)
 *   ALLOWED_ORIGIN → opcional; só para liberar uma origem extra fora do padrão
 *
 * Atualizado em 21/09/2026 — portal migrado do GitHub Pages para
 * https://www.demandalicitacao.citerol.com.br
 */

const HS_BASE = 'https://api.hubapi.com';

// Endereço atual do portal. Usado no botão do e-mail de notificação.
// ⚠ Estava apontando para o GitHub Pages antigo
// (israelroocha.github.io/producao-compras-lici) mesmo depois da migração —
// ou seja, o e-mail levava o Damasceno e o Michel para o portal velho.
const PORTAL_URL = 'https://www.demandalicitacao.citerol.com.br/';

// ═══════════════════════════════════════
// ROTEAMENTO
// ═══════════════════════════════════════
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse('', 204, origin, env);
    }

    // Roteamento
    const path = url.pathname;

    try {
      if (path.startsWith('/api/')) {
        return await handleApi(request, path.replace('/api', ''), env, origin);
      }
      if (path === '/upload') {
        return await handleUpload(request, env, origin);
      }
      if (path === '/signed-url') {
        return await handleSignedUrl(request, env, origin);
      }
      if (path === '/notify') {
        return await handleNotify(request, env, origin);
      }
      return corsResponse(JSON.stringify({ error: 'Not found' }), 404, origin, env);
    } catch (e) {
      console.error('Worker error:', e);
      return corsResponse(JSON.stringify({ error: e.message }), 500, origin, env);
    }
  }
};

// ═══════════════════════════════════════
// PROXY DE API — GET / POST / PATCH
// ═══════════════════════════════════════
async function handleApi(request, hspath, env, origin) {
  const url = new URL(request.url);
  const hsUrl = `${HS_BASE}/crm/v3/objects${hspath}${url.search}`;

  // Rotas especiais fora de /crm/v3/objects
  let finalUrl = hsUrl;
  if (hspath.startsWith('/deals/') && hspath.endsWith('/associations/companies')) {
    const dealId = hspath.split('/')[2];
    finalUrl = `${HS_BASE}/crm/v4/objects/deals/${dealId}/associations/companies`;
  } else if (hspath.startsWith('/owners')) {
    const rest = hspath.replace('/owners', '');
    finalUrl = `${HS_BASE}/crm/v3/owners${rest}${url.search}`;
  } else if (hspath.startsWith('/deals/') && hspath.includes('/history/')) {
    const parts = hspath.split('/');
    const dealId = parts[2];
    const prop = parts[4];
    finalUrl = `${HS_BASE}/crm/v3/objects/deals/${dealId}?propertiesWithHistory=${prop}`;
  } else if (hspath === '/deals/search') {
    finalUrl = `${HS_BASE}/crm/v3/objects/deals/search`;
  } else if (hspath.startsWith('/companies/')) {
    finalUrl = `${HS_BASE}/crm/v3/objects/companies${hspath.replace('/companies', '')}${url.search}`;
  }

  const body = request.method !== 'GET' ? await request.text() : undefined;

  const hsResp = await fetch(finalUrl, {
    method: request.method,
    headers: {
      'Authorization': `Bearer ${env.HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  // Para histórico de propriedade, extrai o array de valores
  if (hspath.includes('/history/')) {
    const data = await hsResp.json();
    const prop = hspath.split('/')[4];
    const history = data.propertiesWithHistory?.[prop] || [];
    return corsResponse(JSON.stringify({ values: history }), 200, origin, env);
  }

  const text = await hsResp.text();
  return corsResponse(text, hsResp.status, origin, env);
}

// ═══════════════════════════════════════
// NOTIFY — dispara email via Resend
// Chamado pelo Webhook do HubSpot quando
// deal entra em "Preparação e custo"
// ═══════════════════════════════════════
async function handleNotify(request, env, origin) {
  // Aceita POST do HubSpot (webhook) ou do portal
  let body = {};
  try {
    body = await request.json();
  } catch {}

  const dealId    = body.dealId    || body.objectId || null;
  const dealName  = body.dealName  || body.dealname || 'Negócio sem nome';
  const tipo      = body.tipo      || body.tipo_de_op_compraproducao || '';

  // Define destinatários pelo tipo
  const destinatarios = [];
  if (tipo === 'Compra' || tipo === 'Compra e Produção') {
    destinatarios.push({ email: 'damasceno@citerol.com.br', nome: 'Damasceno', area: 'Compras' });
  }
  if (tipo === 'Produção' || tipo === 'Compra e Produção') {
    destinatarios.push({ email: 'michel@citerol.com.br', nome: 'Michel', area: 'Produção' });
  }

  if (!destinatarios.length) {
    return corsResponse(JSON.stringify({ ok: false, reason: 'Tipo não reconhecido: ' + tipo }), 200, origin, env);
  }

  // ⚠ A CHAVE VEM SÓ DO AMBIENTE — NÃO REPITA A CHAVE AQUI NO CÓDIGO.
  // A versão anterior tinha um valor padrão com a chave escrita no arquivo. Chave em código vaza junto com o código: vai pro Git,
  // pro backup, pro print, pro chat. Se a variável não estiver configurada,
  // é melhor falhar com uma mensagem clara do que mandar e-mail com uma chave
  // que qualquer um que leu o arquivo consegue usar.
  const RESEND_KEY = env.RESEND_KEY;
  if (!RESEND_KEY) {
    console.error('RESEND_KEY não configurada no Worker.');
    return corsResponse(JSON.stringify({
      ok: false,
      reason: 'RESEND_KEY não configurada — cadastre em Settings → Variables and Secrets (como Secret).',
    }), 500, origin, env);
  }

  const erros = [];
  for (const dest of destinatarios) {
    const html = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <div style="background:#1a1a1a;padding:20px 24px;">
          <span style="color:#9E0B0F;font-size:18px;font-weight:700;letter-spacing:2px;">PORTAL DE DEMANDAS</span>
          <span style="color:#fff;font-size:12px;margin-left:10px;">Licitação</span>
        </div>
        <div style="padding:24px;border:1px solid #e8e8e8;border-top:none;">
          <p style="margin:0 0 16px;font-size:15px;">Olá, <strong>${dest.nome}</strong>!</p>
          <p style="margin:0 0 20px;font-size:14px;color:#555;">
            Você tem uma nova demanda de análise de custo aguardando no Portal de Demandas da Licitação.
          </p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            <tr>
              <td style="padding:8px 12px;background:#f5f5f5;font-size:12px;color:#999;font-weight:600;text-transform:uppercase;width:40%;">Negócio</td>
              <td style="padding:8px 12px;font-size:13px;color:#1a1a1a;">${dealName}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;background:#f5f5f5;font-size:12px;color:#999;font-weight:600;text-transform:uppercase;">Tipo</td>
              <td style="padding:8px 12px;font-size:13px;color:#1a1a1a;">${tipo}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;background:#f5f5f5;font-size:12px;color:#999;font-weight:600;text-transform:uppercase;">Área</td>
              <td style="padding:8px 12px;font-size:13px;color:#1a1a1a;">${dest.area}</td>
            </tr>
            ${dealId ? `<tr>
              <td style="padding:8px 12px;background:#f5f5f5;font-size:12px;color:#999;font-weight:600;text-transform:uppercase;">ID</td>
              <td style="padding:8px 12px;font-size:13px;color:#1a1a1a;">${dealId}</td>
            </tr>` : ''}
          </table>
          <a href="${PORTAL_URL}" style="display:inline-block;background:#9E0B0F;color:#fff;padding:12px 28px;text-decoration:none;font-size:14px;font-weight:600;border-radius:6px;">
            Acessar Portal →
          </a>
        </div>
        <div style="padding:12px 24px;font-size:11px;color:#999;border-top:1px solid #e8e8e8;">
          Citerol — Portal de Demandas Licitação
        </div>
      </div>
    `;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Portal Licitação <onboarding@resend.dev>',
        to: [dest.email],
        subject: `Nova demanda de análise de custo — ${dealName}`,
        html,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('Resend error:', err);
      erros.push({ dest: dest.email, error: err });
    }
  }

  return corsResponse(JSON.stringify({
    ok: erros.length === 0,
    enviados: destinatarios.map(d => d.email),
    erros,
  }), 200, origin, env);
}

// ═══════════════════════════════════════
// SIGNED URL — gera URL fresca para download
// ═══════════════════════════════════════
async function handleSignedUrl(request, env, origin) {
  const url = new URL(request.url);
  const fileParam = url.searchParams.get('url');

  if (!fileParam) {
    return corsResponse(JSON.stringify({ error: 'url param required' }), 400, origin, env);
  }

  // Verifica se é um fileId numérico ou uma URL completa
  const isFileId = /^\d+$/.test(fileParam.trim());
  let fileId = null;

  if (isFileId) {
    fileId = fileParam.trim();
  } else {
    // Tenta extrair fileId de uma URL hubspot
    const match = fileParam.match(/\/files\/v3\/files\/(\d+)/);
    if (match) fileId = match[1];
  }

  // Se temos fileId, gera signed URL
  if (fileId) {
    const signedResp = await fetch(`${HS_BASE}/files/v3/files/${fileId}/signed-url`, {
      headers: { 'Authorization': `Bearer ${env.HUBSPOT_TOKEN}` },
    });
    if (signedResp.ok) {
      const signed = await signedResp.json();
      // Redireciona para a URL assinada
      return Response.redirect(signed.url, 302);
    }
    return corsResponse(JSON.stringify({ error: 'Não foi possível gerar URL assinada' }), 404, origin, env);
  }

  // Caso contrário, tenta fetch autenticado da URL diretamente
  const resp = await fetch(fileParam, {
    headers: { 'Authorization': `Bearer ${env.HUBSPOT_TOKEN}` },
    redirect: 'follow',
  });

  if (!resp.ok) {
    return corsResponse(JSON.stringify({ error: 'Arquivo não encontrado' }), 404, origin, env);
  }

  const contentType = resp.headers.get('content-type') || 'application/octet-stream';
  const contentDisposition = resp.headers.get('content-disposition') || 'attachment';
  const blob = await resp.arrayBuffer();

  // Este caminho é aberto por <a href target="_blank"> (navegação), não por
  // fetch — o CORS nem entra na conta. O cabeçalho vai só quando a origem é
  // conhecida, pela mesma regra do resto.
  const headers = {
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition,
  };
  if (origemPermitida(origin, env)) headers['Access-Control-Allow-Origin'] = origin;

  return new Response(blob, { status: 200, headers });
}

// ═══════════════════════════════════════
// UPLOAD DE ARQUIVO → HubSpot Files API
// ═══════════════════════════════════════
async function handleUpload(request, env, origin) {
  const formData = await request.formData();
  const file = formData.get('file');
  const dealId = formData.get('dealId');
  const folderPath = formData.get('folderPath') || '/licitacao/planilhas';

  if (!file) {
    return corsResponse(JSON.stringify({ error: 'Arquivo não encontrado' }), 400, origin, env);
  }

  // Prepara multipart para HubSpot Files API
  const hsForm = new FormData();
  hsForm.append('file', file);
  hsForm.append('folderPath', folderPath);
  hsForm.append('options', JSON.stringify({
    access: 'PRIVATE',
    overwrite: false,
    duplicateValidationStrategy: 'NONE',
  }));

  const uploadResp = await fetch(`${HS_BASE}/files/v3/files`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.HUBSPOT_TOKEN}`,
    },
    body: hsForm,
  });

  if (!uploadResp.ok) {
    const err = await uploadResp.text();
    console.error('Upload error:', err);
    return corsResponse(JSON.stringify({ error: 'Falha no upload', detail: err }), 500, origin, env);
  }

  const uploaded = await uploadResp.json();

  // Retorna o fileId numérico como identificador permanente
  // O portal salva esse ID na propriedade HubSpot
  // O Worker gera nova signed URL na hora do download via /signed-url?url={fileId}
  return corsResponse(JSON.stringify({ url: String(uploaded.id), fileId: uploaded.id }), 200, origin, env);
}

// ═══════════════════════════════════════
// CORS
// ═══════════════════════════════════════
// Origens que podem falar com este worker.
//
// ⚠ POR QUE POR PADRÃO E NÃO POR STRING EXATA:
// a regra antiga era `origin === env.ALLOWED_ORIGIN`, herdada de quando o
// portal morava no GitHub Pages. Ao mudar para citerol.com.br o portal parou
// de carregar ("Erro ao carregar demandas. Verifique o Worker"), porque:
//
//   1. o domínio novo não bate em `.github.io` nem em localhost; e
//   2. o site é servido em **www.**demandalicitacao.citerol.com.br — então
//      mesmo pondo o domínio sem www em ALLOWED_ORIGIN, a comparação exata
//      falha. Uma variável só nunca cobre www + sem-www ao mesmo tempo.
//
// Aceitar qualquer subdomínio https de citerol.com.br resolve os dois, e é a
// mesma técnica que o código já usava para o github.io.
function origemPermitida(origin, env) {
  if (!origin) return false;
  let h;
  try { h = new URL(origin); } catch { return false; }

  // Domínios da Citerol — só https, e o sufixo é checado com o ponto na frente
  // pra "maliciterol.com.br" não passar por terminar em "citerol.com.br".
  if (h.protocol === 'https:' &&
      (h.hostname === 'citerol.com.br' || h.hostname.endsWith('.citerol.com.br'))) return true;

  if (h.hostname.endsWith('.github.io')) return true;                        // legado
  if (h.hostname === 'localhost' || h.hostname === '127.0.0.1') return true; // dev

  // Extra configurado à mão, se houver.
  const extra = env.ALLOWED_ORIGIN || '';
  if (extra === '*') return true;
  if (extra && origin === extra) return true;

  return false;
}

function corsResponse(body, status, origin, env) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    // Origens diferentes recebem respostas diferentes: sem isto, um cache
    // intermediário pode servir a uma origem o cabeçalho gerado para outra.
    'Vary': 'Origin',
  };

  // ⚠ Só manda o cabeçalho quando a origem é permitida. Devolver a origem
  // "oficial" para quem não está na lista (como antes) não protege nada e
  // ainda esconde o erro: o navegador bloqueia e a tela só diz "verifique o
  // worker", sem dizer que o problema era a origem.
  //
  // Requisição SEM Origin (webhook do HubSpot chamando /notify, curl) passa
  // normalmente — CORS é regra de navegador, e aqui só omitimos o cabeçalho,
  // nunca recusamos a requisição.
  if (origemPermitida(origin, env)) headers['Access-Control-Allow-Origin'] = origin;

  return new Response(body || null, { status, headers });
}