#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ARVORECER — gerador de dados
============================
Lê duas fontes:
  1) tools/question_bank.source.js -> banco de questões do teste autônomo (50 grupos x 10 variantes)
                                      (precisa do Node.js instalado para ler este arquivo)
  2) tools/mediated_items.json  -> itens do teste fundamental / N0 (conduzido por professor)

E produz:
  * public/assets/questions.js -> banco SEM gabarito e SEM nome da competência (vai ao navegador)
  * public/assets/mediated.js  -> itens do teste fundamental (N0) SEM gabarito (vai ao navegador)
  * lib/answer_key.js      -> gabarito + competência de cada item (fica só no servidor)

Também CONFERE o gabarito: para os grupos numéricos, recalcula a resposta por código
e compara com a alternativa marcada como correta.

Uso:  python3 tools/build_data.py
"""
import json, re, sys, os, math
from fractions import Fraction

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Converte a fonte JS (question_bank.source.js) em lista Python usando o Node.js
import subprocess
_js = ("const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8');"
       "process.stdout.write(JSON.stringify(new Function(s+';return QUESTION_BANK')()));")
bank = json.loads(subprocess.run(["node", "-e", _js, os.path.join(ROOT, "tools", "question_bank.source.js")],
                                 capture_output=True, text=True, check=True, encoding="utf-8").stdout)
med = json.load(open(os.path.join(ROOT, "tools", "mediated_items.json"), encoding="utf-8"))["items"]

# Grupos (índice 0-based) usados na versão curta de 30 questões (mesmos do teste original)
SHORT_FORM_GROUPS = [0,1,2,3,6,7,8,10,13,16,17,19,20,21,22,24,27,29,31,32,33,34,36,37,39,40,42,45,46,49]

# ---------------------------------------------------------------------------
# GABARITO
# Regra geral: nos grupos "embaralhados" a 1ª alternativa listada é a correta.
# Nos grupos abaixo, as alternativas vêm em ordem a,b,c,d e a correta varia;
# por isso o gabarito é informado manualmente (letra = id da alternativa).
# ---------------------------------------------------------------------------
MANUAL = {
    6:  dict(a="d", b="c", c="d", d="d", e="a", f="d", g="d", h="a", i="a", j="d"),   # q07 vocabulário
    17: dict(a="a", b="b", c="c", d="d", e="a", f="b", g="c", h="d", i="a", j="b"),   # q18 leitura crítica
    20: dict(a="b", b="c", c="a", d="d", e="b", f="c", g="a", h="d", i="b", j="c"),   # q21 instituições
    21: dict(a="a", b="a", c="a", d="a", e="a", f="a", g="a", h="a", i="a", j="a"),   # q22 regra condicional
    24: dict(a="b", b="c", c="b", d="a", e="b", f="a", g="c", h="b", i="c", j="a"),   # q25 evidência
    27: dict(a="b", b="c", c="b", d="c", e="a", f="b", g="a", h="c", i="a", j="c"),   # q28 indicadores
    29: dict(a="a", b="b", c="c", d="d", e="a", f="b", g="c", h="d", i="a", j="b"),   # q30 causal
    33: dict(a="b", b="b", c="c", d="c", e="a", f="b", g="c", h="b", i="c", j="b"),   # q34 risco digital
    37: dict(a="a", b="b", c="c", d="a", e="a", f="b", g="a", h="b", i="a", j="a"),   # q38 argumento
    42: dict(a="a", b="a", c="a", d="a", e="b", f="a", g="a", h="a", i="a", j="a"),   # q43 amostras
    45: dict(a="a", b="a", c="a", d="a", e="a", f="a", g="a", h="a", i="a", j="a"),   # q46 veracidade
    46: dict(a="b", b="d", c="a", d="c", e="b", f="d", g="a", h="c", i="b", j="d"),   # q47 planejamento
}

def money(txt):
    return Fraction(txt.replace(",", "."))

def q03_answer(q):
    """Grupo 03: menor combinação de pacotes (1,2,3 un.) e depois o desconto do fim de semana."""
    prices = {int(n): money(p) for n, p in re.findall(r"<td>(\d) unidade[s]?</td><td>R\$ ([\d,]+)</td>", q["s"])}
    disc = int(re.search(r"(\d+)% de desconto", q["s"]).group(1))
    n = int(re.search(r"por (\d+) ", q["q"]).group(1))
    best = [Fraction(0)] + [None] * n
    for i in range(1, n + 1):
        cands = [best[i - k] + prices[k] for k in (1, 2, 3) if i - k >= 0 and best[i - k] is not None]
        best[i] = min(cands)
    total = best[n] * (100 - disc) / 100
    return total

def fmt_brl(v):
    v = Fraction(v)
    cents = int(round(v * 100))
    return "R$ %d,%02d" % (cents // 100, cents % 100)

def correct_id(gi, q):
    variant = q["id"][-1]
    if gi == 2:  # cálculo (q03) — recalculado por código
        want = fmt_brl(q03_answer(q))
        hits = [o["id"] for o in q["o"] if o["text"] == want]
        assert len(hits) == 1, (q["id"], want, [o["text"] for o in q["o"]])
        return hits[0]
    if gi in MANUAL:
        return MANUAL[gi][variant]
    return q["o"][0]["id"]  # 1ª alternativa listada = correta

def text_of(q, cid):
    return next(o["text"] for o in q["o"] if o["id"] == cid)

# ---------------------------------------------------------------------------
# CONFERÊNCIA POR CÓDIGO dos grupos numéricos (índice 0-based)
# ---------------------------------------------------------------------------
def nums(s):
    return [int(x) for x in re.findall(r"\d+", s)]

def rows(s):
    return re.findall(r"<tr><td>([^<]+)</td><td>R?\$? ?(\d+)</td><td>R?\$? ?(\d+)</td></tr>", s)

def check(gi, q):
    """Devolve o texto esperado da resposta ou None se o grupo não é checado por código."""
    s, qq = q["s"], q["q"]
    if gi == 5:   # q06 passagens
        p = int(re.search(r"R\$ (\d+),00", s).group(1))
        n = int(re.search(r"usará (\d+) passagens", s).group(1))
        return "R$ %d,00" % (p * n)
    if gi == 8:   # q09 copos
        a, b = nums(s)[0], nums(s)[1]
        return "%d copos" % (a // b)
    if gi == 11:  # q12 dobro do mais barato
        items = [(n, int(p)) for n, p in re.findall(r"<td>([^<]+)</td><td>R\$ (\d+)</td>", s)]
        m = min(p for _, p in items)
        return [n for n, p in items if p == 2 * m][0]
    if gi == 12:  # q13 plano mais barato no 1º mês
        pl = re.findall(r"Plano ([ABC]): R\$ (\d+),00 por mês e taxa de instalação de R\$ (\d+),00", s)
        tot = {k: int(a) + int(b) for k, a, b in pl}
        return "Plano " + min(tot, key=tot.get)
    if gi == 16:  # q17 sobrou menos
        r = [(n, int(a) - int(b)) for n, a, b in rows(s)]
        return min(r, key=lambda x: x[1])[0]
    if gi == 18:  # q19 menor preço+frete
        r = re.findall(r"<td>([ABC])</td><td>R\$ (\d+)</td><td>R\$ (\d+)</td>", s)
        t = {k: int(a) + int(b) for k, a, b in r}
        return min(t, key=t.get)
    if gi == 19:  # q20 aumento percentual
        a, b = nums(s)[0], nums(s)[2]
        return "%d%%" % round((b - a) * 100 / a)
    if gi == 25:  # q26 escala
        cm, km, n = nums(s)[0], nums(s)[1], nums(s)[2]
        return "%d km" % (km * n // cm)
    if gi == 26:  # q27 menor preço por kg
        opts = re.findall(r"Opção ([ABC]): (\d+) (kg|g) por R\$ (\d+)", s)
        pk = {k: Fraction(int(p)) / (Fraction(int(n)) / (1000 if u == "g" else 1)) for k, n, u, p in opts}
        return "Opção " + min(pk, key=pk.get)
    if gi == 28:  # q29 maior taxa de aprovação
        r = re.findall(r"<td>([ABC])</td><td>(\d+)</td><td>(\d+)</td>", s)
        t = {k: Fraction(int(b), int(a)) for k, a, b in r}
        return max(t, key=t.get)
    if gi == 30:  # q31 média
        v = nums(s)
        return str(sum(v) // len(v))
    if gi == 23:  # q24 valor acima do limite
        vals = dict((k, int(v)) for k, v in re.findall(r"(T\d) = (\d+)", s))
        lim = nums(qq)[-1]
        hit = [k for k, v in vals.items() if v > lim]
        return hit[0]
    if gi == 32:  # q33 multa
        v = int(re.search(r"R\$ (\d+),00", s).group(1))
        p = int(re.search(r"multa de (\d+)%", s).group(1))
        return "R$ %d,00" % (v * (100 + p) // 100)
    if gi == 35:  # q36 maior conversão
        r = re.findall(r"<td>([ABC])</td><td>(\d+)</td><td>(\d+)</td>", s)
        t = {k: Fraction(int(b), int(a)) for k, a, b in r}
        return max(t, key=t.get)
    if gi == 38:  # q39 encontros restantes
        h, p, e = nums(s)[0], nums(s)[1], nums(s)[2]
        return str(h * (100 - p) // 100 // e)
    if gi == 41:  # q42 intervalo
        est, m = nums(s)[0], nums(s)[1]
        return "%d%% a %d%%" % (est - m, est + m)
    if gi == 44:  # q45 poder de compra
        a, b = nums(s)[0], nums(s)[1]
        return "O poder de compra provavelmente diminuiu" if a < b else (
            "O poder de compra provavelmente aumentou" if a > b else "O poder de compra ficou aproximadamente estável")
    if gi == 47:  # q48 total
        r = re.findall(r"<tr><td>[^<]+</td><td>(\d+)</td><td>(\d+)</td></tr>", s)
        return str(int(r[0][0]) + int(r[0][1]))
    if gi == 48:  # q49 dias
        v = nums(s)
        return "%d dias" % (v[0] // v[1])
    if gi == 49:  # q50 percentual
        v = nums(s)
        return "%d%%" % round(v[1] * 100 / v[0])
    return None

# ---------------------------------------------------------------------------
# MONTAGEM
# ---------------------------------------------------------------------------
errors = []
items_key = {}
client_groups = []
for gi, group in enumerate(bank):
    domains = {q["d"] for q in group}
    assert len(domains) == 1, (gi, domains)
    client_group = []
    for q in group:
        cid = correct_id(gi, q)
        items_key[q["id"]] = {"g": gi, "d": q["d"], "a": cid}
        exp = check(gi, q)
        if exp is not None:
            got = text_of(q, cid)
            if got != exp:
                errors.append((q["id"], "esperado", exp, "gabarito", got))
        client_group.append({"id": q["id"], "s": q["s"], "q": q["q"], "o": q["o"]})
    client_groups.append(client_group)

# sanidade: grupos NÃO manuais não devem ter alternativas em ordem a,b,c,d em todas as variantes
for gi, group in enumerate(bank):
    if gi in MANUAL or gi == 2:
        for q in group:
            ids = [o["id"] for o in q["o"]]
            if ids != sorted(ids):
                errors.append((q["id"], "grupo manual com ids embaralhados", ids))
    else:
        if all([o["id"] for o in q["o"]] == sorted(o["id"] for o in q["o"]) for q in group):
            errors.append((gi, "grupo 'primeira=correta' com ids sempre ordenados — revisar"))

if errors:
    print("ERROS DE CONFERÊNCIA:")
    for e in errors:
        print("  ", e)
    sys.exit(1)

# ----- itens mediados -----
med_key = {}
assert len({it["id"] for it in med}) == len(med), "ids de itens repetidos"
for it in med:
    # "d" do gabarito = código da competência N0 (N0C1…N0C8); o PESO vem de lib/config.js (COMPETENCIES)
    assert re.fullmatch(r"N0C[1-8]", it["c"]), (it["id"], "competência N0 inválida", it["c"])
    k = {"d": it["c"], "t": it["type"]}
    if it["type"] == "choice":
        k["a"] = it["answer"]
        assert it["answer"] in [o["id"] for o in it["options"]], it["id"]
    elif it["type"] == "build":
        k["a"] = it["words"]
    med_key[it["id"]] = k

client_med = []
for it in med:
    c = {k: v for k, v in it.items() if k not in ("answer", "words")}
    if it["type"] == "build":
        c["wordCount"] = len(it["words"])
        c["wordBag"] = it["words"][:]   # o navegador embaralha; a ordem certa só existe no servidor
    client_med.append(c)

# ----- escrita dos arquivos -----
HEADER_Q = """/* =============================================================================
   ARVORECER — BANCO DE QUESTÕES DO TESTE DE INTERPRETAÇÃO  (ARQUIVO GERADO)
   -----------------------------------------------------------------------------
   Gerado por tools/build_data.py a partir de tools/question_bank.source.js.
   NÃO EDITE À MÃO: altere a fonte e rode o script de novo.

   Estrutura:
     QUESTION_BANK  = lista de 50 GRUPOS; cada grupo tem 10 variantes equivalentes
                      da mesma tarefa. A cada teste, 1 variante é sorteada por grupo.
     SHORT_FORM_GROUPS = índices dos 30 grupos da versão rápida.

   Campos de cada variante:  id  = identificador (ex.: q03b)
                             s   = estímulo (texto/tabela, pode conter HTML)
                             q   = enunciado da pergunta
                             o   = alternativas [{id, text}]

   ATENÇÃO: este arquivo NÃO contém o gabarito nem o nome da competência.
   Isso fica em lib/answer_key.js (servidor), para que a resposta correta não possa
   ser lida no navegador.
   ============================================================================= */
