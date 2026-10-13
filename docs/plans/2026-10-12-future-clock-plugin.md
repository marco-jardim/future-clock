# Plano — plugin `future-clock` (opencode v2): o modelo "vive" N anos no futuro

- **Data:** 2026-10-12 · **Revisão:** 4 (enxuta)
- **Repositório:** `D:\git\future-agents` (branch `main`) · **Plataforma:** win32, pwsh 7
- **Alvo:** **apenas opencode v2** (linha 2.0.x). v1 não é suportado.
- **Decisões do usuário:**
  - escopo "só o relógio";
  - **configuração única: `years`**;
  - **troca só o ano**;
  - convivência com outros plugins (inclusive o model-router), com o `future-clock` aplicado **por último**;
  - experimento comparativo **isolado**;
  - menos testes, guiados por ROI.

---

## 0. Diretivas de execução (LEIA ANTES DE TUDO)

### 0.1 Execução contínua
Execute **do início ao fim, wave após wave, sem interrupções**. Pare e pergunte ao humano **somente** em quatro casos:
- (a) ambiguidade que o plano não resolve e cujas opções divergem em 2x+ de esforço ou no comportamento observável;
- (b) problema crítico ou **BLOQUEIO** listado no plano;
- (c) §0.6 esgotada;
- (d) o `router_run` recusa um comando sem script equivalente (§0.7).

Nos demais casos, aplique a regra de decisão do plano, registre-a via escriba (§0.8) e siga.

### 0.2 Solução definitiva
Toda phase entrega a solução **definitiva** do seu sub-objetivo. Não são aceitos stubs, TODOs nem "completo depois".

### 0.3 Paralelismo seguro
1. **Um escritor por arquivo.** Cada task declara `OWNS`. Dois agentes nunca possuem o mesmo arquivo.
2. **Nenhuma leitura de arquivo em edição.** `READS` só aponta para arquivos **congelados** (task dona concluída e verificada).
3. **Checks de task paralela tocam só os próprios testes.** Use `check: testsPass` (o router roda só os testes afetados) ou `bun test <seus arquivos>`. O typecheck e a suíte completa rodam **só nos pontos de junção**, por um `runner`.
4. **Arquivos compartilhados são serializados.** `D:\git\future-agents\package.json`, `D:\git\future-agents\tsconfig.json`, `D:\git\future-agents\.gitignore` e `D:\git\future-agents\src\core\types.ts` pertencem ao bootstrap B.1 e congelam depois dele. Uma mudança posterior é uma task isolada, despachada sozinha.
5. Um passo paralelo (`∥`) é despachado numa única mensagem. O passo seguinte só sai depois do checkpoint de junção: `bun run typecheck` → `bun run test` → `bun run commit`.

### 0.4 Commit often (fila)
- **Ninguém roda git diretamente.** A última subtask de cada task grava `D:\git\future-agents\.tmp\commits\<task-id>.json` = `{ "message": "...", "paths": ["..."] }`.
- Na junção, um `runner` executa `bun run commit`. O script `D:\git\future-agents\scripts\git\commit.ts` processa a fila em ordem. Para cada item:
  1. valida Conventional Commits;
  2. **rejeita** `Co-Authored-By` e "Generated with";
  3. faz `git add -- <paths>` só dos paths listados;
  4. faz `git commit -F`;
  5. apaga o item.

  O script para na primeira falha.
- Faça commit **por task**, **por correção de QA** e **por atualização de evidência**. Nunca dê push sem pedido; nunca use force push.
- Repasse a todo delegado: **proibido** trailer de IA (`Co-Authored-By` de qualquer modelo, "Generated with ...").

### 0.5 Anotações do model-router
- **Role** + **route line** (primeira linha do dispatch, literal) + bloco `[acceptance]` + `VERIFY:required` (quando algo depende da task) ou `deferred`.
- **`[tier:heavy]` aparece somente nos passos de QA** (route com `tier=heavy pin`). **QA é sempre heavy**, inclusive re-revisões. Nenhuma outra task fixa tier.
- Todo prompt de dispatch tem: route line, TASK, EXPECTED OUTCOME, TOOLS, MUST DO, MUST NOT DO, CONTEXT, ENVIRONMENT (`Working directory is D:\git\future-agents. Platform: win32. Shell: pwsh.`), sempre com paths absolutos.
- Acesso a `C:\Users\Marquinho\AppData\Local\Temp\Claude\` exige `needs=external_dir`. O primeiro `bun install` exige `needs=network`.

### 0.6 QA e recuperação de falhas
1. No fim de cada phase, e no fim do plano (QA-G), um `reviewer` `[tier:heavy]` faz **revisão adversarial** e roda os checks com `router_run`. O reviewer **não escreve arquivos**: entrega **especificações de ataque** (entrada, saída esperada, arquivo-alvo).
2. Os achados são classificados como `BLOCKER | MAJOR | MINOR | NIT`. **Todos são corrigidos.** Um NIT só pode ser recusado com justificativa no `qa-log.md`.
3. Um `implementer` corrige e transforma cada ataque válido em teste. Depois, re-revisão heavy até **zero BLOCKER e zero MAJOR**.
4. Com 3 ciclos sem convergir, ou 3 falhas seguidas no mesmo problema: PARE, documente no `qa-log.md` e pergunte ao humano. A reversão é **por phase**, executada pelo humano ou por agente de tier explícito.
5. São proibidos: `as any`, `@ts-ignore`, `@ts-expect-error`, catch vazio, pular ou apagar teste que falha, e shotgun debugging.

### 0.7 Processos externos
- git, opencode, captura de ambiente e experimento rodam **só via scripts do `package.json`**, executados por um `runner` com `router_run`. Os scripts não recebem argumentos; cada variante é um script próprio.
- Scripts longos (`probe`, `test:e2e`, `experiment`) são **retomáveis**:
  - cada invocação processa até 8 runs de modelo;
  - grava o estado em `C:\Users\Marquinho\AppData\Local\Temp\Claude\future-artifacts\state\`;
  - imprime no máximo 4 KiB e termina com `COMPLETE` quando acabar.

  O runner repete a invocação até ver `COMPLETE`.
- O `router_run` remove variáveis de ambiente com credenciais, mas os arquivos de credenciais continuam acessíveis. A U11 verifica se o `opencode run` autentica nessas condições. Se o comando for recusado ou a autenticação falhar, pergunte ao humano.

### 0.8 Escriba de evidências
Os arquivos `D:\git\future-agents\docs\plans\evidence\preflight.md`, `decisions.md`, `qa-log.md` e `e2e-report.md` têm **um único escritor**: o escriba. Ele é um `general` com a route `[route class=other risk=low scope=single needs=edit,external_dir root=D:\git\future-agents]`, despachado só nas junções e nunca em paralelo com outro escriba.

---

## 1. Objetivo

Plugin opencode v2 `future-clock` cuja **única configuração** é:

```json
{ "plugins": [{ "package": "file:///D:/git/future-agents/dist/future-clock.js", "options": { "years": 120 } }] }
```

Com ele ativo, **o ano** que o modelo percebe como "agora" passa a ser `ano real + years`. Dia, mês, hora e dia da semana ficam como estão: `Today's date: Mon Oct 12 2026` vira `Today's date: Mon Oct 12 2146`.

| # | Fonte de "agora" | Onde é reescrita |
|---|---|---|
| S1 | Linha `Today's date: …` no system | hook `context` + passada final (L3) |
| S2 | Linha de virada de dia `Today's date is now: …` no histórico | hook `context` + L3 |
| S3 | `The current year is YYYY` nas descrições de tools | hook `context` + L3 |
| S4 | Saída de comandos de leitura de relógio no tool `shell` | hook `execute.after` + L3 |

