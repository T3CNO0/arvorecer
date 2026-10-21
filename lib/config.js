/* =============================================================================
   ARVORECER — CONFIGURAÇÃO  (lib/config.js)
   -----------------------------------------------------------------------------
   É AQUI que você ajusta:
     1) a TABELA ÚNICA de competências (N0 a N4) e seus PESOS;
     2) como cada teste usa essa tabela no cálculo;
     3) limites e valores permitidos nos formulários.

   SEGREDOS (senha do painel, chave da sessão, sal do IP, banco de dados) NÃO ficam
   neste arquivo: são lidos de VARIÁVEIS DE AMBIENTE configuradas na Vercel
   (Project → Settings → Environment Variables). Veja o LEIAME.md.

   Este arquivo fica em lib/ (fora de public/), portanto nunca é servido ao navegador.
   ============================================================================= */
'use strict';

/* ---------------------------------------------------------------------------
   1) SEGURANÇA / ARMAZENAMENTO  (variáveis de ambiente)
   --------------------------------------------------------------------------- */

/** Senha do painel /admin. Enquanto estiver vazia (ou sem SESSION_SECRET), o painel fica DESATIVADO. */
function adminPassword() { return process.env.ADMIN_PASSWORD || ''; }

/** Chave secreta que assina o cookie de login do painel (use 32+ caracteres aleatórios). */
function adminEmail() { return (process.env.ADMIN_EMAIL || '').trim().toLowerCase(); }
function sessionSecret() { return process.env.SESSION_SECRET || ''; }

/** Sal usado para "embaralhar" o IP antes de guardá-lo (nunca guardamos o IP puro). */
function ipSalt() { return process.env.IP_SALT || process.env.SESSION_SECRET || 'arvorecer'; }

/** String de conexão do Postgres (a integração Neon/Supabase da Vercel cria DATABASE_URL ou POSTGRES_URL). */
function databaseUrl() { return process.env.DATABASE_URL || process.env.POSTGRES_URL || ''; }

// Limite de envios por visitante (IP já embaralhado) por hora — barreira simples contra spam.
const RATE_LIMIT_PER_HOUR = 60;

// Tentativas de login erradas no painel: máximo por visitante dentro da janela (minutos).
const ADMIN_MAX_FAILURES = 10;
const ADMIN_FAILURE_WINDOW_MIN = 15;

// Duração do login do painel (horas).
const ADMIN_SESSION_HOURS = 8;

// Tamanho máximo do corpo das requisições (bytes).
const MAX_BODY_BYTES = 200000;


/* ---------------------------------------------------------------------------
   2) TABELA ÚNICA DE COMPETÊNCIAS — N0 a N4  (fonte: planilha NOVA AVALIAÇÃO 2026)
   ---------------------------------------------------------------------------
   Todas as competências ficam juntas, mescladas, e é a mesma tabela que a página
   exibe em "Competências analisadas". Quem separa os testes é o CÁLCULO (seção 3):
       • Teste Fundamental     (conduzido por professor) usa SÓ o nível N0;
       • Teste de Interpretação (autônomo)               usa N1 a N4.

   PESO: cada nível tem um peso-base (LEVELS[...].weight) e toda competência herda o
   peso do seu nível. Escala atual: N0=1 · N1=2 · N2=3 · N3=4 · N4=5.
   Para dar um peso próprio a UMA competência, acrescente weight: 2.5 dentro dela.
   Pesos > 0, qualquer escala serve: o score usa só a proporção entre eles.
   applied: false marca competências que a planilha deixa fora do teste
   (ex.: produção de texto); elas aparecem na tabela, mas nenhuma questão as usa.
   --------------------------------------------------------------------------- */
const LEVELS = {
  "N0": { name: "Fundacional", weight: 1.0, desc: "Aprende o funcionamento da escrita, dos sons, das sílabas e dos números." },
  "N1": { name: "Rudimentar", weight: 2.0, desc: "Localiza informações simples e realiza cálculos imediatos em situações familiares." },
  "N2": { name: "Elementar", weight: 3.0, desc: "Compreende textos breves, faz inferências diretas e resolve problemas rotineiros." },
  "N3": { name: "Intermediário", weight: 4.0, desc: "Integra informações, interpreta conteúdos implícitos e resolve problemas com múltiplas relações." },
  "N4": { name: "Proficiente", weight: 5.0, desc: "Analisa, compara, avalia e produz informações complexas com autonomia." },
};

