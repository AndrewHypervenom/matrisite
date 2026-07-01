/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as chat from "../chat.js";
import type * as chunk from "../chunk.js";
import type * as embeddings from "../embeddings.js";
import type * as github from "../github.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as llm from "../llm.js";
import type * as rag from "../rag.js";
import type * as repos from "../repos.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  chat: typeof chat;
  chunk: typeof chunk;
  embeddings: typeof embeddings;
  github: typeof github;
  http: typeof http;
  ingest: typeof ingest;
  llm: typeof llm;
  rag: typeof rag;
  repos: typeof repos;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rag: import("@convex-dev/rag/_generated/component.js").ComponentApi<"rag">;
};
