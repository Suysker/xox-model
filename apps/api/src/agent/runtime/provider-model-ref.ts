export type ProviderModelRef = {
  provider: string
  model: string
  requestModel: string
  canonicalRef: string
}

function normalizeProvider(value: string) {
  return value.trim().toLowerCase()
}

function normalizeModel(value: string) {
  return value.trim()
}

export function resolveProviderModelRef(input: {
  provider: string
  model: string
}): ProviderModelRef {
  const configuredProvider = normalizeProvider(input.provider || 'openai-compatible')
  const configuredModel = normalizeModel(input.model)
  const slashIndex = configuredModel.indexOf('/')
  if (slashIndex > 0) {
    const refProvider = normalizeProvider(configuredModel.slice(0, slashIndex))
    const refModel = normalizeModel(configuredModel.slice(slashIndex + 1))
    const provider =
      configuredProvider === 'openai-compatible' || configuredProvider === refProvider
        ? refProvider
        : configuredProvider
    const requestModel = provider === refProvider ? refModel : configuredModel
    return {
      provider,
      model: refModel || configuredModel,
      requestModel,
      canonicalRef: `${provider}/${requestModel}`,
    }
  }
  return {
    provider: configuredProvider,
    model: configuredModel,
    requestModel: configuredModel,
    canonicalRef: `${configuredProvider}/${configuredModel}`,
  }
}
