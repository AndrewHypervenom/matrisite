import { ConvexReactClient } from "convex/react";

const url = import.meta.env.VITE_CONVEX_URL as string;

if (!url) {
  // Surfaced early so misconfiguration is obvious in dev.
  console.error(
    "VITE_CONVEX_URL is not set. Run `npx convex dev` to generate .env.local.",
  );
}

export const convex = new ConvexReactClient(url);
