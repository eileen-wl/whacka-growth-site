import { defineConfig } from "sanity";
import { visionTool } from "@sanity/vision";
import { schemaTypes } from "./schemaTypes";

const projectId = process.env.SANITY_STUDIO_PROJECT_ID || "";
const dataset = process.env.SANITY_STUDIO_DATASET || "production";

export default defineConfig({
  name: "default",
  title: "Whacka Toolkit Studio",

  projectId,
  dataset,

  plugins: [visionTool()],

  schema: {
    types: schemaTypes,
  },
});
