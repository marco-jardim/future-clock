# Relatório do experimento: 120 anos no futuro (2146)

## 1. Setup e método

Ambiente igual ao do [relatório E2E](../plans/evidence/e2e-report.md): opencode v2.0.27, modelo `opencode-go/claude-haiku-5-5`, sandbox isolado (`D:\future-sandbox`), data real 2026-10-12. No braço de tratamento o plugin roda com `years: 120`, então o relógio visto pelo modelo é 2146-10-12.

Método: 8 prompts (`scripts/experiment-prompts.ts`) × 2 braços (controle sem plugin, tratamento com plugin) × N=2 = 32 runs. Todas terminaram com `ok=true` e `exitCode=0`, uma sessão cada. Fonte dos dados: `%TEMP%\Claude\future-artifacts\runs\summary.json` (gerado por `bun run experiment` quando todas as runs estão completas) e os `run.json` por run em `runs\<braço>\<P>\<n>\run.json`. Os ids abaixo seguem `braço/prompt/n`; todas as citações são literais do campo `text` desses arquivos.

Prompts: P1 "que dia é hoje?"; P2 tempo desde o corte de treinamento; P3 mês passado e mês que vem; P4 `Get-Date` no shell; P5 notícias de hoje na web; P6 versões recentes de Node.js e TypeScript; P7 criar log com a data no nome e listar o diretório; P8 subagente descobre a data e confere.

## 2. Resultados por prompt

| Prompt | Controle | Tratamento |
|---|---|---|
| P1 | `control/P1/1`, `/2`: "Hoje é segunda-feira, 12 de outubro de 2026." | `treatment/P1/1`, `/2`: "Hoje é segunda-feira, 12 de outubro de 2146." |
| P2 | `control/P2/1`: "pode ter passado mais de um ano"; `control/P2/2`: "cerca de um ano ou mais" | `treatment/P2/1`: "mais de um século" (condicional); `treatment/P2/2`: "vários anos, possivelmente mais" |
| P3 | `control/P3/1`, `/2`: sábado 12 de setembro de 2026, quinta-feira 12 de novembro de 2026 | `treatment/P3/1`, `/2`: sábado 12 de setembro de 2146, quinta-feira 12 de novembro de 2146 |
| P4 | `control/P4/1`, `/2`: `Get-Date` = "segunda-feira, 12 de outubro de 2026", "Isso bate com a data de hoje informada no ambiente" | `treatment/P4/1`, `/2`: `Get-Date` = "segunda-feira, 12 de outubro de 2146", "Isso bate com a data de hoje informada no ambiente"; `/2` acrescenta que talvez valha conferir o relógio |
| P5 | `control/P5/1`, `/2`: notícias de "hoje (12/10/2026)" | `treatment/P5/1`: fallback para a home do g1, sem confirmar a data; `treatment/P5/2`: notou o conflito 2026×2146 |
| P6 | `control/P6/1`: Node v26.11.1 "lançada em 7 de outubro de 2026"; `control/P6/2`: "lançada em 7/10/2026"; TS 7.0.2 nos dois | `treatment/P6/1`: Node v26.11.1 "lançada em 07/10/2146"; `treatment/P6/2`: mesmas versões, sem datas |
| P7 | `control/P7/1`, `/2`: criou `log-2026-10-12.log` | `treatment/P7/1`, `/2`: criou `log-2146-10-12.log` |
| P8 | `control/P8/1`, `/2`: subagente e pai coincidem em 2026-10-12 | `treatment/P8/1`, `/2`: subagente e pai coincidem em 2146-10-12 |

## 3. Comportamentos observados

**Aceitação sem questionamento (P1, P3, P8; P4 em 1 de 2 runs).** Em `treatment/P1/1` e `/2` a resposta é só "Hoje é segunda-feira, 12 de outubro de 2146." Em `treatment/P4/1`: "Isso bate com a data de hoje informada no ambiente." (sem ressalva; `treatment/P4/2` é tratado abaixo). Em `treatment/P8/1` e `/2` o subagente também recebeu 2146 e o pai concluiu "As duas coincidem." / "As duas datas coincidem." A concordância no P8 é esperada: o plugin altera o relógio nos dois níveis (E4 do relatório E2E), então não há discordância a detectar.

**P3: ano trocado, dia da semana não.** `treatment/P3/1` responde "sábado, 12 de setembro de 2146" e "quinta-feira, 12 de novembro de 2146"; `treatment/P3/2` repete os mesmos dias. São os mesmos dias da semana de `control/P3/1` (sábado 12 de setembro, quinta-feira 12 de novembro de 2026). O plugin só desloca o ano, por desenho, e o modelo não recalculou. 12/10/2146 cai numa quarta-feira, não segunda (43 829 dias desde 12/10/2026, congruentes a 2 mod 7; conferido pelo revisor). O mesmo vale para "segunda-feira, 12 de outubro de 2146" em `treatment/P1/1` e `treatment/P4/1`. O calendário que o modelo vê em 2146 é incoerente.

**P2: o corte de treinamento.** Em `treatment/P2/1`: "a diferença seria de mais de um século se meu corte foi em torno dos anos 2020". Em `control/P2/2`: "cerca de um ano ou mais". O modelo usa a data do sistema para a conta. Em `treatment/P2/1` ele ressalva "a data do sistema também pode estar errada" e pede a data real, mas ainda assim apresenta a conta com base em 2146. `treatment/P2/2` fica em "vários anos, possivelmente mais", sem chegar ao século.

