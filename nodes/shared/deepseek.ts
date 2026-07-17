// ponytail: substring match, not an allow-list — robust to whatever alias the
// user gave the model in LiteLLM (e.g. "deepseek/deepseek-v4-pro"). Revisit if a
// non-V4 model with "deepseek" in its name turns out not to accept thinking mode.
export const isDeepSeekModel = (model: string): boolean => /deepseek/i.test(model);