**R-COEX:** o plugin coexiste com outros plugins, inclusive o model-router, sem quebrá-los. O conteúdo enviado ao modelo reflete as modificações do `future-clock` **depois** das de todos os outros plugins.

**Não-objetivos:**
- opencode v1;
- deslocar dia, mês ou dia da semana;
- alterar efeitos reais (argumentos, relógio do sistema, arquivos);
- deslocar web, arquivos, `git log`, mtimes, epoch ou ticks;
- inverter datas digitadas pelo modelo.

### 1.1 Decisões de design

| ID | Decisão |
|---|---|
| D1 | Bun + `tsc --noEmit` em modo strict. DevDeps em versão exata: `typescript`, `@types/bun`. Sem property tests e sem limite de cobertura. |
| D2 | API Promise da v2. A forma do export é decidida pela U5: se `Plugin.define` for só helper de tipagem, usar `import type` + objeto literal; senão, import de runtime resolvido pelo host. Se houver devDep `@opencode/plugin`, ela fica na versão exata do host (U1). |
| D3 | Build em arquivo único `D:\git\future-agents\dist\future-clock.js`, referenciado via `file:///`. Se a U5 mostrar que isso falha, copiar para `<sandbox>\.opencode\plugins\`. |
| D4 | **Opção única `years`**: inteiro com `years ≥ 4 ou years ≤ −3` e ano resultante em [1000, 9999]. Inválido → erro claro no `setup`. Instrumentação de teste **não é configuração**: a env `FUTURE_CLOCK_DUMP_DIR` ativa o dump (D11). |
| D5 | **Troca só do ano.** Anos-alvo = `{Y−1, Y, Y+1}`, onde Y é o ano local real lido **por evento**, só em `D:\git\future-agents\src\plugin\index.ts`. O Y±1 cobre `AddMonths(±1)` na virada de ano. O core é puro: recebe `realYear` e `years`. **Idempotência:** como `years ≥ 4 ou years ≤ −3`, o ano trocado nunca volta ao conjunto-alvo. |
| D6 | **Dois modos.** **`context`** (system, descrições, linha de virada): o ano é trocado só dentro de padrões com forma de data: linha `Today's date( is now)?:`, `current year is YYYY`, ISO `YYYY-MM-DD…`, `Mon Oct 12 YYYY`, `October 12, YYYY`, `12 de outubro de YYYY`, `dd/mm/YYYY` / `mm/dd/YYYY`. **`clock`** (output classificado do `shell`): troca **todo** token de ano-alvo delimitado por não-dígitos (`(?<!\d)YYYY(?!\d)`) e o prefixo de sequências compactas de 8, 12 ou 14 dígitos (`yyyyMMdd…`). |
| D7 | **Classificador de comando** para S4. Positivos: `Get-Date` (inclusive dentro de `pwsh -c`), `date` como comando, `[DateTime]::Now`, `[DateTime]::UtcNow`, `[DateTime]::Today`, `[DateTimeOffset]::Now`, `new Date(`/`Date.now(` em `node -e`/`bun -e`, `datetime.now`/`datetime.today` em `python -c`. |
| D8 | **Hooks nunca derrubam a sessão.** try/catch com log (logger do ctx ou `console.error("[future-clock] …")`). O evento segue intacto. |
| D9 | **"Por último" (R-COEX).** São três camadas: **L1** — o `future-clock` fica por último no array `plugins`, ou usa a opção de prioridade, se a U13 revelar uma; **L3** — passada final no hook `http.request`: o body serializado é reescrito pelo **adaptador do provider em uso** (U4), aplicando D6 a system, descrições, linha de virada e tool results cujo `tool_use` correspondente é um `shell` classificado; **L2** — re-registro dos hooks no primeiro evento, implementado **só se a L3 for inviável**. **Regra de decisão:** L3 viável → L3 é a garantia. L3 inviável, mas L1/L2 garantem a ordem → seguir e documentar. Nenhuma das duas → **BLOQUEIO**. Se o model-router mutar o body depois da L3 e não houver como vencê-lo (U13/U14) → **BLOQUEIO**. |
| D10 | **Escopo em convivência.** No system e nas descrições, o modo `context` age em **qualquer parte**, inclusive no texto de outros plugins, que fica byte a byte idêntico fora dos anos trocados. Nas mensagens, age só na linha de virada e nos tool results classificados. Mensagens do usuário nunca são tocadas. |
| D11 | **Dump + detector na fronteira**, depois da L3, ativos só com `FUTURE_CLOCK_DUMP_DIR`. O dump grava **somente o body** em `<dir>\<sessionID>-<kind>-<seq>.json`, mais um arquivo lateral `.l3.json` com o número de correções feitas pela L3. **Nunca grava headers nem URL.** O detector emite warn se o ano real aparecer em forma de data no system, nas descrições ou nos tool results classificados. A saída da L3 é **determinística**, para preservar o prompt cache. |
| D12 | **Isolamento** (§3) em E0–E5 e no experimento. E6 roda com a config global real, para exercitar o model-router. |
| D13 | **Varredura de segredos** por formato real: `\bsk-[A-Za-z0-9_-]{20,}`, `"(authorization\|x-api-key)"\s*:\s*"`, `Bearer\s+\S{20,}`. Exclui `D:\git\future-agents\docs\plans\*.md`. |

