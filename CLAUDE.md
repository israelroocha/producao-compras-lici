# Portal de Demandas — Licitação (Citerol)

## O que é este projeto

Portal interno para análise de custo de licitações. Usuários de Compras e Produção recebem demandas vindas do HubSpot, visualizam os arquivos do processo (edital, termo de referência) e devolvem a planilha de custos preenchida. O portal avança automaticamente o negócio no HubSpot quando todos os lados respondem.

## Arquitetura

```
www.demandalicitacao.citerol.com.br (index.html, Apache próprio)
    ↓ fetch
Cloudflare Worker (worker.js) — proxy HubSpot, upload de arquivos, e-mail
    ↓ API calls
HubSpot CRM (portal 50832222)
```

## Arquivos do projeto

| Arquivo | Descrição |
|---|---|
| `index.html` | Frontend completo (single file, sem build) |
| `worker.js` | Cloudflare Worker — proxy HubSpot API, upload, signed URL, e-mail |
| `wrangler.jsonc` | Config para publicar o Worker com `wrangler deploy` |

O `worker.js` só passou a ser versionado em 14/10/2026 — antes vivia só no editor do painel da
Cloudflare. Foi baixado do Worker publicado naquele dia; a única diferença é um comentário
(tirado o trecho que citava a chave antiga do Resend).

## URLs em produção

| Recurso | URL |
|---|---|
| Portal (no ar) | `https://www.demandalicitacao.citerol.com.br/` — servidor Apache, IP 177.53.142.228 |
| Portal antigo (legado) | `https://israelroocha.github.io/producao-compras-lici/` |
| Repositório GitHub | `https://github.com/israelroocha/producao-compras-lici` — **PÚBLICO** |
| Cloudflare Worker | `https://compras-producao-licitacao.israel-caetano-lima.workers.dev` (conta Cloudflare "Citerol") |

Migração do GitHub Pages para o domínio da Citerol em 21/09/2026. Em 14/10/2026 o HTML no ar
era idêntico ao `index.html` do repositório (VERSION 2.3.0).

## ⚠️ O repositório é público

Tudo que entra aqui fica visível para qualquer pessoa na internet, inclusive o histórico.
**Nunca** escreva token, chave de API, senha ou e-mail de cliente em arquivo versionado — nem
neste CLAUDE.md. Segredos ficam nas variáveis do Worker (painel da Cloudflare ou
`wrangler secret put`).

## Credenciais do portal

Dois usuários: `compras` (área Compras) e `producao` (área Produção). As senhas **não** ficam
neste arquivo — pergunte ao Israel.

Ver "Problemas conhecidos".

## Variáveis de ambiente (Cloudflare Worker)

Configuradas em Settings → Variables and Secrets no painel da Cloudflare:

| Variável | Tipo | Descrição |
|---|---|---|
| `HUBSPOT_TOKEN` | secret | Token do Private App HubSpot (portal 50832222) |
| `RESEND_KEY` | secret | Chave da API do Resend |
| `ALLOWED_ORIGIN` | texto | Origem extra liberada no CORS (opcional) |

O `wrangler.jsonc` usa `keep_vars: true` e não declara `vars`, para o deploy não apagar o que
está no painel.

## HubSpot — IDs de referência

### Portal e pipeline
| Item | ID |
|---|---|
| Portal HubSpot | `50832222` |
| Pipeline de Licitação | `900569089` |

### Etapas do pipeline
| Etapa | ID |
|---|---|
| Preparação e custo | `1361336878` |
| Precificação | `1361336879` |
| Licitação ou BID | `1361336880` |
| Oportunidade ganha | `1361336881` |
| Perdido | `1361336882` |

### Propriedades relevantes dos deals
| Propriedade | Tipo | Descrição |
|---|---|---|
| `tipo_de_op_compraproducao` | select | `"Compra"` / `"Produção"` / `"Compra e Produção"` |
| `planilha_de_custos__compras` | file | Planilha enviada pelo usuário Compras (armazena fileId numérico) |
| `planilha_de_custos` | file | Planilha enviada pelo usuário Produção (armazena fileId numérico) |
| `observacao_da_analise_de_custo_da_compra` | text | Observação do usuário Compras |
| `observacao_da_analise_de_custo` | text | Observação do usuário Produção |
| `termo_de_referencia` | file | Arquivo(s) do processo — pode ter múltiplos IDs separados por `;` |
| `edital` | file | Arquivo(s) do edital — pode ter múltiplos IDs separados por `;` |
| `informacao_para_producaocompra` | text | Campo informativo exibido no card para os usuários |

