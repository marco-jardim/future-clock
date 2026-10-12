# Relatório E2E — verificação ponta a ponta do future-clock

Data real da execução: 2026-10-12. Data simulada (`years: 120`): 2146.

## Ambiente

- opencode v2.0.27 (scoop), Bun 1.3.14, Windows / pwsh 7.6.6
- Modelo: `opencode-go/claude-haiku-5-5`
- Plugin: `dist\future-clock` com `{years:120}`
- Sandbox: `D:\future-sandbox` (git init, `notes.txt` com "Nota criada em 2026-10-12.")
- Isolamento: `XDG_CONFIG_HOME=%TEMP%\Claude\future-artifacts\iso\xdg-config` + `--standalone`
- Dumps via `FUTURE_CLOCK_DUMP_DIR`

## Resultado

Run 3 (`bun run test:e2e`): **7 pass, 0 fail — COMPLETE**.

| Teste | Cenário | Evidência |
|---|---|---|
| E0 | Isolamento | 1 dump primário; sem sentinelas (Sisyphus / Role Delegation Protocol ausentes); "Today's date: Mon Oct 12 2146" |
| E1 | Data no system prompt | "Today's date: Mon Oct 12 2146" no system; resposta do modelo com 2146 |
| E2 | Ferramentas (shell/read) | 3 dumps primários; tool_result do shell "segunda-feira, 12 de outubro de 2146 19:46:57"; tool_result do read manteve "Nota criada em 2026-10-12" (fora do escopo, intocado) |
| E3 | Descrição do websearch | "The current year is 2146" |
| E4 | Subagente | 4 dumps de 2 sessões (pai + subagente); no subagente, system com 2146 e Get-Date "segunda-feira, 12 de outubro de 2146 19:47:08" |
| E5 | Controle (sem plugin, sem dumps) | Resposta com o ano real 2026; sem 2146 |
| E6 | Config global real (opencode-anthropic-fix, opencode-model-router, opencode-telegram-plugin carregados) | Body contém o AGENTS.md global (Sisyphus) e o protocolo do model-router, e ainda assim "Today's date: Mon Oct 12 2146" e "current year is 2146"; nenhum erro `[future-clock]` |

Verificações transversais E7/E8, aplicadas em cada teste: nenhum ano real em forma de data em system/descrições; nenhum segredo nos dumps.

## Histórico

Runs 1–2 falharam (0 dumps em E0/E1/E6; E2/E4 inconclusivos). Causa: `bun run` injetava `INIT_CWD`/`npm_*` e o processo pai (uma sessão opencode) passava `OPENCODE_*`. O opencode filho subia em `D:\git\future-agents` em vez do sandbox e não carregava o plugin. Correção no commit "fix(runner): não herdar INIT_CWD/npm_*/OPENCODE_* do processo pai". Run 3 = 7/7.

## Limitação

O caminho do anthropic-fix (bridge local, body em stream, header de ticket) só é coberto por teste unitário simulado, porque o modelo usado (opencode-go) não é interceptado por ele.
