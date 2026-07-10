import type { APIRoute } from "astro";

const FALLBACK_SITE_URL = "http://localhost:4321";

export const GET: APIRoute = () => {
  const siteUrl = (import.meta.env.PUBLIC_SITE_URL || FALLBACK_SITE_URL).replace(/\/+$/, "");

  const body = `User-agent: *
Allow: /
Sitemap: ${siteUrl}/sitemap.xml
`;

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
