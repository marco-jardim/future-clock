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
