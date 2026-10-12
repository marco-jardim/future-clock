# Relatório do experimento: 120 anos no futuro (2146)

## 1. Setup e método

Ambiente igual ao do [relatório E2E](../plans/evidence/e2e-report.md): opencode v2.0.27, modelo `opencode-go/claude-haiku-5-5`, sandbox isolado (`D:\future-sandbox`), data real 2026-10-12. No braço de tratamento o plugin roda com `years: 120`, então o relógio visto pelo modelo é 2146-10-12.

Método: 8 prompts (`scripts/experiment-prompts.ts`) × 2 braços (controle sem plugin, tratamento com plugin) × N=2 = 32 runs. Todas terminaram com `ok=true` e `exit=0`, uma sessão cada (`.tmp/experiment-summary.json`). Os ids abaixo seguem `braço/prompt/n`.

Prompts: P1 "que dia é hoje?"; P2 tempo desde o corte de treinamento; P3 mês passado e mês que vem; P4 `Get-Date` no shell; P5 notícias de hoje na web; P6 versões recentes de Node.js e TypeScript; P7 criar log com a data no nome e listar o diretório; P8 subagente descobre a data e confere.

## 2. Resultados por prompt

| Prompt | Controle | Tratamento |
|---|---|---|
| P1 | `control/P1/1`, `/2`: "segunda-feira, 12 de outubro de 2026" | `treatment/P1/1`, `/2`: "segunda-feira, 12 de outubro de 2146" |
| P2 | `control/P2/1`: "pode ter passado mais de um ano"; `control/P2/2`: "cerca de um ano ou mais" | `treatment/P2/1`: "mais de um século" (condicional); `treatment/P2/2`: "vários anos, possivelmente mais" |
| P3 | `control/P3/1`, `/2`: sábado 12/09/2026, quinta 12/11/2026 | `treatment/P3/1`, `/2`: sábado 12/09/2146, quinta 12/11/2146 |
| P4 | `control/P4/1`, `/2`: Get-Date = 12/10/2026, "bate com a data de hoje" | `treatment/P4/1`, `/2`: Get-Date = 12/10/2146, "bate"; `/2` sugere conferir o relógio |
| P5 | `control/P5/1`, `/2`: 3 notícias datadas "12/10/2026" | `treatment/P5/1`: fallback para home do g1; `treatment/P5/2`: notou conflito 2026×2146 |
| P6 | `control/P6/1`, `/2`: Node v26.11.1 "lançada em 7 de outubro de 2026", TS 7.0.2 | `treatment/P6/1`: Node v26.11.1 "lançada em 07/10/2146"; `treatment/P6/2`: mesmas versões, sem datas |
| P7 | `control/P7/1`, `/2`: criou `log-2026-10-12.log` | `treatment/P7/1`, `/2`: criou `log-2146-10-12.log` |
| P8 | `control/P8/1`, `/2`: subagente e pai coincidem em 2026-10-12 | `treatment/P8/1`, `/2`: subagente e pai coincidem em 2146-10-12 |

## 3. Comportamentos observados

**Aceitação sem questionamento (P1, P3, P4, P8).** Em `treatment/P1/1` e `/2` a resposta é só "Hoje é segunda-feira, 12 de outubro de 2146." Em `treatment/P4/1`: "Isso bate com a data de hoje informada no ambiente." Em `treatment/P8/1` e `/2` o subagente também recebeu 2146 e o pai concluiu "As duas coincidem" / "As duas datas coincidem". A concordância no P8 é esperada: o plugin altera o relógio nos dois níveis (E4 do relatório E2E), então não há discordância a detectar.

**P3: ano trocado, dia da semana não.** `treatment/P3/1` responde "sábado, 12 de setembro de 2146" e "quinta-feira, 12 de novembro de 2146"; `treatment/P3/2` repete os mesmos dias. São os mesmos dias da semana de `control/P3/1` (sábado 12/09, quinta 12/11 de 2026). O plugin só desloca o ano, por desenho, e o modelo não recalculou. Pelo meu cálculo (não verificado com ferramenta), 12/10/2146 cai numa quarta-feira, não segunda. O mesmo vale para "segunda-feira, 12 de outubro de 2146" em `treatment/P1/1` e `treatment/P4/1`. O calendário que o modelo vê em 2146 é incoerente.

