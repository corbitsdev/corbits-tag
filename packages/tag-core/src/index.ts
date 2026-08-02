/**
 * @corbits/tag-core — transport-agnostic contracts for tag ingress.
 *
 * Platform packages (`@corbits/tag-slack`, ...) normalize platform events
 * into these types; hosts write dispatch logic against them once.
 */
export type {
  PriorTurn,
  TagAttachment,
  TagAuthor,
  TagDispatch,
  TagEvent,
  TagThread,
  TagThreadPostOptions,
} from "./types.ts";
