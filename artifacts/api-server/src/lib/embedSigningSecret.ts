export function getEmbedSigningSecret(): string {
  const value = process.env.SESSION_SECRET || process.env.EMBED_TOKEN_SECRET;
  if (!value) {
    throw new Error("[EMBED] SESSION_SECRET or EMBED_TOKEN_SECRET must be configured for embed widget security");
  }
  return `edcons-embed:${value}`;
}
