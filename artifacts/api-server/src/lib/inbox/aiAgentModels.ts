export type AiAgentModelOption = {
  id: string;
  displayName: string;
  createdAt?: string;
  current: boolean;
};

type AnthropicModelInfo = {
  id: string;
  display_name: string;
  created_at: string;
};

type AnthropicModelsClient = {
  models: {
    list(params: { limit: number }): Promise<{
      data: AnthropicModelInfo[];
    }>;
  };
};

export function mergeAiAgentModelOptions(
  providerModels: AnthropicModelInfo[],
  currentModel: string,
): AiAgentModelOption[] {
  const currentId = currentModel.trim();
  const seen = new Set<string>();
  const options: AiAgentModelOption[] = [];

  for (const model of providerModels) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      displayName: model.display_name.trim() || id,
      createdAt: model.created_at || undefined,
      current: id === currentId,
    });
  }

  // A saved alias or legacy model can be valid even when the provider's list
  // endpoint no longer returns it. Preserve it so opening the admin page never
  // changes or clears the live configuration.
  if (currentId && !seen.has(currentId)) {
    options.unshift({
      id: currentId,
      displayName: currentId,
      current: true,
    });
  }

  return options;
}

export async function loadAnthropicModelOptions(
  client: AnthropicModelsClient,
  currentModel: string,
): Promise<AiAgentModelOption[]> {
  // Anthropic returns the newest models first. 100 is comfortably above the
  // current catalog size while keeping this admin request bounded.
  const page = await client.models.list({ limit: 100 });
  return mergeAiAgentModelOptions(page.data, currentModel);
}