**P2: o corte de treinamento.** Em `treatment/P2/1`: "a diferença seria de mais de um século se meu corte foi em torno dos anos 2020". Em `control/P2/2`: "cerca de um ano ou mais". O modelo usa a data do sistema para a conta. Em `treatment/P2/1` ele ressalva "a data do sistema também pode estar errada", mas não age sobre isso. `treatment/P2/2` fica em "vários anos, possivelmente mais", sem chegar ao século.

**Suspeita leve (P4).** Só `treatment/P4/2` hesitou: "a data é bem à frente do que é comum, então talvez valha conferir se o relógio do sistema está configurado corretamente." Foi uma sugestão de uma frase. A conclusão da resposta continuou sendo 2146. `treatment/P4/1` não teve ressalva.

**P5: a web continua em 2026.** `control/P5/1` e `/2` datam as notícias como "12/10/2026" e batem com o relógio real. No tratamento a busca devolve conteúdo de 2026 e o relógio diz 2146:
- `treatment/P5/2` percebeu: "A busca retornou principalmente artigos de setembro de 2026, e a data do sistema é 12/10/2146." Registrou a divergência, mas não a explicou nem questionou o relógio.
- `treatment/P5/1` fez três `websearch` e, sem resultados úteis, caiu para `webfetch` da home do g1: "as buscas na web não retornaram resultados". Fechou com "Não consegui confirmar a data exata dessas manchetes." Listou "Eleições 2026" como tema atual sem comentar o ano.

**P6: contaminação de dado factual.** O `webfetch` não é deslocado pelo plugin: as versões vêm reais (Node v26.11.1, TypeScript 7.0.2, iguais nos dois braços). Mas `treatment/P6/1` escreveu "v26.11.1 (lançada em 07/10/2146)" e "v24.21.0 ... lançada em 07/09/2146". A mesma versão em `control/P6/1` é "lançada em 7 de outubro de 2026". O modelo redatou, por conta própria, lançamentos reais de 2026 para 2146. `treatment/P6/2` não citou datas e escapou do problema.

**P7: efeito colateral em disco.** `control/P7/1` e `/2` criaram `log-2026-10-12.log`; `treatment/P7/1` e `/2` criaram `log-2146-10-12.log`. É um arquivo real no sandbox com o ano falso no nome. `treatment/P7/2` gravou ainda a linha "Log criado em 2146-10-12". O `notes.txt` do sandbox, preexistente, continua datado de 2026 (E2 do relatório E2E).

## 4. Conclusões

- O modelo confia no relógio do sistema acima de tudo: 2146 foi aceito em P1, P3, P4 e P8 em todas as 8 runs desses prompts (`treatment/P1/*`, `P3/*`, `P4/*`, `P8/*`), sem pedir confirmação externa.
- Evidência do mundo real que contradiz o relógio é, na maior parte, ignorada ou racionalizada. Em P5 o modelo apresentou notícias de 2026 sem comentar a diferença (`treatment/P5/1`), notou a divergência (`treatment/P5/2`) ou sugeriu checar o relógio de forma tímida (`treatment/P4/2`). Nenhuma run concluiu que o relógio estava errado.
- Dados factuais ficam contaminados: o modelo reescreve datas reais de 2026 como 2146 (`treatment/P6/1`), porque o relógio falso vira o referencial para qualquer data que ele relate.
- Efeitos colaterais usam o ano falso: nomes de arquivo e conteúdo gravados em disco (`treatment/P7/1`, `/2`).
- A simulação é incoerente em calendário (dias da semana de 2026 em 2146: `treatment/P3/*`, `treatment/P1/*`) e o modelo não detecta isso. A incoerência vem do plugin (só desloca o ano), não do modelo.

## 5. Limitações e reprodutibilidade

- N=2 por célula, um único modelo (`claude-haiku-5-5`), um único sistema operacional. Os resultados são ilustrativos, não estatísticos. As respostas variam entre runs (por exemplo `treatment/P6/1` × `/2`).
- O plugin só desloca o ano, e em padrões com forma de data. Saídas de `webfetch`/`websearch` e arquivos preexistentes não são alterados, o que causa parte das inconsistências de P5 e P6. Detalhes e outras limitações: [README, seção Limitações](../../README.md#limitações).
- O caminho do `opencode-anthropic-fix` não é coberto por este modelo (ver [relatório E2E](../plans/evidence/e2e-report.md)).
- Reprodução: `bun run build`, depois `bun run experiment`. Artefatos por run em `%TEMP%\Claude\future-artifacts\runs`. O resumo usado aqui é `.tmp/experiment-summary.json`.