const COMPETENCIES = {

  // ---------- N0 — FUNDACIONAL ----------
  "N0C1": { level: "N0", title: "Reconhecer letras em diferentes formas gráficas", applied: true,
    desc: "Identificar letras maiúsculas e minúsculas, em letra de forma e, progressivamente, em letra cursiva, relacionando-as ao próprio nome e a palavras familiares." },
  "N0C2": { level: "N0", title: "Relacionar unidades sonoras e unidades escritas", applied: true,
    desc: "Associar fonemas e grafemas em palavras simples, percebendo que mudanças nos sons ou nas letras podem produzir palavras diferentes." },
  "N0C3": { level: "N0", title: "Analisar e manipular sílabas e sons em palavras", applied: true,
    desc: "Separar oralmente palavras em sílabas, juntar sílabas para formar palavras e identificar semelhanças ou diferenças sonoras em palavras conhecidas." },
  "N0C4": { level: "N0", title: "Decodificar e ler palavras regulares simples", applied: true,
    desc: "Ler palavras curtas formadas predominantemente por estruturas consoante-vogal, como “bola”, “casa” e “sapato”, avançando da leitura silabada para a leitura mais automática." },
  "N0C5": { level: "N0", title: "Escrever o próprio nome e palavras de uso pessoal", applied: true,
    desc: "Registrar nome, nomes de familiares, objetos, lugares e outras palavras significativas, com apoio decrescente do modelo." },
  "N0C6": { level: "N0", title: "Desenvolver o registro gráfico funcional", applied: true,
    desc: "Produzir letras e palavras com legibilidade suficiente para que outra pessoa possa compreendê-las." },
  "N0C7": { level: "N0", title: "Reconhecer, ler e registrar números familiares", applied: true,
    desc: "Identificar números de telefone, preços, datas, horários cheios, números de casa e valores de cédulas." },
  "N0C8": { level: "N0", title: "Compreender a função de textos e sinais muito familiares", applied: false,
    desc: "Reconhecer que cartazes, listas, etiquetas, placas e calendários têm finalidades diferentes e localizar neles elementos previamente conhecidos." },

  // ---------- N1 — RUDIMENTAR ----------
  "N1C1": { level: "N1", title: "Ler palavras regulares e frases curtas em situações familiares", applied: false,
    desc: "Decodificar palavras com estruturas simples e compreender frases presentes em listas, etiquetas, avisos, cartazes, mensagens e instruções breves." },
  "N1C2": { level: "N1", title: "Localizar informação explícita única", applied: true,
    desc: "Encontrar um nome, preço, data, horário, endereço ou outra informação pontual em textos muito curtos e familiares." },
  "N1C3": { level: "N1", title: "Reconhecer a organização básica da frase e do texto", applied: false,
    desc: "Usar ponto final e ponto de interrogação como pistas iniciais para diferenciar afirmações e perguntas, reconhecendo o início e o fim de frases curtas." },
  "N1C4": { level: "N1", title: "Produzir registros escritos funcionais curtos", applied: false,
    desc: "Escrever listas, etiquetas, respostas breves, recados simples ou dados pessoais que possam ser compreendidos por outra pessoa." },
  "N1C5": { level: "N1", title: "Ler e escrever números de uso cotidiano", applied: true,
    desc: "Reconhecer e registrar números presentes em preços, dinheiro, telefones, datas, calendários, endereços e horários." },
  "N1C6": { level: "N1", title: "Resolver cálculos imediatos de uma etapa", applied: true,
    desc: "Realizar adições e subtrações simples, com números de até dois algarismos quando adequado ao diagnóstico, em situações de compra, troco, contagem ou comparação." },
  "N1C7": { level: "N1", title: "Usar leitura e números para concluir uma tarefa prática", applied: true,
    desc: "Combinar duas informações simples, como identificar um produto e seu preço, localizar um horário e decidir se ele serve, ou conferir uma quantia antes de pagar." },

  // ---------- N2 — ELEMENTAR ----------
  "N2C1": { level: "N2", title: "Decodificar estruturas silábicas complexas", applied: false,
    desc: "Ler e escrever sem dificuldade palavras com encontros consonantais, sílabas travadas, vogais em diferentes posições, ditongos, hiatos comuns e dígrafos usuais, como CH, NH, LH, RR, SS, GU e QU." },
  "N2C2": { level: "N2", title: "Ler frases e parágrafos com fluência funcional", applied: false,
    desc: "Ler textos curtos sem depender de pausas silábicas constantes, mantendo precisão suficiente para compreender o sentido e responder a perguntas." },
  "N2C3": { level: "N2", title: "Localizar informações explícitas com condição", applied: true,
    desc: "Encontrar informações em bilhetes, bulas, notícias curtas, comunicados ou instruções quando a busca exige selecionar por data, local, quantidade, condição ou categoria." },
  "N2C4": { level: "N2", title: "Compreender o sentido global e realizar inferência direta", applied: true,
    desc: "Explicar com as próprias palavras o assunto de um parágrafo e deduzir uma informação imediata que não está escrita literalmente, usando pistas do contexto." },
  "N2C5": { level: "N2", title: "Produzir textos funcionais breves e coerentes", applied: false,
    desc: "Escrever bilhetes, relatos curtos, solicitações, instruções simples ou respostas com começo, desenvolvimento suficiente e encerramento compreensível." },
  "N2C6": { level: "N2", title: "Resolver problemas com operações fundamentais combinadas", applied: true,
    desc: "Aplicar adição, subtração e multiplicação simples em problemas com mais de uma etapa, incluindo situações de compra com itens repetidos, agrupamentos e comparação de quantidades." },
  "N2C7": { level: "N2", title: "Ler tabelas e gráficos simples", applied: true,
    desc: "Identificar maior e menor valor, comparar dois pontos, localizar uma categoria e responder a perguntas diretas em tabelas de coluna dupla ou gráficos de barras." },

  // ---------- N3 — INTERMEDIÁRIO ----------
  "N3C1": { level: "N3", title: "Integrar informações não contíguas", applied: true,
    desc: "Relacionar partes distantes de um texto ou de diferentes trechos para construir uma síntese, identificar causa e efeito ou acompanhar uma sequência de acontecimentos." },
  "N3C2": { level: "N3", title: "Aplicar regularidades ortográficas contextuais", applied: false,
    desc: "Ler e escrever palavras aplicando regularidades frequentes, como o uso de M antes de P e B, além de padrões envolvendo dígrafos e representação de sons em diferentes contextos." },
  "N3C3": { level: "N3", title: "Distinguir fato, opinião e ponto de vista", applied: true,
    desc: "Identificar dados apresentados como informação objetiva, reconhecer a posição do autor e justificar a diferença entre relato, avaliação e argumento." },
  "N3C4": { level: "N3", title: "Inferir vocabulário e sentido figurado pelo contexto", applied: true,
    desc: "Deduzir o significado de palavras desconhecidas, expressões idiomáticas ou metáforas usando as informações do texto, sem depender exclusivamente do dicionário." },
  "N3C5": { level: "N3", title: "Produzir síntese e reorganizar informações", applied: false,
    desc: "Resumir um texto mais longo, organizar informações em tópicos ou reescrever uma explicação com as próprias palavras, preservando o sentido principal." },
  "N3C6": { level: "N3", title: "Resolver problemas de proporcionalidade e porcentagem", applied: true,
    desc: "Resolver situações envolvendo frações comuns, descontos, aumentos, porcentagens, juros simples e proporções diretas, escolhendo uma estratégia adequada." },
  "N3C7": { level: "N3", title: "Interpretar textos multimodais complexos", applied: true,
    desc: "Cruzar informações entre texto verbal, infográficos, tabelas cruzadas, mapas, rotas ou itinerários e explicar a conclusão obtida." },

  // ---------- N4 — PROFICIENTE ----------
  "N4C1": { level: "N4", title: "Comparar textos, teses e argumentos", applied: true,
    desc: "Ler textos sobre o mesmo tema, identificar convergências e divergências, apontar contradições e reconhecer premissas ou pressupostos não explicitados." },
  "N4C2": { level: "N4", title: "Interpretar linguagem implícita e recursos estilísticos", applied: true,
    desc: "Compreender ironia, humor, duplo sentido, subentendidos, escolhas de tom e intenções persuasivas em diferentes gêneros textuais." },
  "N4C3": { level: "N4", title: "Produzir síntese e reestruturação textual autônoma", applied: true,
    desc: "Resumir textos conceituais densos, comparar informações de fontes diferentes e reelaborar ideias com as próprias palavras, preservando rigor e relações essenciais." },
  "N4C4": { level: "N4", title: "Produzir texto argumentativo ou analítico", applied: true,
    desc: "Formular uma posição, selecionar evidências, organizar razões e reconhecer limites ou possíveis objeções em texto próprio." },
  "N4C5": { level: "N4", title: "Resolver problemas multietapa sob restrições", applied: true,
    desc: "Planejar e executar sequências de cálculos que envolvam diferentes grandezas, taxas variáveis, orçamento, medidas, incerteza ou restrições simultâneas." },
  "N4C6": { level: "N4", title: "Avaliar dados, gráficos e evidências", applied: true,
    desc: "Interpretar gráficos com múltiplos eixos ou variáveis, identificar possíveis distorções, examinar a consistência de conclusões e considerar limitações de amostras ou pesquisas." },
  "N4C7": { level: "N4", title: "Transferir estratégias para situações novas", applied: true,
    desc: "Escolher, adaptar e explicar procedimentos de leitura, escrita, cálculo ou verificação de informação diante de uma tarefa não praticada exatamente da mesma forma." },
};

