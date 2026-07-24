/**
 * @corbits/tag-core — transport-agnostic contracts for tag ingress.
 *
 * Platform packages (`@corbits/tag-slack`, ...) normalize platform events
 * into these types; hosts write dispatch logic against them once.
 */
export type { TagAuthor, TagDispatch, TagEvent, TagThread } from "./types.ts";
