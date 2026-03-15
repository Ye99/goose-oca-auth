import type { BridgeConfig } from "../config"
import type { ProviderDiscovery } from "oca-auth-core"

function normalizeModelId(providerId: string, modelId: string) {
  return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`
}

export function buildModelsResponse(
  config: BridgeConfig,
  discovery?: ProviderDiscovery,
) {
  if (discovery?.models.length) {
    return {
      object: "list",
      data: discovery.models.map((model) => ({
        id: normalizeModelId(config.providerId, model.id),
        object: "model",
        created: 0,
        owned_by: config.providerId,
        ...(model.contextWindow != null ? { context_window: model.contextWindow } : {}),
        ...(model.maxOutputTokens != null ? { max_output_tokens: model.maxOutputTokens } : {}),
      })),
    }
  }

  return {
    object: "list",
    data: [
      {
        id: config.defaultModel,
        object: "model",
        created: 0,
        owned_by: config.providerId,
      },
    ],
  }
}
