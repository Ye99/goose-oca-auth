import type { BridgeConfig } from "../config"
import type { ProviderDiscovery } from "oca-auth-core"

function normalizeModelId(providerId: string, modelId: string) {
  return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`
}

export function buildModelsResponse(
  config: BridgeConfig,
  discovery?: ProviderDiscovery,
) {
  const ids = discovery?.models.length
    ? discovery.models.map((model) => normalizeModelId(config.providerId, model.id))
    : [config.defaultModel]

  return {
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: config.providerId,
    })),
  }
}