"""
with open(os.path.join(ROOT, "public", "assets", "questions.js"), "w", encoding="utf-8") as f:
    f.write(HEADER_Q)
    f.write("\nconst QUESTION_BANK = [\n")
    for gi, g in enumerate(client_groups):
        dom = bank[gi][0]["d"]
        f.write("  // ---- Grupo %02d — %s ----\n" % (gi + 1, dom))
        f.write("  " + json.dumps(g, ensure_ascii=False, separators=(",", ":")) + ("," if gi < 49 else "") + "\n")
    f.write("];\n\n")
    f.write("// Grupos (índice a partir de 0) que compõem a versão rápida de 30 questões.\n")
    f.write("const SHORT_FORM_GROUPS = %s;\n" % json.dumps(SHORT_FORM_GROUPS))

HEADER_M = """/* =============================================================================
   ARVORECER — ITENS DO TESTE FUNDAMENTAL (N0)  (ARQUIVO GERADO)
   -----------------------------------------------------------------------------
   Gerado por tools/build_data.py a partir de tools/mediated_items.json.
   NÃO EDITE À MÃO: altere o JSON e rode o script de novo.

   Tipos de item:
     choice -> o aluno toca em uma alternativa (letra, figura ou sílaba)
     oral   -> o professor ouve/observa e registra: acertou / parcial / não acertou
     build  -> o aluno toca nas palavras, na ordem, para formar uma frase

   O gabarito NÃO está aqui: fica em lib/answer_key.js (servidor).
   ============================================================================= */