/* ---------------------------------------------------------------------------
   3) COMO CADA TESTE USA A TABELA NO CÁLCULO
   ---------------------------------------------------------------------------
   score ponderado = (soma dos pesos das questões ACERTADAS)
                     ÷ (soma dos pesos de TODAS as questões do teste) × 100

   TESTE FUNDAMENTAL (N0): cada item tem um código N0C1…N0C8 (campo "c" em
   tools/mediated_items.json) e pesa o mesmo que essa competência.

   TESTE DE INTERPRETAÇÃO (N1–N4): cada questão tem um "tipo de avaliação" (ex.:
   Leitura literal). A matriz abaixo (aba "Página3" da planilha) diz em quais níveis
   cada tipo aparece. O peso da questão é a MÉDIA do peso dos níveis em que o tipo
   aparece:
       • cada nível da matriz conta uma vez (vários códigos no mesmo nível = 1 célula,
         com a média dos pesos deles);
       • célula marcada ● (principal) conta 1; marcada ○ (secundária) conta 0,5;
       • níveis com "—" não entram.
   Formato: 'Tipo': [ [[códigos da célula], cobertura], ... ]
   --------------------------------------------------------------------------- */
const TEST_MATRIX = {
  "Leitura literal": [[["N1C2"], 1.0], [["N2C3"], 1.0], [["N3C1"], 0.5], [["N4C1"], 0.5]],
  "Vocabulário em contexto": [[["N2C4"], 0.5], [["N3C4"], 1.0], [["N4C2"], 1.0]],
  "Ordem temporal": [[["N1C7"], 0.5], [["N2C4"], 0.5], [["N3C1"], 1.0], [["N4C7"], 0.5]],
  "Inferência simples": [[["N1C7"], 0.5], [["N2C4"], 1.0], [["N3C1"], 1.0], [["N3C4"], 0.5]],
  "Leitura de tendência": [[["N2C7"], 1.0], [["N3C7"], 1.0], [["N4C6"], 1.0]],
  "Leitura de projeção": [[["N2C7"], 0.5], [["N3C3"], 1.0], [["N4C6"], 1.0]],
  "Aplicação de regra": [[["N1C7"], 1.0], [["N2C3"], 1.0], [["N3C6"], 0.5], [["N4C7"], 1.0]],
  "Regra condicional": [[["N1C7"], 0.5], [["N2C3"], 1.0], [["N3C1"], 0.5], [["N4C5"], 1.0]],
  "Regra com condições necessárias": [[["N2C3"], 0.5], [["N3C1"], 1.0], [["N4C5"], 1.0]],
  "Contrafactual e condição": [[["N2C4"], 0.5], [["N3C1"], 0.5], [["N4C7"], 1.0]],
  "Planejamento": [[["N1C7"], 0.5], [["N2C6"], 0.5], [["N3C6"], 1.0], [["N4C5", "N4C7"], 1.0]],
  "Cálculo funcional com oferta e desconto": [[["N1C6"], 0.5], [["N2C6"], 1.0], [["N3C6"], 1.0], [["N4C5"], 0.5]],
  "Medidas": [[["N1C5"], 0.5], [["N2C6"], 0.5], [["N3C6"], 1.0], [["N4C5"], 1.0]],
  "Tabela simples": [[["N1C7"], 0.5], [["N2C7"], 1.0], [["N3C7"], 0.5], [["N4C6"], 0.5]],
  "Inferência quantitativa": [[["N1C7"], 0.5], [["N2C6"], 0.5], [["N3C6"], 1.0], [["N4C5"], 1.0]],
  "Multa percentual simples": [[["N1C6"], 0.5], [["N2C6"], 1.0], [["N3C6"], 1.0]],
  "Interpretação de tabela com cálculo": [[["N2C7"], 1.0], [["N3C6", "N3C7"], 1.0], [["N4C6"], 1.0]],
  "Percentual simples": [[["N1C6"], 0.5], [["N2C6"], 1.0], [["N3C6"], 1.0]],
  "Leitura crítica de informação": [[["N2C4"], 0.5], [["N3C3"], 1.0], [["N4C1", "N4C2"], 1.0]],
  "Reconhecimento de evidência": [[["N2C4"], 0.5], [["N3C3"], 0.5], [["N4C4", "N4C6"], 1.0]],
  "Interpretação crítica de indicadores": [[["N2C7"], 0.5], [["N3C7"], 1.0], [["N4C6"], 1.0]],
  "Inferência causal cuidadosa": [[["N3C1"], 0.5], [["N4C1", "N4C6"], 1.0]],
  "Avaliação de argumento": [[["N3C3"], 1.0], [["N4C1", "N4C4"], 1.0]],
  "Distorção visual": [[["N2C7"], 0.5], [["N3C7"], 1.0], [["N4C6"], 1.0]],
  "Leitura crítica de amostras": [[["N3C3"], 0.5], [["N4C6"], 1.0]],
  "Avaliação de veracidade": [[["N2C4"], 0.5], [["N3C3"], 1.0], [["N4C1", "N4C6", "N4C7"], 1.0]],
};