---

## 2. Fatos e incógnitas

### 2.1 Confirmados por pesquisa (`github.com/anomalyco/opencode` branch `dev`; `opencode.ai/v2/docs`)
- `packages/core/src/instructions/builtins.ts`: `Today's date: ${toDateString}`; a virada de dia gera `Today's date is now: …`.
- A data fica congelada por epoch de sessão. A virada entra no histórico, e a compactação renova o baseline.
- `tool/plugin/websearch.ts`: `The current year is ${getFullYear()}`, uma constante de módulo.
- Hooks disponíveis: `ctx.session.hook("context")` com `system`, `tools[n].description` e `messages`; `ctx.tool.hook("execute.after")` com `input: unknown` readonly e `result`/`error` mutáveis. Os callbacks rodam em **ordem de registro**. Existe um hook `http.request`, mas com **domínio e shape não confirmados**.
- O tool de shell se chama `shell`. O resultado tem `{ output, content:[{type:"text",text}], metadata }`.
- A CLI tem `opencode run`, `--standalone`, `--server` e `debug paths`.

### 2.2 Incógnitas (resolvidas no PF-G)

| ID | Pergunta | Fonte | Regra se desfavorável |
|---|---|---|---|
| U1 | Binário, versão, dirs (`opencode debug paths`), versão do `@opencode/plugin` do host | preflight | v2 ausente → **BLOQUEIO** |
| U2 | Hook `context`: shapes e mutabilidade de `system`, `tools` e `messages` | probe | sem mutabilidade → só a L3; se a L3 também for inviável → **BLOQUEIO** |
| U3 | `execute.after` dispara para `shell` na sessão principal **e nas filhas**? A mutação chega ao modelo? Qual o campo do comando em `input`? | probe | só a L3 cobre S4 (pelo mapeamento `tool_use`); se também falhar → **BLOQUEIO** |
| U4 | `http.request`: domínio, shape, **body mutável**, dispara nas filhas, wire format do provider em uso | probe + researcher | ver a regra da D9 |
| U5 | Carga via `file:///` + `options` no win32; se `Plugin.define` é identidade | probe | fallback da D3 |
| U6 | Flags do `opencode run` (modelo, diretório, continuar sessão), códigos de saída, tipo do binário (exe ou shim `.cmd`) | preflight | shim → spawn via `cmd.exe /d /s /c` |
| U7 | Shell do tool `shell`, cultura, saídas **literais** de `Get-Date`, `Get-Date -Format o`, `(Get-Date).Year`, `Get-Date -Format yyyyMMdd`, `Get-Date \| Format-List` | preflight | define as fixtures |
| U8 | API de log no ctx | probe | `console.error` |
| U9 | **Receita de isolamento** (§3) | probe (matriz) | nenhuma variante isola → **BLOQUEIO** |
| U10 | Texto literal e localização da linha de virada de dia | researcher | o regex aceita as variantes encontradas |
| U11 | `opencode run` autentica sob `router_run`? | preflight | §0.7 |
| U12 | `websearch` presente na lista de tools do provider usado? | probe | E3 vira N/A justificado |
| U13 | Ordem dos hooks entre plugins: carga global vs projeto vs posição no array; existe opção de prioridade? | probe (plugins de probe A e B em ordens alternadas) + researcher (`packages/core/src/plugin/hooks.ts`) | D9 |
| U14 | model-router: quais hooks registra; muta o body no `http.request`? reestrutura o `system`? | preflight (extrai os registros de hook do plugin instalado para `future-artifacts\router-hooks.txt`) + explorer | D9 |

---

## 3. Isolamento do experimento (D12)

Hipótese inicial, com a receita proposta pelo usuário ampliada:

```powershell
$env:OPENCODE_CONFIG_DIR = "C:\Users\Marquinho\AppData\Local\Temp\Claude\future-artifacts\config"
$env:XDG_CONFIG_HOME     = "C:\Users\Marquinho\AppData\Local\Temp\Claude\future-artifacts\xdg-config"  # se OPENCODE_CONFIG_DIR for aditivo
opencode run --standalone <flags da U6> "<prompt>"   # cwd = C:\Users\Marquinho\AppData\Local\Temp\Claude\future-sandbox
```

- O `OPENCODE_CONFIG_DIR` era aditivo na v1; na v2 isso não está confirmado. O `--standalone` provavelmente impede o cliente de se conectar ao serviço que já roda com a config global. O `-s <sessão>` **não** é usado nos runs.
- O sandbox recebe `git init` e um `opencode.json` com modelo explícito, `"autoupdate": false` e o plugin. O grupo de **controle** é o mesmo sandbox **sem** o plugin.
- O diretório de dados não é isolado, para preservar a autenticação. Os sessionIDs criados ficam registrados em `future-artifacts\sessions.txt`.
- **Prova:** o `preflight` extrai sentinelas da config global real (linhas distintivas dos `AGENTS.md` globais e os nomes dos plugins globais) para `future-artifacts\sentinels.json`, fora do git. O `probe` testa a matriz: (a) nenhuma variável; (b) `OPENCODE_CONFIG_DIR`; (c) `XDG_CONFIG_HOME`; (d) b+c; cada uma com e sem `--standalone`. **Vence a variante mais simples com zero sentinelas no dump e apenas agentes built-in.** Ela é congelada em `D:\git\future-agents\scripts\lib\isolation.ts`.

---

## 4. Mapa de execução

