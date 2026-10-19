export const name = "huaanwork-thinking-prompt";
export const inject = ["systemPrompt"];

export const THINKING_PROMPT_NAME = "huaanwork:thinking-language";
export const THINKING_PROMPT_ORDER = 40;
export const THINKING_PROMPT_TEXT = "思考过程使用简体中文。回答语言跟随用户。";

export function apply(ctx: {
  systemPrompt: { section(entry: { name: string; order: number; text: string }): void };
}): void {
  ctx.systemPrompt.section({
    name: THINKING_PROMPT_NAME,
    order: THINKING_PROMPT_ORDER,
    text: THINKING_PROMPT_TEXT,
  });
}