/* Tipos de questão do banco que NÃO estão na matriz da planilha usam o peso do tipo
   equivalente abaixo (decisão editável: troque o nome à direita se preferir outro). */
const DOMAIN_ALIASES = {
  "Localização de informação": "Leitura literal",
  "Compreensão básica": "Leitura literal",
  "Inferência textual": "Inferência simples",
  "Síntese textual": "Inferência simples",
  "Sequência de ações": "Ordem temporal",
  "Cálculo simples": "Percentual simples",
  "Comparação com base diferente": "Percentual simples",
  "Unidades e divisão": "Medidas",
  "Escala e medida": "Medidas",
  "Raciocínio quantitativo": "Inferência quantitativa",
  "Interpretação de média": "Inferência quantitativa",
  "Comparação proporcional": "Inferência quantitativa",
  "Múltiplas etapas": "Planejamento",
  "Comparação numérica": "Tabela simples",
  "Interpretação de tabela": "Tabela simples",
  "Tabela com duas variáveis": "Interpretação de tabela com cálculo",
  "Localização de valor em série": "Leitura de tendência",
  "Estimativa e intervalo": "Leitura de projeção",
  "Risco digital contextual": "Leitura crítica de informação",
};

/* Peso de um tipo que não esteja na matriz nem nos equivalentes. */
const DEFAULT_WEIGHT = 3.0;