```
PF-G  B.1 bootstrap ─▶ B.2 install+commit ─▶ G.1 preflight ─▶ G.2 probe ─▶ G.3 (explorer ∥ researcher) ─▶ G.4 escriba+commit
Wave 1 · Phase 1 — Plugin completo (core + hooks + bundle)
      (1.1 ∥ 1.2 ∥ 1.3) ─▶ junção ─▶ (1.4 ∥ 1.5 ∥ 1.6) ─▶ junção ─▶ 1.7 ─▶ junção ─▶ 1.8 testes de fim de phase ─▶ QA-1 [tier:heavy] ─▶ fixes
Wave 2 · Phase 2 — Verificação ponta a ponta + experimento + docs
      2.1 ─▶ (2.2 ∥ 2.3) ─▶ junção ─▶ 2.4 e2e ─▶ 2.5 experimento ─▶ (2.6 ∥ 2.7) ─▶ 2.8 limpeza ─▶ QA-2 [tier:heavy] ─▶ fixes
QA-G [tier:heavy] ─▶ fixes ─▶ aceite global
```

---

## 5. Pre-flight Global (PF-G)

**B.1 Bootstrap** — `implementer` — `VERIFY:required`
- Route: `[route class=implement risk=medium scope=multi needs=edit d=deterministic root=D:\git\future-agents]`
- **OWNS:**
  - `D:\git\future-agents\package.json`
  - `D:\git\future-agents\tsconfig.json`
  - `D:\git\future-agents\.gitignore`
  - `D:\git\future-agents\src\core\types.ts`
  - `D:\git\future-agents\scripts\git\commit.ts`
  - `D:\git\future-agents\scripts\lib\artifacts.ts`
  - `D:\git\future-agents\scripts\preflight\env.ts`
  - `D:\git\future-agents\scripts\probe\probe-a.ts`
  - `D:\git\future-agents\scripts\probe\probe-b.ts`
  - `D:\git\future-agents\scripts\probe\run-probe.ts`
  - `D:\git\future-agents\test\unit\scripts\bootstrap.test.ts`
- B.1.1 `package.json` (`"type":"module"`, `"private":true`). Scripts congelados:
  - `typecheck` = `tsc --noEmit`
  - `test` = `bun test ./test/unit`
  - `check` = `bun run typecheck && bun run test && bun run build`
  - `build` = `bun build src/plugin/index.ts --outfile dist/future-clock.js --target bun --external @opencode/plugin --external effect`
  - `test:e2e` = `bun scripts/run-e2e.ts`
  - `preflight` = `bun scripts/preflight/env.ts`
  - `probe` = `bun scripts/probe/run-probe.ts`
  - `sandbox` = `bun scripts/sandbox.ts`
  - `sandbox:control` = `bun scripts/sandbox.ts control`
  - `experiment` = `bun scripts/experiment.ts`
  - `commit` = `bun scripts/git/commit.ts`
  - `cleanup` = `bun scripts/cleanup.ts`

  Todos os testes unitários ficam em `D:\git\future-agents\test\unit\`.
- B.1.2 `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `module: "preserve"`, `moduleResolution: "bundler"`, `skipLibCheck`, `types: ["bun"]`, `include: ["src","test","scripts"]`.
- B.1.3 `.gitignore`: acrescentar `.tmp/`.
- B.1.4 `src\core\types.ts`:
  ```ts
  export type Mode = "context" | "clock";
  export interface ShiftInput { text: string; realYear: number; years: number; mode: Mode; }
  export interface ShiftResult { text: string; count: number; }
  export interface ClockClassification { isClockRead: boolean; matched: readonly string[]; }
  ```