## Lógica de negócio

### Visibilidade por usuário
- `compras` vê deals com `tipo_de_op_compraproducao` = `"Compra"` ou `"Compra e Produção"`
- `producao` vê deals com `tipo_de_op_compraproducao` = `"Produção"` ou `"Compra e Produção"`

### Abas do portal
| Aba | Critério |
|---|---|
| **Pendentes** | Na etapa Preparação e custo, sem planilha, primeira vez |
| **Reajuste** | Voltou para Preparação e custo (passou mais de 1x), sem planilha |
| **Executadas** | Com planilha enviada (em qualquer etapa) |

### Avanço automático de etapa
- `"Compra"` → avança quando `planilha_de_custos__compras` preenchida
- `"Produção"` → avança quando `planilha_de_custos` preenchida
- `"Compra e Produção"` → avança somente quando **ambas** preenchidas
- Destino: etapa `1361336879` (Precificação)

### Upload de arquivos
- O Worker sobe para HubSpot Files API com `access: PRIVATE`
- Salva o **fileId numérico** na propriedade (não a URL assinada — ela expira)
- O Worker gera nova signed URL na hora do download via `/signed-url?url={fileId}`
- Múltiplos arquivos em `termo_de_referencia`/`edital` separados por `;`

### Notificação de e-mail
- Rota `POST /notify` no Worker
- Disparada pelo Webhook do HubSpot quando deal entra em "Preparação e custo"
- Remetente: `onboarding@resend.dev`
- Destinatários:
  - `Compra` → `damasceno@citerol.com.br`
  - `Produção` → `michel@citerol.com.br`
  - `Compra e Produção` → ambos
- Payload esperado pelo Worker: `{ dealId, dealName, tipo }`
- O botão do e-mail leva para `PORTAL_URL` (no topo do `worker.js`)

## Rotas do Worker

| Rota | Método | Descrição |
|---|---|---|
| `/api/*` | GET/POST/PATCH | Proxy para HubSpot CRM API |
| `/upload` | POST | Upload de arquivo para HubSpot Files API |
| `/signed-url?url={id}` | GET | Gera URL de download assinada a partir de fileId |
| `/notify` | POST | Dispara e-mail via Resend |

CORS (`origemPermitida`): qualquer `https://*.citerol.com.br`, `*.github.io` (legado),
localhost, mais `ALLOWED_ORIGIN`.

## Cache-busting

A cada deploy do `index.html`, alterar a constante `VERSION` no topo do `<script>` (ex: `2.3.0` → `2.4.0`). Isso força o browser a recarregar o arquivo em vez de usar o cache.

## Deploy

### Worker
```
npx wrangler@4 deploy
```
Rodado nesta pasta, com o wrangler logado na conta Cloudflare "Citerol". Publicação vai para
produção na hora — sempre confirmar com o Israel antes.

### Portal (index.html)
Hospedado no Apache do domínio `demandalicitacao.citerol.com.br`. **Forma de subir o arquivo:
a confirmar com o Israel** (FTP/painel de hospedagem). O GitHub Pages antigo continua no ar com
a mesma versão.

Commit + push no GitHub mantém o histórico; não publica sozinho no domínio novo.

## Escopos necessários no Private App HubSpot

`crm.objects.deals.read`, `crm.objects.deals.write`, `crm.objects.owners.read`, `crm.objects.companies.read`, `crm.associations.read`, `files`, `files.ui_hidden.write`, `automation`

## Problemas conhecidos

- **Segurança em revisão (out/2026)** — login e Worker precisam de endurecimento. Os detalhes
  ficam fora deste repositório público; fale com o Israel antes de mexer em autenticação,
  `/api/*` ou `/signed-url`.
- Arquivos salvos antes de out/2026 podem ter URL assinada expirada na propriedade — usuário precisa reenviar a planilha
- `termo_de_referencia` e `edital` podem conter múltiplos IDs separados por `;` — o portal renderiza um botão por arquivo
- HubSpot não limpa propriedades de arquivo ao mover deal de etapa — se quiser limpar ao retornar para Preparação e custo, criar Workflow no HubSpot

## Design system

- Vermelho: `#9E0B0F`
- Preto: `#1a1a1a`
- Fontes: Oswald (títulos uppercase) + Montserrat (corpo)
- Verde para estados positivos, roxo para reajuste, laranja para pendente