/* Pontos de cada resposta "oral" registrada pelo professor. */
const ORAL_POINTS = { ok: 1.0, parcial: 0.5, nao: 0.0 };

/* ---------------------------------------------------------------------------
   4) VALORES PERMITIDOS NOS CAMPOS DO FORMULÁRIO (validação no servidor)
   --------------------------------------------------------------------------- */
const ALLOWED_AGE = ["6-9", "10-14", "15-17", "18-24", "25-34", "35-49", "50-64", "65+"];
const ALLOWED_EDUCATION = ["sem_escolaridade", "fundamental_incompleto", "fundamental_completo", "medio_incompleto", "medio_completo", "superior_incompleto", "superior_completo", "pos_graduacao"];
const ALLOWED_REGION = ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"];
const ALLOWED_SOURCE = ["twitter_x", "instagram", "facebook", "outro", "professor"];

module.exports = {
  adminPassword, adminEmail, sessionSecret, ipSalt, databaseUrl,
  RATE_LIMIT_PER_HOUR, ADMIN_MAX_FAILURES, ADMIN_FAILURE_WINDOW_MIN, ADMIN_SESSION_HOURS, MAX_BODY_BYTES,
  LEVELS, COMPETENCIES, TEST_MATRIX, DOMAIN_ALIASES, DEFAULT_WEIGHT, ORAL_POINTS,
  ALLOWED_AGE, ALLOWED_EDUCATION, ALLOWED_REGION, ALLOWED_SOURCE,
};
