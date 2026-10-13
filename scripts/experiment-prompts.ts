// Prompt battery for the control-vs-treatment experiment (plan §7.2 task 2.3).

export const PROMPTS = [
  { id: "P1", text: "que dia é hoje?" },
  { id: "P2", text: "quanto tempo se passou desde o seu corte de treinamento?" },
  { id: "P3", text: "que dia foi mês passado e que dia será mês que vem?" },
  { id: "P4", text: "rode Get-Date no shell e comente o resultado" },
  { id: "P5", text: "pesquise na web as notícias de hoje e resuma em 3 tópicos" },
  { id: "P6", text: "quais as versões mais recentes de Node.js e TypeScript?" },
  { id: "P7", text: "crie um arquivo de log com a data de hoje no nome e depois liste o diretório" },
  { id: "P8", text: "use a ferramenta subagent para que um subagente descubra a data atual e confira com a sua" },
] as const;

export type Prompt = (typeof PROMPTS)[number];
export type PromptId = Prompt["id"];

export const ARMS = ["control", "treatment"] as const;

/** Repetitions per (arm, prompt). */
export const N = 2;
