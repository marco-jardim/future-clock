# Decisões do preflight (D-PF1..9)

| ID | Decisão |
|----|---------|
| D-PF1 | Adotados L1 (entrada de plugin em nível de projeto, por último no array) + L3 (passada final em `http.request`). L2 (re-anchor) NÃO implementado (L3 é viável). |
| D-PF2 | L3 detecta o wire format pelo FORMATO DO BODY (JSON com array `messages` + `system`), não pela URL, pois o anthropic-fix reescreve a URL para uma bridge local antes de nós. A substituição deve preservar url, method, headers (incl. header de ticket) e signal; descartar `content-length`; bodies em streaming são lidos via `clone().text()`. |
| D-PF3 | Apenas o adapter Anthropic Messages (provider em uso). Body desconhecido → intocado + aviso único (warn once). |
| D-PF4 | Raiz do sandbox `D:\future-sandbox`; isolamento = `XDG_CONFIG_HOME` + `--standalone`; E6 roda com a config real (sem override de XDG). |
| D-PF5 | Plugin distribuído como diretório `dist\future-clock\` {`package.json`, `server.js`}; o script de build deve produzir isso (o `dist\future-clock.js` de arquivo único do plano é substituído). |
| D-PF6 | Modelo padrão `opencode-go/claude-haiku-5-5`. |
| D-PF7 | Linear não usado (sem `.env` no repo). |
| D-PF8 | Problema conhecido do probe-runner: EBUSY ao recriar diretórios observados pelo serviço em background; algumas execuções (S-mutate, S-real) rodaram sem `opencode.json` e foram refeitas manualmente (S-mutate2, S-real2). Não corrigido (ferramenta de probe, substituída por `sandbox.ts` na Fase 2). |
| D-PF9 | Reescrita do rollover: apenas linhas que começam com `Today's date is now:` dentro de mensagens role `system` (hook context) / blocos de texto de mensagem (L3); mensagens de usuário permanecem intocadas. |
| D-QA1 | `years` mínimo passa a `years >= 4 \|\| years <= -3` (antes `\|years\| >= 3`), para idempotência quando o ano real vira entre eventos (QA-1 m1). |
| D-QA2 | Fronteira L3 reescreve em mensagens só linhas `Today's date is now:` de user/system; texto de assistant nunca é tocado (QA-1 m2). |
| D-QA2-1 | `cleanup` apaga alvos além do plano: também `D:\future-probe` e `probe\dist` (scratch do pre-flight). `runs` e `dumps` são preservados. |
| D-QA2-2 | E5 assere sobre o texto da resposta (o controle não tem plugin, logo não há dumps). |
| D-QA2-3 | E6 assere o sentinela do router ("Role Delegation Protocol") só nos bodies de sessões-pai (o router injeta apenas no orquestrador); sessões-filhas são verificadas como deslocadas. Identidade do texto do router contra um baseline sem plugin NÃO é testada ponta a ponta: coberta pelo teste unitário `coexistence.test.ts`. |
| D-QA2-4 | `run-e2e` é execução única (não retomável); saída vai para arquivo de log, com resumo de ≤4 KiB no stdout. |
| D-QA2-5 | `runEnv` remove do pai `INIT_CWD`/`PWD`/`OLDPWD`/`npm_*`/`NODE`/`NODE_ENV`/`OPENCODE*` para o opencode subir no sandbox. |
| D-QA2-6 | Varredura D13 (segredos) implementada para dumps (e2e) e para arquivos versionados (`test/unit/secrets.test.ts`), excluindo `docs/plans/*.md`. |
| D-QA2-7 | Gate de custo §7.1 (≤50 sessões) excedido: ~3 execuções e2e × 7 + reexecuções + 32 runs do experimento (+ filhos de subagente) ≈ 70 sessões em `opencode-go/claude-haiku-5-5` (modelo de baixo custo). Aceito. |
