import type { EmbeddingProvider } from './embedding-provider.js';

export type MistralEmbeddingProviderOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
};

export class EmbeddingProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}

export class MistralEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: MistralEmbeddingProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error('MISTRAL_API_KEY is required to generate embeddings.');
    }
    if (!options.model.trim()) {
      throw new Error('MISTRAL_EMBEDDING_MODEL is required to generate embeddings.');
    }
    this.baseUrl = options.baseUrl ?? 'https://api.mistral.ai/v1';
    if (!isHttpUrl(this.baseUrl)) {
      throw new Error('Mistral API base URL must be an HTTP(S) URL.');
    }
    this.fetcher = options.fetcher ?? fetch;
  }

  async embed(input: string[], signal?: AbortSignal): Promise<number[][]> {
    if (input.length === 0 || input.some((text) => typeof text !== 'string' || !text.trim())) {
      throw new Error('Embedding input must contain non-empty strings.');
    }

    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          input,
          encoding_format: 'float',
        }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw new EmbeddingProviderError('TIMEOUT', 'Mistral embedding request was interrupted.', true);
      }
      throw new EmbeddingProviderError(
        'NETWORK_ERROR',
        'Mistral embedding service could not be reached.',
        true,
      );
    }

    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const code = response.status === 408
        ? 'TIMEOUT'
        : response.status === 429
          ? 'RATE_LIMITED'
          : response.status >= 500
            ? 'PROVIDER_UNAVAILABLE'
            : 'PROVIDER_REJECTED';
      throw new EmbeddingProviderError(
        code,
        'Mistral rejected or failed the embedding request.',
        retryable,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EmbeddingProviderError(
        'INVALID_PROVIDER_RESPONSE',
        'Mistral returned an invalid embedding response.',
        false,
      );
    }
    return parseEmbeddings(payload, input.length);
  }
}

export function mistralEmbeddingProviderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  fetcher?: typeof fetch,
): MistralEmbeddingProvider {
  const apiKey = environment.MISTRAL_API_KEY;
  const model = environment.MISTRAL_EMBEDDING_MODEL;
  if (!apiKey?.trim()) {
    throw new Error('MISTRAL_API_KEY is required to generate embeddings.');
  }
  if (!model?.trim()) {
    throw new Error('MISTRAL_EMBEDDING_MODEL is required to generate embeddings.');
  }
  return new MistralEmbeddingProvider({
    apiKey,
    model,
    ...(fetcher === undefined ? {} : { fetcher }),
  });
}

function parseEmbeddings(value: unknown, expectedCount: number): number[][] {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length !== expectedCount) {
    throw new EmbeddingProviderError(
      'INVALID_PROVIDER_RESPONSE',
      'Mistral returned an unexpected number of embeddings.',
      false,
    );
  }

  const ordered: Array<number[] | undefined> = new Array(expectedCount);
  for (const item of value.data) {
    const index = isRecord(item) ? item.index : undefined;
    const embedding = isRecord(item) ? item.embedding : undefined;
    if (
      !isRecord(item) ||
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expectedCount ||
      !isFiniteNumberArray(embedding)
    ) {
      throw new EmbeddingProviderError(
        'INVALID_PROVIDER_RESPONSE',
        'Mistral returned malformed embedding data.',
        false,
      );
    }
    if (ordered[index]) {
      throw new EmbeddingProviderError(
        'INVALID_PROVIDER_RESPONSE',
        'Mistral returned duplicate embedding indexes.',
        false,
      );
    }
    ordered[index] = embedding;
  }

  if (ordered.some((embedding) => embedding === undefined)) {
    throw new EmbeddingProviderError(
      'INVALID_PROVIDER_RESPONSE',
      'Mistral omitted an embedding result.',
      false,
    );
  }
  const dimensions = ordered[0]?.length;
  if (ordered.some((embedding) => embedding?.length !== dimensions)) {
    throw new EmbeddingProviderError(
      'INVALID_PROVIDER_RESPONSE',
      'Mistral returned inconsistent embedding dimensions.',
      false,
    );
  }
  const embeddings: number[][] = [];
  for (const embedding of ordered) {
    if (!embedding) {
      throw new EmbeddingProviderError(
        'INVALID_PROVIDER_RESPONSE',
        'Mistral omitted an embedding result.',
        false,
      );
    }
    embeddings.push(embedding);
  }
  return embeddings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((component) => typeof component === 'number' && Number.isFinite(component))
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