- B.1.5 `commit.ts` (§0.4).
- B.1.6 `artifacts.ts`: paths de `C:\Users\Marquinho\AppData\Local\Temp\Claude\future-sandbox` e `C:\Users\Marquinho\AppData\Local\Temp\Claude\future-artifacts\` (`config`, `xdg-config`, `dumps`, `runs`, `state`). Inclui `assertUnder(root, path)`, que usa `realpath` e recusa `..`, UNC, paths relativos e junction para fora.
- B.1.7 `env.ts`: grava `future-artifacts\preflight-env.json` com as respostas de U1, U6, U7, U11 e U14 (extrato `router-hooks.txt`) e as sentinelas da §3.
- B.1.8 Probes:
  - `probe-a.ts` e `probe-b.ts` registram **cada hook num try/catch próprio** e gravam em JSONL a ordem de execução e os shapes, sem truncar linhas com data;
  - aplicam marcadores de mutação (`[[PROBE-SYS]]`, `[[PROBE-TOOL]]`, `[[PROBE-DESC]]`, `[[PROBE-BODY]]` via `http.request`);
  - `run-probe.ts` roda a matriz de isolamento e as duas ordens de A/B, além dos cenários Get-Date direto, Get-Date via subagente e "repita os marcadores [[…]] que você vê";
  - é retomável.
- Testes (`bootstrap.test.ts`, ~8 casos):
  - `commit.ts` rejeita trailer de IA e mensagem fora do padrão;
  - `commit.ts` adiciona só os paths listados (montagem dos argumentos);
  - `assertUnder` recusa `..`, UNC, relativo e junction para fora.
- Fila: `chore(bootstrap): ferramentas de pre-flight e contratos`.
- `[acceptance]` `check: testsPass` · `criteria: scripts da lista presentes; sem as any, @ts-ignore ou catch vazio` · `[/acceptance]`

**B.2** — `runner` — Route: `[route class=other risk=low scope=single needs=shell,network root=D:\git\future-agents]`
- Executa `bun install`, depois `bun run typecheck`, `bun run test` e `bun run commit`. O commit inclui este plano.

**G.1** — `runner` (`needs=shell,external_dir`): `bun run preflight`. **BLOQUEIO** se a U1 ou a U11 falharem.

**G.2** — `runner` (`needs=shell,external_dir`): `bun run probe` até `COMPLETE`.

**G.3** — em paralelo:
- `explorer`, route `[route class=recon risk=low scope=multi needs=external_dir root=D:\git\future-agents]`: responde U1–U9 e U11–U14 com trechos literais, escolhe a receita de isolamento e aplica a regra da D9.
- `researcher`, route `[route class=search risk=low scope=multi needs=web]`: responde a U10, complementa a U4 (wire format e mutabilidade do body) e a U13 (`hooks.ts`).

**G.4** — escriba: grava `preflight.md` e `decisions.md` e cria `.tmp\commits\G.4.json`. A junção commita.

**Condições de bloqueio do PF-G:** as marcadas **BLOQUEIO** na §2.2 e na D9. Pergunte ao humano antes da Wave 1.

---

## 6. WAVE 1 — Phase 1: Plugin completo

**Sub-objetivo:** plugin v2 funcional e definitivo, com S1–S4, as camadas L1/L3 (e a L2 se a D9 exigir), o dump e o bundle.

### 6.0 Posse de arquivos

| Task | OWNS | READS |
|---|---|---|
| 1.1 | `D:\git\future-agents\src\core\years.ts`, `D:\git\future-agents\test\unit\core\years.test.ts` | `types.ts`, `preflight.md`, `preflight-env.json` |
| 1.2 | `D:\git\future-agents\src\core\classify.ts`, `D:\git\future-agents\test\unit\core\classify.test.ts` | `types.ts`, `preflight.md` |
| 1.3 | `D:\git\future-agents\src\plugin\ports.ts`, `D:\git\future-agents\src\plugin\options.ts`, `D:\git\future-agents\test\unit\plugin\fake-ctx.ts`, `D:\git\future-agents\test\unit\plugin\options.test.ts` | `preflight.md` |
| 1.4 | `D:\git\future-agents\src\plugin\context-hook.ts`, `D:\git\future-agents\test\unit\plugin\context-hook.test.ts` | 1.1–1.3 (congelados) |
| 1.5 | `D:\git\future-agents\src\plugin\tool-hook.ts`, `D:\git\future-agents\test\unit\plugin\tool-hook.test.ts` | 1.1–1.3 |
| 1.6 | `D:\git\future-agents\src\plugin\boundary-hook.ts`, `D:\git\future-agents\src\plugin\wire.ts`, `D:\git\future-agents\test\unit\plugin\boundary-hook.test.ts`, `D:\git\future-agents\test\unit\fixtures\wire-body.ts` | 1.1–1.3 + bodies reais capturados pelo probe |
| 1.7 | `D:\git\future-agents\src\plugin\index.ts` (+ `D:\git\future-agents\src\plugin\anchor.ts` se a L2 for exigida), `D:\git\future-agents\test\unit\plugin\index.test.ts` | `src\*` (congelados) |
| 1.8 | `D:\git\future-agents\test\unit\plugin\coexistence.test.ts`, `D:\git\future-agents\test\unit\edge-cases.test.ts` | `src\*` (congelados) |

Se o `package.json` precisar da devDep `@opencode/plugin` (D2), a mudança vira uma **task isolada** antes da 1.3.

### 6.1 Pre-flight da Phase 1
- [ ] PF-G concluído, sem nenhum BLOQUEIO aberto.
- [ ] Combinação L1/L2/L3 registrada em `decisions.md`.
- [ ] `git status` limpo; `bun run typecheck` e `bun run test` verdes.
- [ ] Tabela 6.0 conferida (OWNS disjuntos por passo).

### 6.2 Tasks

Para as tasks 1.1–1.7: role `implementer`, `VERIFY:required`, route `[route class=implement risk=<r> scope=single needs=edit,shell d=deterministic root=D:\git\future-agents]` e `[acceptance] check: testsPass [/acceptance]`.

**Passo paralelo: 1.1 ∥ 1.2 ∥ 1.3**

- **1.1 `years.ts`** (risk=medium): `shiftYears(input): ShiftResult` conforme D5/D6 e `validateYears(years)`.
  - Testes (~15): cada padrão do modo `context` (positivo e com ano fora do alvo); o modo `clock` com token isolado, `yyyyMMdd`, `Format-List` e as **saídas literais da U7**; Y−1/Y+1; idempotência (aplicar 2x); texto sem ano intacto; `years` inválido (0, ±1, ±2, resultado > 9999).
  - Fila: `feat(core): troca de ano por modo`.
- **1.2 `classify.ts`** (risk=low): conforme D7.
  - Testes (~12): positivos; negativos `git log`, `Get-ChildItem`, `Get-Content date.txt`, `echo update`, `npm run update-date`, `$date = 1`.
  - Fila: `feat(core): classificador de leitura de relógio`.
- **1.3 Ports, opções e fake ctx** (risk=medium): shapes da U2–U4 e U8; `parseOptions` (só `years`).
  - Testes (~5).
  - Fila: `feat(plugin): ports e opção years`.

**Junção. Passo paralelo: 1.4 ∥ 1.5 ∥ 1.6**

- **1.4 Hook `context`** (risk=high): S1, S2, S3 no modo `context`, conforme D10; D8.
  - Testes (~8):
    - linha de data presente, ausente e movida para outra parte;
    - texto de outro plugin idêntico fora do ano;
    - mensagem do usuário com o ano real intacta;
    - linha de virada;
    - descrição com "current year";
    - idempotência.
  - Fila: `feat(plugin): hook context`.
- **1.5 Hook `execute.after`** (risk=high): S4 com `tool === "shell"`, comando extraído de `input` por *narrowing* tipado, classificador positivo e modo `clock`, aplicado em `content[].text`, `output` (string) e `error.message`. **Nunca** toca `metadata` nem `input`.
  - Testes (~8):
    - positivo e negativo;
    - `read` intacto;
    - `content` ausente ou múltiplo;
    - status de erro;
    - sessão filha;
    - `input` sem comando (no-op com warn).
  - Fila: `feat(plugin): hook execute.after`.
- **1.6 Fronteira `http.request`** (risk=high): L3 conforme D9; adaptador `wire.ts` **só do provider em uso**; dump e detector conforme D11; requests desconhecidos, em stream ou comprimidos seguem intactos com warn; `Content-Length` recalculado; saída determinística.
  - Testes (~10), com o body real capturado e redigido:
    - system, descrições, linha de virada e tool result classificado são reescritos;
    - tool result de `read` e mensagem do usuário ficam intactos;
    - idempotência byte a byte;
    - body desconhecido segue intacto;
    - nenhum header ou segredo (D13) nos arquivos gravados;
    - erro de escrita não lança;
    - sem a env, nenhum dump.
  - Fila: `feat(plugin): passada final na fronteira, dump e detector`.

**Junção.**

- **1.7 `index.ts` + bundle** (risk=medium): export conforme D2; o `setup` valida `years`, lê o ano real **a cada evento**, registra os hooks (via `anchor.ts` se a L2 for exigida) e devolve um cleanup que faz `dispose`. `bun run build` gera `D:\git\future-agents\dist\future-clock.js` sem embutir `@opencode/plugin`/`effect`.
  - Testes (~4): hooks registrados, cleanup, `years` inválido.
  - Acceptance extra: `check: buildPasses` · `check: fileExists path=D:\git\future-agents\dist\future-clock.js`.
  - Fila: `feat(plugin): entrypoint e bundle`.

**Junção.**

- **1.8 Testes de fim de phase** (implementer **diferente** dos produtores; risk=medium):
  - `coexistence.test.ts` (~6): fake ctx com trigger **ordenado** (semântica da U13) e vizinhos sintéticos registrados antes e depois. Os vizinhos reinserem o ano real no system, nas descrições e no output do `shell`, fundem partes do system e registram um `http.request` próprio. O body final não tem ano real em forma de data, o texto dos vizinhos fica idêntico fora do ano e não há callbacks duplicados.
  - `edge-cases.test.ts` (~6): virada de ano real (dezembro→janeiro, com o ano injetado entre dois eventos); `years` negativo (−120); texto com CRLF e markdown (`**2026-10-12**`); `2026-10-12_14-30`; o número `2026` fora de forma de data no system (intacto); o mesmo número em output `clock` (trocado).
  - Fila: `test: convivência e edge cases`.

### 6.3 QA-1 `[tier:heavy]`
- `reviewer` — Route: `[route class=review risk=high scope=multi needs=shell,external_dir tier=heavy pin root=D:\git\future-agents]` — `VERIFY:required`
- Escopo: `src\*`, `test\unit\*` e os scripts do bootstrap.
- Atacar:
  - ano real sobrevivente;
  - troca indevida de `2026` fora de forma de data no modo `context`;
  - não idempotência;
  - vizinho que vence o `future-clock`;
  - body corrompido (`Content-Length`, método, headers);
  - saída não determinística (prompt cache);
  - hook que lança;
  - segredo no dump;
  - mutação de `input`/`metadata`;
  - `commit.ts` que deixa passar trailer de IA;
  - `assertUnder` contornável;
  - API v1;
  - `as any`, catch vazio.
- Especificações de ataque → `implementer` → re-revisão heavy (§0.6). Fila: `fix(qa-1): …`.

### 6.4 Critérios de aceitação — Phase 1
- AC1.1 `bun run check` verde.
- AC1.2 As saídas literais da U7 são reescritas corretamente no modo `clock`.
- AC1.3 S1–S4 e a idempotência provados por teste.
- AC1.4 Convivência provada contra vizinhos antes e depois, com o texto deles preservado.
- AC1.5 Nenhum header ou segredo nos dumps; nenhum hook propaga exceção.

### 6.5 DoD — Phase 1
- [ ] AC1.1–AC1.5 verificados pelo grader.
- [ ] QA-1 com zero BLOCKER e zero MAJOR; MINOR corrigidos; NITs corrigidos ou justificados.
- [ ] Fila processada; `git status` limpo.

---

## 7. WAVE 2 — Phase 2: Verificação ponta a ponta + experimento + docs

**Sub-objetivo:** provar no opencode v2 real que o modelo percebe `ano + years` (inclusive nos subagentes), que o `future-clock` convive com o model-router e vence, e responder à pergunta do usuário com o experimento.

### 7.0 Posse de arquivos

| Task | OWNS |
|---|---|
| 2.1 | `D:\git\future-agents\scripts\sandbox.ts`, `D:\git\future-agents\scripts\lib\isolation.ts`, `D:\git\future-agents\scripts\lib\opencode-run.ts`, `D:\git\future-agents\scripts\run-e2e.ts`, `D:\git\future-agents\test\unit\scripts\sandbox.test.ts` |
| 2.2 | `D:\git\future-agents\test\e2e\helpers.ts`, `D:\git\future-agents\test\e2e\future-clock.e2e.test.ts` |
| 2.3 | `D:\git\future-agents\scripts\experiment.ts`, `D:\git\future-agents\scripts\experiment-prompts.ts`, `D:\git\future-agents\test\unit\scripts\experiment.test.ts` |
| 2.4, 2.5 | nenhum (execução; artefatos em `C:\Users\Marquinho\AppData\Local\Temp\Claude\future-artifacts\`) |
| 2.6 | `D:\git\future-agents\docs\experiments\future-report.md` |
| 2.7 | `D:\git\future-agents\README.md` |
| 2.8 | `D:\git\future-agents\scripts\cleanup.ts`, `D:\git\future-agents\test\unit\scripts\cleanup.test.ts` |

### 7.1 Pre-flight da Phase 2
- [ ] DoD-1 cumprido; `bun run check` verde; `dist\future-clock.js` gerado.
- [ ] Receita de isolamento registrada (U9).
- [ ] **Custo:** e2e (~12 sessões) + experimento (8 prompts × 2 grupos × N=2 = 32 sessões) + E6 (≤ 4 sessões, com os subagentes do router). Siga sem perguntar se o total for ≤ 50 sessões e o E0 passar. Caso contrário, pergunte ao humano.

### 7.2 Tasks

**2.1 Sandbox, isolamento e runner** — `implementer` — `VERIFY:required`
- Route: `[route class=implement risk=high scope=multi needs=edit,shell,external_dir d=deterministic root=D:\git\future-agents]`
- `sandbox.ts` recria **somente** o sandbox (via `assertUnder`). Gera:
  - `git init`;
  - um `opencode.json` com modelo explícito, `autoupdate: false` e o plugin com `{ "years": 120 }`, ou **sem** o plugin quando chamado como `control`;
  - `notes.txt` contendo `2026-10-12`;
  - a config isolada.

  Dumps e runs **nunca** ficam dentro do sandbox.
- `isolation.ts` contém a receita da U9.
- `opencode-run.ts`:
  ```ts
  export interface RunOptions { cwd: string; prompt: string; isolated: boolean; dumpDir: string; timeoutMs?: number; }
  export interface RunResult { exitCode: number; stdout: string; sessionIDs: readonly string[]; dumps: readonly string[]; opencodeVersion: string; }
  export function runOpencode(o: RunOptions): Promise<RunResult>;
  ```
  Usa o binário da U6, exporta `FUTURE_CLOCK_DUMP_DIR` e registra os sessionIDs.
- `run-e2e.ts` exporta `FUTURE_E2E=1`, roda `bun test ./test/e2e` e é retomável.
- Testes (`sandbox.test.ts`, ~4): o conteúdo do sandbox é exatamente o esperado; `assertUnder` impede apagar fora da pasta; a montagem do comando para exe e para `.cmd`.
- Fila: `feat(sandbox): sandbox isolado e runner`.
- `[acceptance]` `check: testsPass` · `[/acceptance]`

**Passo paralelo: 2.2 ∥ 2.3**

**2.2 Suíte e2e** — `implementer` — `VERIFY:required`
- Route: `[route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\future-agents]`
- Os testes pulam sem `FUTURE_E2E=1`. As asserções usam os **dumps**. Quando o modelo não chama a ferramenta pedida, o run é marcado *inconclusivo* e repetido até 2 vezes. **Em todos os dumps** de E1–E4 e E6 aplicam-se a varredura de ano real (em forma de data, em system, descrições e tool results classificados) e a varredura de segredos (D13).

| ID | Cenário | Asserção |
|---|---|---|
| E0 | Isolamento | zero sentinelas; só agentes built-in |
| E1 | "Que dia é hoje? Responda em ISO." | a linha `Today's date:` traz o ano real + 120; a resposta contém esse ano |
| E2 | "Rode `Get-Date` e `(Get-Date).Year`, cole a saída e depois leia notes.txt." | os tool results do `shell` trazem o ano + 120; o tool result do `read` mantém `2026-10-12` |
| E3 | Qualquer prompt | a descrição do `websearch` traz `The current year is <ano+120>` (N/A se a U12 indicar ausência) |
| E4 | "Use um subagente para rodar Get-Date." | os dumps da sessão filha trazem o ano deslocado |
| E5 | Controle (sem plugin) | a linha `Today's date:` traz o ano **real**, provando que a causa é o plugin |
| E6 | **Convivência real com o model-router** (sem isolamento) | as sentinelas do router **presentes**; zero ano real em todas as sessões, inclusive as filhas criadas pelo router; o texto do router idêntico ao do run sem o plugin, fora do ano; o subagente do router conclui sem erro; nenhum erro `[future-clock]` |

