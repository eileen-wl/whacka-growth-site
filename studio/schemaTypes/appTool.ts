import { defineField, defineType } from "sanity";

export const appTool = defineType({
  name: "appTool",
  title: "App Tool",
  type: "document",
  fields: [
    defineField({
      name: "name",
      title: "Name",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "slug",
      title: "Slug",
      type: "slug",
      options: { source: "name" },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "tagline",
      title: "Tagline",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "category",
      title: "Category",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "shortDescription",
      title: "Short Description",
      type: "text",
      rows: 2,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "image",
      title: "Cover Image Path",
      description: "Plain path to the cover image, e.g. /images/orderly/cover.svg",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "screenshots",
      title: "Screenshots",
      type: "array",
      of: [
        {
          type: "object",
          name: "screenshot",
          fields: [
            defineField({
              name: "image",
              title: "Image Path",
              type: "string",
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "caption",
              title: "Caption",
              type: "string",
              validation: (Rule) => Rule.required(),
            }),
          ],
          preview: {
            select: { title: "caption", subtitle: "image" },
          },
        },
      ],
    }),
    defineField({
      name: "problem",
      title: "Problem",
      type: "text",
      rows: 4,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "solution",
      title: "Solution",
      type: "text",
      rows: 4,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "whoItsFor",
      title: "Who It's For",
      type: "array",
      of: [{ type: "string" }],
    }),
    defineField({
      name: "prompt",
      title: "Whacka Prompt",
      type: "text",
      rows: 6,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "ctaLabel",
      title: "CTA Label",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "ctaHref",
      title: "CTA Href",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "relatedSlugs",
      title: "Related App Slugs",
      description: "Slugs of other appTool documents to show as related apps.",
      type: "array",
      of: [{ type: "string" }],
    }),
    defineField({
      name: "faq",
      title: "FAQ",
      type: "array",
      of: [
        {
          type: "object",
          name: "faqItem",
          fields: [
            defineField({
              name: "question",
              title: "Question",
              type: "string",
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "answer",
              title: "Answer",
              type: "text",
              rows: 3,
              validation: (Rule) => Rule.required(),
            }),
          ],
          preview: {
            select: { title: "question" },
          },
        },
      ],
    }),
    defineField({
      name: "demoUrl",
      title: "Demo URL",
      description: "Link to a live demo of the built app.",
      type: "string",
    }),
    defineField({
      name: "remixUrl",
      title: "Remix URL",
      description: "Link that lets someone remix/fork this app.",
      type: "string",
    }),
    defineField({
      name: "buildUrl",
      title: "Build URL",
      description: "Direct deep link to build this app in Whacka.",
      type: "string",
    }),
    defineField({
      name: "status",
      title: "Status",
      type: "string",
      options: {
        list: [
          { title: "Draft", value: "draft" },
          { title: "Published", value: "published" },
          { title: "Archived", value: "archived" },
        ],
        layout: "radio",
      },
      initialValue: "draft",
    }),
    defineField({
      name: "notes",
      title: "Internal Notes",
      description: "Editorial notes, not shown on the site.",
      type: "text",
      rows: 3,
    }),
    defineField({
      name: "utmContent",
      title: "UTM Content",
      description: "Value used for the utm_content tracking parameter on outbound links.",
      type: "string",
    }),
    defineField({
      name: "seo",
      title: "SEO",
      description: "Optional search-engine metadata for this app's detail page. Leave unset to fall back to the page's default title/description.",
      type: "object",
      fields: [
        defineField({
          name: "title",
          title: "SEO Title",
          type: "string",
          validation: (Rule) => Rule.max(70).warning("SEO titles are usually most effective under 70 characters."),
        }),
        defineField({
          name: "metaDescription",
          title: "Meta Description",
          type: "text",
          rows: 2,
          validation: (Rule) => Rule.max(300).warning("Meta descriptions are usually most effective under 160 characters."),
        }),
        defineField({
          name: "primaryKeyword",
          title: "Primary Keyword",
          type: "string",
        }),
        defineField({
          name: "secondaryKeywords",
          title: "Secondary Keywords",
          type: "array",
          of: [{ type: "string" }],
        }),
      ],
    }),
  ],
  preview: {
    select: { title: "name", subtitle: "tagline" },
  },
});
