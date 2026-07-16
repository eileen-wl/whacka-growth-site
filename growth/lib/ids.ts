/** Lowercases, trims, and replaces runs of non-alphanumeric characters with `_`. Never returns an empty string. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : "unknown";
}

/** Returns `baseId` if unused, otherwise `${baseId}_2`, `${baseId}_3`, ... — guarantees no collisions across a catalog build. */
export function ensureUniqueId(baseId: string, used: Set<string>): string {
  if (!used.has(baseId)) {
    used.add(baseId);
    return baseId;
  }
  let suffix = 2;
  while (used.has(`${baseId}_${suffix}`)) suffix++;
  const id = `${baseId}_${suffix}`;
  used.add(id);
  return id;
}
