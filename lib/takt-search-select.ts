import { matchesKey } from "@earendil-works/pi-tui";
import { filterByFuzzyQuery } from "./takt-pi-models.ts";

export interface SearchableListEntry {
  text: string;
  active: boolean;
}

export type SearchableListAction = "confirmed" | "cancelled" | "changed" | "ignored";

const DEFAULT_VISIBLE_LIMIT = 14;

/**
 * Type-to-filter list controller shared by bridge dialogs. Filtering is
 * subsequence fuzzy matching over fully qualified item text; Enter confirms
 * only when an entry is highlighted, and Escape cancels.
 */
export class SearchableListController {
  private query = "";
  private highlight = 0;
  private readonly items: readonly string[];
  private readonly visibleLimit: number;

  constructor(items: readonly string[], visibleLimit = DEFAULT_VISIBLE_LIMIT) {
    this.items = items;
    this.visibleLimit = visibleLimit;
  }

  getQuery(): string {
    return this.query;
  }

  getHighlightedValue(): string | undefined {
    return this.visible()[this.highlight]?.text;
  }

  visible(): SearchableListEntry[] {
    const matches = filterByFuzzyQuery(this.items, this.query, (item) => item, this.visibleLimit);
    return matches.map((text, index) => ({ text, active: index === this.highlight }));
  }

  /** Feed one raw terminal input chunk; returns what the input did. */
  handleInput(data: string): SearchableListAction {
    if (matchesKey(data, "escape")) {
      return "cancelled";
    }
    if (matchesKey(data, "enter")) {
      return this.getHighlightedValue() === undefined ? "ignored" : "confirmed";
    }
    if (matchesKey(data, "up")) {
      this.highlight = Math.max(0, this.highlight - 1);
      return "changed";
    }
    if (matchesKey(data, "down")) {
      const count = this.visible().length;
      this.highlight = Math.min(Math.max(0, count - 1), this.highlight + 1);
      return "changed";
    }
    if (matchesKey(data, "backspace")) {
      if (this.query.length === 0) {
        return "ignored";
      }
      this.query = this.query.slice(0, -1);
      this.highlight = 0;
      return "changed";
    }
    // Printable characters only; ignore control sequences and multi-byte chunks.
    if (data.length === 1 && data >= " " && data !== "\u007f") {
      this.query += data;
      this.highlight = 0;
      return "changed";
    }
    return "ignored";
  }
}
