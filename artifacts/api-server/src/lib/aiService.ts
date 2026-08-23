interface AiProviderConfig {
  provider: "openai" | "anthropic";
  apiKey: string;
  model?: string;
}

interface AiGenerateParams {
  action: string;
  context: string;
  locale?: string;
}

const PROMPTS: Record<string, (context: string) => string> = {
  generateHeroTitle: (ctx) => `Generate a compelling hero title for a website page about: ${ctx}. Return only the title text, no quotes.`,
  generateCTAText: (ctx) => `Generate a short call-to-action button text for: ${ctx}. Return only the CTA text, max 5 words.`,
  generateFAQItems: (ctx) => `Generate 3 FAQ items (question and answer pairs) about: ${ctx}. Return as JSON array: [{"question":"...","answer":"..."}]`,
  generateMetaTitle: (ctx) => `Generate an SEO-optimized meta title (max 60 chars) for a page about: ${ctx}. Return only the title.`,
  generateMetaDescription: (ctx) => `Generate an SEO-optimized meta description (max 160 chars) for a page about: ${ctx}. Return only the description.`,
  generateOGText: (ctx) => `Generate Open Graph title and description for social sharing about: ${ctx}. Return as JSON: {"title":"...","description":"..."}`,
  generateExcerpt: (ctx) => `Generate a blog post excerpt (max 200 chars) for: ${ctx}. Return only the excerpt.`,
  generateAltText: (ctx) => `Generate descriptive alt text for an image related to: ${ctx}. Return only the alt text.`,
  generateBlogOutline: (ctx) => `Generate a blog post outline with 5-7 sections for: ${ctx}. Return as JSON array of section titles: ["...","..."]`,
  improveTone: (ctx) => `Improve the tone and make this text more professional and engaging: ${ctx}. Return only the improved text.`,
  shortenText: (ctx) => `Shorten this text while keeping the key message: ${ctx}. Return only the shortened text.`,
  expandText: (ctx) => `Expand this text with more detail and depth: ${ctx}. Return only the expanded text.`,
};

async function callOpenAI(config: AiProviderConfig, prompt: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0.7,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI error: ${err}`);
  }
  const data = await response.json() as Record<string, any>;
  return data.choices?.[0]?.message?.content || "";
}

async function callAnthropic(config: AiProviderConfig, prompt: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model || "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic error: ${err}`);
  }
  const data = await response.json() as Record<string, any>;
  return data.content?.[0]?.text || "";
}

export class AiContentService {
  private config: AiProviderConfig;

  constructor(config: AiProviderConfig) {
    this.config = config;
  }

  getProvider(): string {
    return this.config.provider;
  }

  async generate(params: AiGenerateParams): Promise<string> {
    const promptFn = PROMPTS[params.action];
    if (!promptFn) throw new Error(`Unknown action: ${params.action}`);

    const prompt = promptFn(params.context);
    const langHint = params.locale && params.locale !== "en" ? ` Respond in ${params.locale} language.` : "";
    const fullPrompt = prompt + langHint;

    const result = this.config.provider === "openai"
      ? await callOpenAI(this.config, fullPrompt)
      : await callAnthropic(this.config, fullPrompt);

    return result.trim();
  }

  static getSupportedActions(): string[] {
    return Object.keys(PROMPTS);
  }
}
