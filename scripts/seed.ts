import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createClient } from "@sanity/client";
import { apps } from "../src/data/apps";

const projectId = process.env.PUBLIC_SANITY_PROJECT_ID;
const dataset = process.env.PUBLIC_SANITY_DATASET;
const apiVersion = process.env.PUBLIC_SANITY_API_VERSION || "2024-01-01";
const token = process.env.SANITY_API_TOKEN;

if (!projectId || !dataset) {
  console.error(
    "Missing PUBLIC_SANITY_PROJECT_ID or PUBLIC_SANITY_DATASET.\n" +
      "Copy .env.example to .env and fill in your Sanity project details first."
  );
  process.exit(1);
}

if (!token) {
  console.error(
    "Missing SANITY_API_TOKEN.\n" +
      "Create an Editor token at https://www.sanity.io/manage and add it to .env."
  );
  process.exit(1);
}

const client = createClient({ projectId, dataset, apiVersion, token, useCdn: false });

function toDocId(slug: string): string {
  return `appTool-${slug}`;
}

function withKeys<T extends object>(items: T[]): (T & { _key: string })[] {
  return items.map((item) => ({ _key: randomUUID(), ...item }));
}

async function seed() {
  console.log(`Seeding ${apps.length} app(s) into dataset "${dataset}"...`);

  for (const app of apps) {
    const doc = {
      _id: toDocId(app.slug),
      _type: "appTool",
      name: app.name,
      slug: { _type: "slug", current: app.slug },
      tagline: app.tagline,
      category: app.category,
      shortDescription: app.shortDescription,
      image: app.image,
      screenshots: withKeys(app.screenshots),
      problem: app.problem,
      solution: app.solution,
      whoItsFor: app.whoItsFor,
      prompt: app.prompt,
      ctaLabel: app.ctaLabel,
      ctaHref: app.ctaHref,
      relatedSlugs: app.relatedSlugs,
      faq: withKeys(app.faq),
      status: "published",
      notes: "Seeded from src/data/apps.ts",
    };

    await client.createOrReplace(doc);
    console.log(`  ✓ ${app.slug} -> ${doc._id}`);
  }

  console.log("Done. Re-running this script will update these same documents, not duplicate them.");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