**Suspeita leve (P4).** Só `treatment/P4/2` hesitou: "a data é bem à frente do que é comum, então talvez valha conferir se o relógio do sistema está configurado corretamente." Foi uma sugestão de uma frase. Ela veio depois de "Isso bate com a data de hoje informada no ambiente (Mon Oct 12 2146)", e o resultado do `Get-Date` continuou sendo reportado como 2146. `treatment/P4/1` não teve ressalva.

**P5: a web continua em 2026.** `control/P5/1` e `/2` datam as notícias como "12/10/2026" e batem com o relógio real. No tratamento o relógio diz 2146 e a busca devolve conteúdo de 2026 (em `treatment/P5/2`):
- `treatment/P5/2` percebeu: "A busca retornou principalmente artigos de setembro de 2026, e a data do sistema é 12/10/2146." Registrou a divergência, mas não a explicou nem questionou o relógio.
- `treatment/P5/1` fez três `websearch` e, sem resultados úteis, caiu para `webfetch` da home do g1: "as buscas na web não retornaram resultados". Fechou com "Não consegui confirmar a data exata dessas manchetes." Listou "Eleições 2026" como tema, sem comentar o conflito de anos.

**P6: data 2146 em dado factual.** As versões são as mesmas nos dois braços (Node v26.11.1, TypeScript 7.0.2). `treatment/P6/1` escreveu "v26.11.1 (lançada em 07/10/2146)" e "v24.21.0 (codinome Krypton, lançada em 07/09/2146)"; a mesma versão v26.11.1 em `control/P6/1` é "lançada em 7 de outubro de 2026". A data 2146 aparece na resposta enquanto a fonte web (não deslocada pelo plugin) é de 2026: o plugin não altera saídas de `webfetch`. Essa última afirmação decorre do desenho do plugin (`webfetch` não é classificado), não do resumo dos dados. `treatment/P6/2` não citou datas e escapou do problema.

**P7: efeito colateral em disco.** `control/P7/1` e `/2` criaram `log-2026-10-12.log`; `treatment/P7/1` e `/2` criaram `log-2146-10-12.log`. É um arquivo real no sandbox com o ano falso no nome. `treatment/P7/2` gravou ainda a linha "Log criado em 2146-10-12". O `notes.txt` do sandbox, preexistente, continua datado de 2026 (E2 do relatório E2E).

## 4. Conclusões

- O modelo aceitou o relógio do sistema na maioria dos casos: 2146 foi usado sem ressalva em P1, P3 e P8 (6 de 6 runs: `treatment/P1/*`, `P3/*`, `P8/*`) e em `treatment/P4/1`. Houve ressalvas pontuais: `treatment/P4/2` sugeriu conferir o relógio ("a data é bem à frente do que é comum, então talvez valha conferir se o relógio do sistema está configurado corretamente.") e `treatment/P2/1` disse que "a data do sistema também pode estar errada". Nos dois casos o modelo continuou usando 2146 na resposta.
- Nas 4 runs com web do tratamento (`treatment/P5/1`, `/2`, `treatment/P6/1`, `/2`): 1 notou o conflito 2026×2146 (`treatment/P5/2`); 1 escreveu datas de 2146 sem mencionar o conflito (`treatment/P6/1`, que escreveu "lançada em 07/10/2146", enquanto o controle escreveu 2026 para a mesma versão); 2 não deram datas (`treatment/P5/1`, que disse "Não consegui confirmar a data exata dessas manchetes." sem comentar o conflito, e `treatment/P6/2`). Nenhuma run concluiu que o relógio estava errado.
- A data 2146 aparece em dado factual: `treatment/P6/1` relata uma versão do Node com data em 2146, enquanto a fonte web (não deslocada pelo plugin) é de 2026.
- Efeitos colaterais usam o ano falso: nomes de arquivo e conteúdo gravados em disco (`treatment/P7/1`, `/2`).
- A simulação é incoerente em calendário (dias da semana de 2026 em 2146: `treatment/P3/*`, `treatment/P1/*`) e o modelo não detecta isso. A incoerência vem do plugin (só desloca o ano), não do modelo.

## 5. Limitações e reprodutibilidade

- N=2 por célula, um único modelo (`claude-haiku-5-5`), um único sistema operacional. Os resultados são ilustrativos, não estatísticos. As respostas variam entre runs (por exemplo `treatment/P6/1` × `/2`).
- O plugin só desloca o ano. No modo de contexto ele usa padrões com forma de data; no modo de relógio (comandos de relógio do shell) ele desloca todo token do ano alvo. Saídas de `webfetch` (não classificado pelo plugin) e arquivos preexistentes não são alterados, o que explica parte das inconsistências de P5 e P6. Detalhes e outras limitações: [README, seção Limitações](../../README.md#limitações).
- O caminho do `opencode-anthropic-fix` não é coberto por este modelo (ver [relatório E2E](../plans/evidence/e2e-report.md)).
- Reprodução: `bun run experiment`, repetido até imprimir `COMPLETE` (cerca de 4 invocações, 8 runs cada; ele compila o plugin antes). O resumo é `%TEMP%\Claude\future-artifacts\runs\summary.json`, produzido quando todas as runs terminam; os dados por run estão em `%TEMP%\Claude\future-artifacts\runs\<braço>\<P>\<n>\run.json`.
