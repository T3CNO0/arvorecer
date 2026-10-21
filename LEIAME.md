# Arvorecer — versão Vercel

Mesmo site, mesmo cálculo ponderado, mesmo painel e as mesmas defesas da versão PHP,
agora em **funções Node.js + banco Postgres** (a Vercel não roda PHP nem guarda arquivos como SQLite).

## Estrutura
```
public/            site (index.html, assets/) — é o que a Vercel publica como estático
api/               funções: save_result, respondentes, weights, admin
lib/               config.js (competências e pesos), scoring.js, db.js, security.js, http.js
lib/answer_key.js  GABARITO (gerado) — fica fora de public/, nunca vai ao navegador
tools/             build_data.py (regera questions.js, mediated.js e answer_key.js), dev-server.js
tests/run.js       testes automáticos (npm test)
vercel.json        rotas (/admin), cabeçalhos de segurança e CSP
schema.sql         tabelas (criadas sozinhas na 1ª requisição; use à mão se preferir)
```

## Passo a passo
1. **Banco**: crie um Postgres gratuito (Neon, Supabase ou Vercel Storage > Neon). Copie a URL de conexão (prefira a "pooled"). Para LGPD, escolha região no Brasil (São Paulo) se disponível.
2. **GitHub**: suba esta pasta (o `.gitignore` já protege `.env`).
3. **Vercel**: *Add New > Project*, importe o repositório. Framework: *Other*. Não precisa de build.
4. **Variáveis de ambiente** (Settings > Environment Variables):
   | Nome | Valor |
   |---|---|
   | `DATABASE_URL` | URL do Postgres |
   | `ADMIN_EMAIL` | e-mail do administrador principal |
   | `ADMIN_PASSWORD` | senha inicial dele (mín. 10 caracteres; depois troque em *Minha conta*) |
   | `SESSION_SECRET` | `openssl rand -hex 32` |
   | `IP_SALT` | `openssl rand -hex 16` (opcional) |
5. Deploy. O painel fica em **`/admin`**. Se o banco tiver região fixa, ajuste a região das funções (Settings > Functions) para perto dele.

## Rodar localmente
```bash
npm install
ADMIN_PASSWORD=teste SESSION_SECRET=abc npm run dev   # http://localhost:3000 — usa Postgres local embutido
npm test
```
Para trocar pesos/competências edite `lib/config.js`; para mudar questões edite `tools/` e rode `npm run build:data`.

## Contas do painel (administrador principal e professores)
- **Administrador principal**: criado no 1º acesso a partir de `ADMIN_EMAIL` + `ADMIN_PASSWORD`. Vê todos os testes e gerencia a equipe (`/admin?team=1`, menu **Equipe**).
- **Convidar professor**: Equipe → nome + e-mail → o painel mostra um **link de uso único** (vale 72 h). Você entrega o link à pessoa, que define a própria senha. Não há envio de e-mail.
- **Esqueci a senha**: o professor pede ao administrador principal; em Equipe → *Gerar link de nova senha* (vale 24 h). Gerar um novo link invalida o anterior. Logins abertos caem quando a senha muda.
- **Desativar**: Equipe → Desativar. A conta perde o acesso na hora (reative quando quiser).
- **Quem vê o quê**: cada professor tem um **código** (ex.: `maria-4821`). Ao aplicar o Teste Fundamental, ele digita o código no campo "Código ou nome do Professor"; o teste passa a aparecer só no painel dele (e no do administrador principal). Testes sem código válido e todos os testes de Interpretação ficam visíveis só ao administrador principal. Cada professor baixa apenas o CSV dos próprios testes.
- Senhas guardadas com scrypt; e-mail desconhecido e senha errada dão a mesma resposta; 10 erros bloqueiam por 15 min (por visitante e por conta).
- Depois do 1º acesso, `ADMIN_PASSWORD` não é mais lida: se o administrador principal esquecer a senha, apague a linha dele na tabela `users` no banco e reinicie com `ADMIN_EMAIL`/`ADMIN_PASSWORD` (só funciona com a tabela vazia).

## O que foi preservado
Pontuação ponderada idêntica à do PHP (testada com 36 envios aleatórios, 30/50 questões e Fundamental), gabarito só no servidor, honeypot, consentimento, listas permitidas, checagem de integridade, limite de 60 envios/hora por IP (guardado só como hash), corpo ≤ 200 KB, senhas com hash, cookie assinado HttpOnly/SameSite=Strict, proteção de CSV contra fórmula, escape de HTML, CSP e demais cabeçalhos.
Novo: contas individuais, bloqueio após 10 senhas erradas em 15 min e verificação de origem nos formulários.

## Atenções
- Os dados do SQLite antigo **não migram** sozinhos (banco novo).
- A sessão do painel é um cookie assinado (funções não guardam estado); trocar a senha encerra logins antigos.
- Cookie `Secure` só é marcado em HTTPS (na Vercel é sempre).
