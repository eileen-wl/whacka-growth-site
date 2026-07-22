import { createClient } from "@sanity/client";
import { apps as fallbackApps, type AppData } from "../data/apps";

export interface AppToolData extends AppData {
  demoUrl?: string;
  remixUrl?: string;
  buildUrl?: string;
  status?: string;
  notes?: string;
  utmContent?: string;
}

const projectId = import.meta.env.PUBLIC_SANITY_PROJECT_ID;
const dataset = import.meta.env.PUBLIC_SANITY_DATASET;
const apiVersion = import.meta.env.PUBLIC_SANITY_API_VERSION || "2024-01-01";

const client =
  projectId && dataset
    ? createClient({ projectId, dataset, apiVersion, useCdn: true })
    : null;

export const APP_TOOLS_QUERY = `*[_type == "appTool"] | order(name asc) {
  "slug": slug.current,
  name,
  tagline,
  category,
  shortDescription,
  image,
  screenshots[]{ image, caption },
  problem,
  solution,
  whoItsFor,
  prompt,
  ctaLabel,
  ctaHref,
  relatedSlugs,
  faq[]{ question, answer },
  demoUrl,
  remixUrl,
  buildUrl,
  status,
  notes,
  utmContent,
  seo{ title, metaDescription, primaryKeyword, secondaryKeywords }
}`;

let cachedApps: Promise<AppToolData[]> | null = null;

async function fetchApps(): Promise<AppToolData[]> {
  if (!client) {
    return fallbackApps;
  }

  try {
    const docs = await client.fetch<AppToolData[]>(APP_TOOLS_QUERY);
    return docs && docs.length > 0 ? docs : fallbackApps;
  } catch (err) {
    console.warn("[sanity] Could not fetch app data, falling back to src/data/apps.ts:", err);
    return fallbackApps;
  }
}

/** All appTool records, fetched from Sanity when configured and falling back to the static data otherwise. Cached per build/request. */
export function getApps(): Promise<AppToolData[]> {
  if (!cachedApps) {
    cachedApps = fetchApps();
  }
  return cachedApps;
}

export async function getAppBySlug(slug: string): Promise<AppToolData | undefined> {
  const apps = await getApps();
  return apps.find((app) => app.slug === slug);
}
