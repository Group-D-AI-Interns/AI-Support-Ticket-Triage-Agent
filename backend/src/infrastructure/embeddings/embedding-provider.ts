export interface EmbeddingProvider {
  embed(input: string[], signal?: AbortSignal): Promise<number[][]>;
}
