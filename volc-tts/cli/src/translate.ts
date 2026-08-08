/**
 * 翻译模块 - 使用通义千问 (DashScope) 翻译口播稿
 * 环境变量: DASHSCOPE_API_KEY
 */

const TRANSLATE_API = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation";
const MODEL = "qwen-plus";

interface TranslationResult {
  text: string;
  sourceLang: string;
  targetLang: string;
}

/** 语种配置 */
export const LANGUAGES: Record<string, { name: string; voice: string; prompt: string }> = {
  zh: { name: "中文", voice: "zh_female_vv_uranus_bigtts", prompt: "请保留原文，直接输出" },
  en: {
    name: "英文",
    voice: "zh_female_vv_uranus_bigtts",
    prompt: "将以下中文口播稿翻译成自然的英文。注意保持口语化、适合朗读，不要加额外解释。直接输出翻译结果：\n\n",
  },
  ja: {
    name: "日文",
    voice: "zh_female_vv_uranus_bigtts",
    prompt: "将以下中文口播稿翻译成自然的日本语。注意保持口语化、适合朗读，不要加额外解释。直接输出翻译结果：\n\n",
  },
};

/**
 * 翻译文本
 */
export async function translateText(text: string, targetLang: string): Promise<string> {
  if (targetLang === "zh") return text; // 中文不用翻译

  const cfg = LANGUAGES[targetLang];
  if (!cfg) throw new Error(`不支持的目标语言: ${targetLang}`);

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("翻译需要设置 DASHSCOPE_API_KEY 环境变量");

  const response = await fetch(TRANSLATE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input: {
        messages: [
          {
            role: "user",
            content: cfg.prompt + text,
          },
        ],
      },
      parameters: {
        result_format: "message",
        temperature: 0.1,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`翻译失败 (${response.status}): ${err.slice(0, 200)}`);
  }

  const result: any = await response.json();
  const content = result?.output?.choices?.[0]?.message?.content;
  if (!content) throw new Error("翻译返回为空");

  return content.trim();
}