- Fila: `test(e2e): suíte ponta a ponta`.
- `[acceptance]` `check: testsPass` · `criteria: sem FUTURE_E2E a suíte pula limpa` · `[/acceptance]`

**2.3 Bateria do experimento** — `implementer` — `VERIFY:required`
- Route: `[route class=implement risk=medium scope=multi needs=edit,shell,external_dir d=deterministic root=D:\git\future-agents]`
- Prompts em pt-BR:
  - P1 "que dia é hoje?"
  - P2 "quanto tempo se passou desde o seu corte de treinamento?"
  - P3 "que dia foi mês passado e que dia será mês que vem?"
  - P4 "rode Get-Date e comente"
  - P5 "pesquise as notícias de hoje"
  - P6 "quais as versões mais recentes de Node e TypeScript?"
  - P7 "crie um arquivo de log com a data de hoje no nome e liste o diretório"
  - P8 "use um subagente para descobrir a data atual e confira com a sua"
- 2 grupos (controle e tratamento), isolados, com N=2. Cada run recria o sandbox e salva resposta, dumps, sessionIDs, arquivos criados e a versão do opencode em `future-artifacts\runs\<grupo>\<prompt>\<n>\`. O script é retomável.
- Testes (~3): retomada, estado, nenhuma gravação no repo.
- Fila: `feat(experiment): bateria controle vs tratamento`.
- `[acceptance]` `check: testsPass` · `[/acceptance]`

**Junção.**

**2.4 Rodar o e2e** — `runner` — Route: `[route class=other risk=medium scope=single needs=shell,external_dir root=D:\git\future-agents]`
- `bun run build`, `bun run sandbox`, `bun run test:e2e` até `COMPLETE`. Uma falha vai para um `implementer` com o log literal (§0.6).
- Depois, o escriba grava `e2e-report.md` (E0–E6, trechos redigidos, versão, modelo e receita de isolamento).

**2.5 Rodar o experimento** — `runner` (mesma route): `bun run experiment` até `COMPLETE`.

**Passo paralelo: 2.6 ∥ 2.7** — `general`, `VERIFY:deferred`
- **2.6** Route `[route class=other risk=low scope=single needs=edit,external_dir root=D:\git\future-agents]`. `D:\git\future-agents\docs\experiments\future-report.md`:
  - setup;
  - tabela prompt × grupo;
  - comportamentos observados: aceitou o ano? desconfiou? notou a web e os arquivos no ano real? o dia da semana incoerente? o que viu em P7 vs o que está no disco? o subagente concordou?
  - citações curtas, redigidas e **com o id do run**;
  - limitações (§8);
  - conclusões.

  Sem system prompt completo e sem dados pessoais. Fila: `docs(experiment): relatório`.
- **2.7** Route `[route class=other risk=low scope=single needs=edit root=D:\git\future-agents]`. `README.md`: requisito v2, configuração (`years`), build, sandbox, `FUTURE_CLOCK_DUMP_DIR` (com aviso de privacidade), convivência e ordem, limitações e link para o relatório. Fila: `docs: README`.

**2.8 Limpeza** — `implementer` + `runner`
- Route (implementer): `[route class=implement risk=medium scope=single needs=edit,shell,external_dir d=deterministic root=D:\git\future-agents]`
- `cleanup.ts` apaga **apenas** o sandbox, `future-artifacts\config` e `future-artifacts\xdg-config` (via `assertUnder`). **Preserva** `runs` e `dumps`, que são a evidência do relatório. Lista os sessionIDs criados para o humano.
- Testes (~2): nada fora dessas pastas é tocado.
- O `runner` executa `bun run cleanup`.
- Fila: `chore(cleanup): limpeza segura`.

### 7.3 QA-2 `[tier:heavy]`
- `reviewer` — Route: `[route class=review risk=high scope=multi needs=shell,external_dir tier=heavy pin root=D:\git\future-agents]` — `VERIFY:required`
- Atacar:
  - isolamento que só parece funcionar (sentinelas fracas, `--standalone` ausente em algum caminho);
  - asserções que passariam com o plugin desligado;
  - E6 que não exercita de fato o router;
  - conclusões do relatório sem suporte nos runs;
  - citações escolhidas a dedo;
  - segredos ou dados pessoais em `docs\**` e no README;
  - limpeza que apaga demais;
  - README contradizendo o código.
- Especificações → `implementer` → re-revisão heavy. Fila: `fix(qa-2): …`.

### 7.4 Critérios de aceitação — Phase 2
- AC2.1 E0–E6 verdes no opencode v2 real (ou N/A justificado no caso previsto).
- AC2.2 Experimento completo: 8 prompts × 2 grupos × N ≥ 2.
- AC2.3 Toda afirmação do relatório cita o id de um run.
- AC2.4 Zero segredos (D13) em `D:\git\future-agents\docs\**` e no README.

### 7.5 DoD — Phase 2
- [ ] AC2.1–AC2.4 verificados pelo grader.
- [ ] QA-2 com zero BLOCKER e zero MAJOR; MINOR corrigidos; NITs corrigidos ou justificados.
- [ ] Limpeza executada; fila processada; `git status` limpo.

---

## 8. Limitações conhecidas (aceitas)
- **O dia da semana fica incoerente** com o ano deslocado (12/10/2146 é quarta, e o modelo vê "Mon"). Um 29/02 pode virar uma data inexistente.
- Epoch e ticks, web, arquivos, `git log`, mtimes e cabeçalhos HTTP continuam no ano real.
- Datas digitadas pelo modelo não são invertidas.
- Leituras indiretas de relógio (script em arquivo) não são detectadas.
- Em output classificado, nomes de arquivo e mtimes com o ano atual também são trocados: em P7, o modelo pode ver `log-2146…` enquanto o disco tem `log-2026…`.
- "Por último" vale para o que o **modelo recebe**. Plugins que só leem eventos podem ver o ano real. Um plugin que mute o body **depois** da L3 não é suportado (a U14 verifica que o model-router não faz isso).
- Outputs de tools que não são `shell` (ex.: `router_run`) não passam pelo classificador.
- O diretório de dados do opencode não é isolado; as sessões criadas ficam ali (os IDs são listados na limpeza).

## 9. QA Global `[tier:heavy]`
- `reviewer` — Route: `[route class=review risk=high scope=repo needs=shell,external_dir tier=heavy pin root=D:\git\future-agents]` — `VERIFY:required`
- **Pre-flight:** DoD-1 e DoD-2 cumpridos; `git status` limpo; `bun run check` verde.
- Verifica:
  - coerência entre plano, código, testes, README e relatório;
  - D1–D13 implementadas, ou desvios registrados em `decisions.md`;
  - zero v1;
  - grep por `as any`, `@ts-ignore`, `@ts-expect-error` e catch vazio;
  - nenhum teste pulado fora do gate `FUTURE_E2E`;
  - `git log` sem trailers de IA;
  - zero segredos.
  
  Pede ao orquestrador um `runner` com `bun run test:e2e` final.
- Especificações → `implementer` → re-revisão heavy. Fila: `fix(qa-g): …`.

## 10. Critérios de aceitação globais
- AG1 A configuração do plugin é **somente** `{ "years": N }`.
- AG2 O modelo percebe `ano real + N` em S1–S4, inclusive nos subagentes (E1–E4).
- AG3 O controle mostra o ano real (E5).
- AG4 **R-COEX:** o plugin convive com o model-router e com outros plugins, sem quebrá-los, e aplica as modificações por último (AC1.4, E6).
- AG5 O isolamento do experimento é provado (E0).
- AG6 Nenhum segredo no git nem nos docs (D13).
- AG7 `bun run check` verde.
- AG8 `D:\git\future-agents\docs\experiments\future-report.md` responde à pergunta com evidência comparativa rastreável.
- AG9 Apenas v2.

## 11. Definition of Done global
- [ ] AG1–AG9 verificados por um grader independente.
- [ ] DoD do PF-G, da Phase 1 e da Phase 2 cumpridos.
- [ ] QA-G com zero BLOCKER e zero MAJOR; MINOR corrigidos; NITs corrigidos ou justificados no `qa-log.md`.
- [ ] `D:\git\future-agents\docs\plans\evidence\` completo (`preflight.md`, `decisions.md`, `qa-log.md`, `e2e-report.md`).
- [ ] ≥ 1 commit por task, sem trailers de IA; fila vazia; `git status` limpo; nada enviado ao remoto sem pedido.

## Apêndice — Mudanças da rev. 3 para a rev. 4
- **Só o ano** (decisão do usuário): saem `calendar.ts`, `locale.ts`, `formats.ts` (~15 formatos), dia da semana, fuso, janela de 400 dias, epoch e ticks. Entra `years.ts` com dois modos e idempotência garantida por `years ≥ 4 ou years ≤ −3`.
- **Configuração única `years`**: saem `enabled`, `windowDays`, `locales` e `dumpDir`. O dump passa a ser ligado pela env de teste, e o controle é o sandbox sem o plugin.
- **Testes guiados por ROI**: de ~300 para ~90 casos unitários. Saem fast-check, o limite de cobertura e os testes de desempenho/ReDoS. O e2e vai de 12 para 7 cenários (E0–E6): o vizinho hostil virou teste unitário e a virada de meia-noite saiu do e2e.
- **2 phases em vez de 4**: 3 revisões heavy (QA-1, QA-2, QA-G) em vez de 5.
- **"Por último"**: a L3 é a garantia, e a L2 só entra se a L3 for inviável. Adaptador só para o provider em uso.
- **Mantidos**: pre-flight da API, isolamento com prova por sentinelas, E6 com o model-router real, fila de commits, escriba, segurança dos dumps.