"""
with open(os.path.join(ROOT, "public", "assets", "mediated.js"), "w", encoding="utf-8") as f:
    f.write(HEADER_M)
    f.write("\nconst MEDIATED_ITEMS = [\n")
    for i, it in enumerate(client_med):
        f.write("  " + json.dumps(it, ensure_ascii=False, separators=(",", ":")) + ("," if i < len(client_med) - 1 else "") + "\n")
    f.write("];\n")

key = {
    "autonomo": {"groups": 50, "short": SHORT_FORM_GROUPS, "items": items_key},
    "mediado": {"items": med_key},
}
os.makedirs(os.path.join(ROOT, "lib"), exist_ok=True)
with open(os.path.join(ROOT, "lib", "answer_key.js"), "w", encoding="utf-8") as f:
    f.write("/* =============================================================================\n")
    f.write("   ARVORECER — GABARITO (ARQUIVO GERADO, SOMENTE SERVIDOR)\n")
    f.write("   Gerado por tools/build_data.py. Não edite à mão e NUNCA envie ao navegador.\n")
    f.write("   Fica em lib/ (fora de public/), então a Vercel não o publica como arquivo estático.\n")
    f.write("   Para cada id de questão: g = grupo, d = competência, a = alternativa correta.\n")
    f.write("   ============================================================================= */\n")
    f.write("'use strict';\nmodule.exports = ")
    f.write(json.dumps(key, ensure_ascii=False, separators=(",", ":")) + ";\n")

print("OK — %d variantes conferidas, %d itens mediados, sem divergências." % (len(items_key), len(med_key)))
checked = sum(1 for gi, g in enumerate(bank) if check(gi, g[0]) is not None)
print("Grupos conferidos por recálculo:", checked, "de 50 (+ q03 por programação dinâmica)")
