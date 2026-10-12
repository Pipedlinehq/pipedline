import 'server-only';
import { identity } from '@ros/modules';
import type { BuilderField, BuilderRow, ParsedRows } from '@/components/console/list-builder';

/** The grammar's fields and operators as the builder needs them: plain data for a client component. */
export const BUILDER_FIELDS: BuilderField[] = identity.LIST_FIELDS.map((f) => ({ field: f.field, words: f.words, kind: f.kind, hint: f.hint, operators: identity.OPERATORS[f.kind] }));

/** A flat tree (one and/or level of plain conditions) as builder rows; anything nested is words only. */
export function rowsOf(node: identity.ListNode): ParsedRows {
  const row = (c: identity.ListClause): BuilderRow | null => {
    switch (c.field) {
      case 'last_visit':
      case 'first_visit':
        return c.op === 'never' ? { field: c.field, op: 'never', value: '' } : { field: c.field, op: c.op, value: String(c.days) };
      case 'visits':
      case 'no_shows':
        return { field: c.field, op: c.op, value: String(c.value) };
      case 'spend':
      case 'average_spend':
        return { field: c.field, op: c.op, value: (c.value / 100).toFixed(2).replace(/\.00$/, '') };
      case 'email_yes':
      case 'texts_yes':
      case 'loyalty_member':
        return { field: c.field, op: c.op, value: c.value ? 'yes' : 'no' };
      case 'suburb':
      case 'source':
        return { field: c.field, op: c.op, value: c.value };
    }
  };
  if ('and' in node || 'or' in node) {
    const join: 'and' | 'or' = 'and' in node ? 'and' : 'or';
    const kids = 'and' in node ? node.and : node.or;
    const rows = kids.map((k) => ('and' in k || 'or' in k ? null : row(k)));
    return rows.every((r): r is BuilderRow => r !== null) ? { join, rows } : null;
  }
  const single = row(node);
  return single ? { join: 'and', rows: [single] } : null;
}

/** A saved rule for the builder: canonical text, words, and rows when the tree is flat. */
export function describeQuery(query: string): { text: string; words: string; rows: ParsedRows } {
  const node = identity.parseListQuery(query);
  return { text: identity.listText(node), words: identity.listWords(node), rows: rowsOf(node) };
}
