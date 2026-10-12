/**
 * The guest-list query language (docs/CONSOLE_IA.md section 9, pattern 5): a small grammar an
 * owner can read aloud, parsed here into a tree and nowhere else. This file has no imports and
 * no knowledge of the database; `lists.ts` turns the tree into parameterised SQL, and the console
 * uses the same parser so what a person types and what the builder shows are one thing.
 *
 *   query   := group ( "or" group )*
 *   group   := clause ( "and" clause )*
 *   clause  := "(" query ")" | field operator value
 *
 *   fields     last visit · first visit · visits · spend · average spend · said yes to email ·
 *              said yes to texts · loyalty member · no-shows · suburb · source
 *   operators  more than N · less than N · is V · is not V · within the last N days ·
 *              more than N days ago · (dates) is never · (yes/no) bare, is yes, is no
 *
 * Examples: "last visit more than 60 days ago and said yes to email";
 *           "(spend more than $500 or visits more than 10) and suburb is Newtown".
 * "and" binds before "or"; brackets change that. At most ten clauses.
 */

export const MAX_CLAUSES = 10;

export type DateField = 'last_visit' | 'first_visit';
export type NumberField = 'visits' | 'spend' | 'average_spend' | 'no_shows';
export type YesNoField = 'email_yes' | 'texts_yes' | 'loyalty_member';
export type TextField = 'suburb' | 'source';
export type ListField = DateField | NumberField | YesNoField | TextField;

export type ListClause =
  | { field: DateField; op: 'within_days' | 'more_than_days_ago'; days: number }
  | { field: DateField; op: 'never' }
  | { field: NumberField; op: 'more_than' | 'less_than' | 'is' | 'is_not'; value: number }
  | { field: YesNoField; op: 'is' | 'is_not'; value: boolean }
  | { field: TextField; op: 'is' | 'is_not'; value: string };

export type ListNode = ListClause | { and: ListNode[] } | { or: ListNode[] };

export interface FieldInfo {
  field: ListField;
  /** How the field is written in a query. */
  words: string;
  kind: 'date' | 'count' | 'money' | 'yesno' | 'text';
  /** For the builder's field picker. */
  hint: string;
}

/** Every field, in the order the builder offers them. The words are the grammar. */
export const LIST_FIELDS: FieldInfo[] = [
  { field: 'last_visit', words: 'last visit', kind: 'date', hint: 'Their most recent paid visit, online or at the till.' },
  { field: 'first_visit', words: 'first visit', kind: 'date', hint: 'Their first paid visit, or when they were first known if they have not bought yet.' },
  { field: 'visits', words: 'visits', kind: 'count', hint: 'Paid visits on record.' },
  { field: 'spend', words: 'spend', kind: 'money', hint: 'Everything they have spent, after refunds.' },
  { field: 'average_spend', words: 'average spend', kind: 'money', hint: 'Spend divided by visits.' },
  { field: 'email_yes', words: 'said yes to email', kind: 'yesno', hint: 'Holds marketing-email consent now.' },
  { field: 'texts_yes', words: 'said yes to texts', kind: 'yesno', hint: 'Holds marketing-SMS consent now.' },
  { field: 'loyalty_member', words: 'loyalty member', kind: 'yesno', hint: 'Has joined the loyalty programme.' },
  { field: 'no_shows', words: 'no-shows', kind: 'count', hint: 'Bookings they did not turn up for.' },
  { field: 'suburb', words: 'suburb', kind: 'text', hint: 'The suburb on their record.' },
  { field: 'source', words: 'source', kind: 'text', hint: 'Where they first came from: organic, walk-in, criota, meta, google, referral.' },
];

export const OPERATORS: Record<FieldInfo['kind'], Array<{ op: string; words: string }>> = {
  date: [
    { op: 'within_days', words: 'within the last … days' },
    { op: 'more_than_days_ago', words: 'more than … days ago' },
    { op: 'never', words: 'is never' },
  ],
  count: [
    { op: 'more_than', words: 'more than' },
    { op: 'less_than', words: 'less than' },
    { op: 'is', words: 'is' },
    { op: 'is_not', words: 'is not' },
  ],
  money: [
    { op: 'more_than', words: 'more than' },
    { op: 'less_than', words: 'less than' },
    { op: 'is', words: 'is' },
    { op: 'is_not', words: 'is not' },
  ],
  yesno: [
    { op: 'is', words: 'is' },
    { op: 'is_not', words: 'is not' },
  ],
  text: [
    { op: 'is', words: 'is' },
    { op: 'is_not', words: 'is not' },
  ],
};

export const fieldInfo = (field: ListField): FieldInfo => LIST_FIELDS.find((f) => f.field === field)!;

/** A refusal the person reads. Thrown by `parseListText`; the service turns it into an `invalid` error. */
export class ListQueryError extends Error {
  constructor(
    message: string,
    /** Where in the text, 0-based, when known. */
    public readonly at: number | null = null,
  ) {
    super(message);
    this.name = 'ListQueryError';
  }
}

// ── Tokens ────────────────────────────────────────────────────────────────────

type Token = { kind: 'word'; text: string; raw: string; at: number } | { kind: 'number'; value: number; money: boolean; at: number } | { kind: 'quoted'; text: string; at: number } | { kind: '('; at: number } | { kind: ')'; at: number };

const NUMBER = /^\$?\d[\d,]*(?:\.\d+)?/;
const WORD = /^[A-Za-z][A-Za-z'-]*/;
const MAX_TEXT = 600;

function tokenize(text: string): Token[] {
  if (text.length > MAX_TEXT) throw new ListQueryError(`Keep a list rule under ${MAX_TEXT} characters.`);
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      out.push({ kind: ch, at: i });
      i++;
      continue;
    }
    if (ch === '"' || ch === '“' || ch === "'" || ch === '‘') {
      const close = ch === '“' ? '”' : ch === '‘' ? '’' : ch;
      const end = text.indexOf(close, i + 1);
      if (end < 0) throw new ListQueryError('A quote was opened and not closed.', i);
      out.push({ kind: 'quoted', text: text.slice(i + 1, end).trim(), at: i });
      i = end + 1;
      continue;
    }
    const rest = text.slice(i);
    const num = NUMBER.exec(rest);
    if (num) {
      const raw = num[0];
      const value = Number(raw.replace(/[$,]/g, ''));
      if (!Number.isFinite(value)) throw new ListQueryError(`"${raw}" is not a number I can read.`, i);
      out.push({ kind: 'number', value, money: raw.startsWith('$'), at: i });
      i += raw.length;
      continue;
    }
    const word = WORD.exec(rest);
    if (word) {
      out.push({ kind: 'word', text: word[0].toLowerCase(), raw: word[0], at: i });
      i += word[0].length;
      continue;
    }
    // Anything else (a semicolon, a quote mark mid-word, an operator symbol) has no place here.
    throw new ListQueryError(`I do not understand "${ch}" here. A rule uses words, numbers and brackets only.`, i);
  }
  return out;
}

// ── Parser ────────────────────────────────────────────────────────────────────

const FIELD_WORDS: Array<{ words: string[]; field: ListField }> = [
  { words: ['said', 'yes', 'to', 'email'], field: 'email_yes' },
  { words: ['said', 'yes', 'to', 'emails'], field: 'email_yes' },
  { words: ['said', 'yes', 'to', 'texts'], field: 'texts_yes' },
  { words: ['said', 'yes', 'to', 'sms'], field: 'texts_yes' },
  { words: ['average', 'spend'], field: 'average_spend' },
  { words: ['last', 'visit'], field: 'last_visit' },
  { words: ['first', 'visit'], field: 'first_visit' },
  { words: ['loyalty', 'member'], field: 'loyalty_member' },
  { words: ['no-shows'], field: 'no_shows' },
  { words: ['no-show'], field: 'no_shows' },
  { words: ['no', 'shows'], field: 'no_shows' },
  { words: ['visits'], field: 'visits' },
  { words: ['spend'], field: 'spend' },
  { words: ['suburb'], field: 'suburb' },
  { words: ['source'], field: 'source' },
];

const YES = new Set(['yes', 'true']);
const NO = new Set(['no', 'false']);

class Parser {
  private i = 0;
  clauses = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(n = 0): Token | undefined {
    return this.tokens[this.i + n];
  }
  private isWord(t: Token | undefined, text: string): boolean {
    return !!t && t.kind === 'word' && t.text === text;
  }
  private expectWord(text: string, what: string): void {
    const t = this.peek();
    if (!this.isWord(t, text)) throw new ListQueryError(what, t?.at ?? null);
    this.i++;
  }
  private atEnd(): boolean {
    return this.i >= this.tokens.length;
  }

  parse(): ListNode {
    if (this.atEnd()) throw new ListQueryError('Write a rule, such as "last visit more than 60 days ago".');
    const node = this.query();
    if (!this.atEnd()) {
      const t = this.peek()!;
      if (t.kind === ')') throw new ListQueryError('A bracket was closed that was never opened.', t.at);
      throw new ListQueryError(this.isWord(t, 'not') ? 'Put "not" after "is": "suburb is not Newtown".' : `I did not expect ${describe(t)} here. Join rules with "and" or "or".`, t.at);
    }
    return node;
  }

  private query(): ListNode {
    const groups = [this.group()];
    while (this.isWord(this.peek(), 'or')) {
      this.i++;
      groups.push(this.group());
    }
    return groups.length === 1 ? groups[0]! : { or: groups };
  }

  private group(): ListNode {
    const clauses = [this.clause()];
    while (this.isWord(this.peek(), 'and')) {
      this.i++;
      clauses.push(this.clause());
    }
    return clauses.length === 1 ? clauses[0]! : { and: clauses };
  }

  private clause(): ListNode {
    const t = this.peek();
    if (!t) throw new ListQueryError('The rule ends where a condition should be.');
    if (t.kind === '(') {
      this.i++;
      const inner = this.query();
      const close = this.peek();
      if (!close || close.kind !== ')') throw new ListQueryError('A bracket was opened and not closed.', t.at);
      this.i++;
      return inner;
    }
    if (t.kind === ')') throw new ListQueryError('A bracket was closed that was never opened.', t.at);
    if (++this.clauses > MAX_CLAUSES) throw new ListQueryError(`A list can have at most ${MAX_CLAUSES} conditions. Split it into two lists.`, t.at);
    const field = this.field();
    const info = fieldInfo(field);
    switch (info.kind) {
      case 'date':
        return this.dateClause(field as DateField);
      case 'count':
      case 'money':
        return this.numberClause(field as NumberField, info.kind);
      case 'yesno':
        return this.yesNoClause(field as YesNoField);
      case 'text':
        return this.textClause(field as TextField);
    }
  }

  private field(): ListField {
    const t = this.peek()!;
    if (t.kind !== 'word') throw new ListQueryError(`A condition starts with a field (${LIST_FIELDS.map((f) => f.words).join(', ')}), not ${describe(t)}.`, t.at);
    for (const f of FIELD_WORDS) {
      if (f.words.every((w, k) => this.isWord(this.peek(k), w))) {
        this.i += f.words.length;
        return f.field;
      }
    }
    throw new ListQueryError(`"${t.text}" is not a field I know. Use one of: ${LIST_FIELDS.map((f) => f.words).join(', ')}.`, t.at);
  }

  private number(what: string, money: boolean): number {
    const t = this.peek();
    if (!t || t.kind !== 'number') throw new ListQueryError(`${what} needs a number${money ? ', such as $50' : ''}.`, t?.at ?? null);
    this.i++;
    if (t.value < 0 || t.value > 1_000_000_000) throw new ListQueryError('That number is out of range.', t.at);
    return money ? Math.round(t.value * 100) : Math.trunc(t.value);
  }

  private dateClause(field: DateField): ListClause {
    const words = fieldInfo(field).words;
    // within the last N days
    if (this.isWord(this.peek(), 'within')) {
      this.i++;
      if (this.isWord(this.peek(), 'the')) this.i++;
      this.expectWord('last', `After "${words} within" write "the last N days".`);
      const days = this.number(`"${words} within the last"`, false);
      this.daysWord(days);
      return { field, op: 'within_days', days };
    }
    // in the last N days (accepted, written back as "within")
    if (this.isWord(this.peek(), 'in') && this.isWord(this.peek(1), 'the') && this.isWord(this.peek(2), 'last')) {
      this.i += 3;
      const days = this.number(`"${words} in the last"`, false);
      this.daysWord(days);
      return { field, op: 'within_days', days };
    }
    // more than N days ago
    if (this.isWord(this.peek(), 'more') && this.isWord(this.peek(1), 'than')) {
      this.i += 2;
      const days = this.number(`"${words} more than"`, false);
      this.daysWord(days);
      this.expectWord('ago', `Write "${words} more than ${days} days ago".`);
      return { field, op: 'more_than_days_ago', days };
    }
    // is never
    if (this.isWord(this.peek(), 'is') && this.isWord(this.peek(1), 'never')) {
      this.i += 2;
      return { field, op: 'never' };
    }
    if (this.isWord(this.peek(), 'never')) {
      this.i++;
      return { field, op: 'never' };
    }
    throw new ListQueryError(`After "${words}" write "within the last N days", "more than N days ago" or "is never".`, this.peek()?.at ?? null);
  }

  private daysWord(days: number): void {
    const t = this.peek();
    if (this.isWord(t, 'days') || this.isWord(t, 'day')) {
      this.i++;
      return;
    }
    if (this.isWord(t, 'weeks') || this.isWord(t, 'week') || this.isWord(t, 'months') || this.isWord(t, 'month')) {
      throw new ListQueryError(`Count in days: "${days * (t!.kind === 'word' && t!.text.startsWith('week') ? 7 : 30)} days".`, t!.at);
    }
    throw new ListQueryError('Write the number of days, such as "60 days".', t?.at ?? null);
  }

  private comparison(): 'more_than' | 'less_than' | 'is' | 'is_not' {
    const t = this.peek();
    if (this.isWord(t, 'more') && this.isWord(this.peek(1), 'than')) {
      this.i += 2;
      return 'more_than';
    }
    if ((this.isWord(t, 'over') || this.isWord(t, 'above')) && this.peek(1)?.kind === 'number') {
      this.i++;
      return 'more_than';
    }
    if (this.isWord(t, 'less') && this.isWord(this.peek(1), 'than')) {
      this.i += 2;
      return 'less_than';
    }
    if ((this.isWord(t, 'under') || this.isWord(t, 'below')) && this.peek(1)?.kind === 'number') {
      this.i++;
      return 'less_than';
    }
    if (this.isWord(t, 'is')) {
      this.i++;
      if (this.isWord(this.peek(), 'not')) {
        this.i++;
        return 'is_not';
      }
      return 'is';
    }
    throw new ListQueryError('Use "more than", "less than", "is" or "is not" here.', t?.at ?? null);
  }

  private numberClause(field: NumberField, kind: 'count' | 'money'): ListClause {
    const op = this.comparison();
    const value = this.number(`"${fieldInfo(field).words} ${op.replace('_', ' ')}"`, kind === 'money');
    return { field, op, value };
  }

  private yesNoClause(field: YesNoField): ListClause {
    const t = this.peek();
    // A bare field reads as "yes": "said yes to email and visits more than 3".
    if (!t || this.isWord(t, 'and') || this.isWord(t, 'or') || t.kind === ')') return { field, op: 'is', value: true };
    if (!this.isWord(t, 'is')) throw new ListQueryError(`After "${fieldInfo(field).words}" write "is yes" or "is no", or leave it as it is to mean yes.`, t.at);
    this.i++;
    let op: 'is' | 'is_not' = 'is';
    if (this.isWord(this.peek(), 'not')) {
      this.i++;
      op = 'is_not';
    }
    const v = this.peek();
    if (!v || v.kind !== 'word' || !(YES.has(v.text) || NO.has(v.text))) throw new ListQueryError('Say "yes" or "no".', v?.at ?? null);
    this.i++;
    return { field, op, value: YES.has(v.text) };
  }

  private textClause(field: TextField): ListClause {
    const t = this.peek();
    if (!this.isWord(t, 'is')) throw new ListQueryError(`After "${fieldInfo(field).words}" write "is <value>" or "is not <value>".`, t?.at ?? null);
    this.i++;
    let op: 'is' | 'is_not' = 'is';
    if (this.isWord(this.peek(), 'not')) {
      this.i++;
      op = 'is_not';
    }
    const first = this.peek();
    if (!first) throw new ListQueryError(`Give the ${fieldInfo(field).words}, such as "${field === 'suburb' ? 'Newtown' : 'walk-in'}".`);
    if (first.kind === 'quoted') {
      this.i++;
      if (!first.text) throw new ListQueryError('The quotes are empty.', first.at);
      return { field, op, value: first.text.slice(0, 80) };
    }
    // Unquoted: words up to the next and / or / bracket / end. Numbers are allowed inside (a postcode-ish suburb).
    const parts: string[] = [];
    while (!this.atEnd()) {
      const x = this.peek()!;
      if (x.kind === '(' || x.kind === ')' || this.isWord(x, 'and') || this.isWord(x, 'or')) break;
      if (x.kind === 'word') parts.push(originalCase(x));
      else if (x.kind === 'number') parts.push(String(x.value));
      else break;
      this.i++;
    }
    if (!parts.length) throw new ListQueryError(`Give the ${fieldInfo(field).words}, such as "${field === 'suburb' ? 'Newtown' : 'walk-in'}".`, first.at);
    return { field, op, value: parts.join(' ').slice(0, 80) };
  }
}

/** Words are lower-cased for matching; a suburb keeps the case the person typed. */
const originalCase = (t: Token & { kind: 'word' }): string => t.raw;

function describe(t: Token): string {
  switch (t.kind) {
    case 'word':
      return `"${t.text}"`;
    case 'number':
      return `the number ${t.money ? '$' : ''}${t.value}`;
    case 'quoted':
      return `"${t.text}"`;
    default:
      return `"${t.kind}"`;
  }
}

/** Parse a rule. Throws ListQueryError with a sentence the person can act on. */
export function parseListText(text: string): ListNode {
  const p = new Parser(tokenize(text));
  return p.parse();
}

/** How many conditions a tree holds. */
export function countClauses(node: ListNode): number {
  if ('and' in node) return node.and.reduce((n, x) => n + countClauses(x), 0);
  if ('or' in node) return node.or.reduce((n, x) => n + countClauses(x), 0);
  return 1;
}

// ── Formatting: tree → canonical text ─────────────────────────────────────────

const money = (cents: number) => {
  const d = cents / 100;
  return `$${Number.isInteger(d) ? d.toLocaleString('en-AU') : d.toFixed(2)}`;
};
/** A value is written bare only when it would read back as the same plain words; anything else is quoted. */
const needsQuotes = (v: string) => !/^[A-Za-z][A-Za-z']*(?:[ -][A-Za-z][A-Za-z']*)*$/.test(v) || /\b(and|or|is|not)\b/i.test(v);

/** One condition as words. */
export function clauseText(c: ListClause): string {
  const words = fieldInfo(c.field).words;
  switch (c.field) {
    case 'last_visit':
    case 'first_visit':
      if (c.op === 'never') return `${words} is never`;
      return c.op === 'within_days' ? `${words} within the last ${c.days} days` : `${words} more than ${c.days} days ago`;
    case 'visits':
    case 'no_shows':
    case 'spend':
    case 'average_spend': {
      const v = fieldInfo(c.field).kind === 'money' ? money(c.value) : String(c.value);
      return `${words} ${c.op === 'more_than' ? 'more than' : c.op === 'less_than' ? 'less than' : c.op === 'is' ? 'is' : 'is not'} ${v}`;
    }
    case 'email_yes':
    case 'texts_yes':
    case 'loyalty_member':
      return `${words} ${c.op === 'is' ? 'is' : 'is not'} ${c.value ? 'yes' : 'no'}`;
    case 'suburb':
    case 'source':
      return `${words} ${c.op === 'is' ? 'is' : 'is not'} ${needsQuotes(c.value) ? `"${c.value.replace(/"/g, '')}"` : c.value}`;
  }
}

/** The whole tree as the text that parses back to the same tree. */
export function listText(node: ListNode, top = true): string {
  if ('and' in node) {
    const s = node.and.map((x) => listText(x, false)).join(' and ');
    return s;
  }
  if ('or' in node) {
    const s = node.or.map((x) => ('and' in x ? `(${listText(x, false)})` : listText(x, false))).join(' or ');
    return top ? s : `(${s})`;
  }
  return clauseText(node);
}

/** A sentence a venue owner reads: "guests whose last visit was more than 60 days ago and who said yes to email". */
export function listWords(node: ListNode): string {
  const clause = (c: ListClause): string => {
    switch (c.field) {
      case 'last_visit':
      case 'first_visit': {
        const w = c.field === 'last_visit' ? 'last visit' : 'first visit';
        if (c.op === 'never') return `have never visited`;
        return c.op === 'within_days' ? `${w} was in the last ${c.days} days` : `${w} was more than ${c.days} days ago`;
      }
      case 'visits':
        return `have ${c.op === 'more_than' ? 'more than' : c.op === 'less_than' ? 'fewer than' : c.op === 'is' ? 'exactly' : 'not exactly'} ${c.value} ${c.value === 1 ? 'visit' : 'visits'}`;
      case 'no_shows':
        return `have ${c.op === 'more_than' ? 'more than' : c.op === 'less_than' ? 'fewer than' : c.op === 'is' ? 'exactly' : 'not exactly'} ${c.value} no-show${c.value === 1 ? '' : 's'}`;
      case 'spend':
        return `have spent ${c.op === 'more_than' ? 'more than' : c.op === 'less_than' ? 'less than' : c.op === 'is' ? 'exactly' : 'anything but'} ${money(c.value)}`;
      case 'average_spend':
        return `spend ${c.op === 'more_than' ? 'more than' : c.op === 'less_than' ? 'less than' : c.op === 'is' ? 'exactly' : 'anything but'} ${money(c.value)} a visit on average`;
      case 'email_yes':
        return (c.op === 'is') === c.value ? 'said yes to email' : 'have not said yes to email';
      case 'texts_yes':
        return (c.op === 'is') === c.value ? 'said yes to texts' : 'have not said yes to texts';
      case 'loyalty_member':
        return (c.op === 'is') === c.value ? 'are loyalty members' : 'are not loyalty members';
      case 'suburb':
        return `${c.op === 'is' ? 'live in' : 'do not live in'} ${c.value}`;
      case 'source':
        return `${c.op === 'is' ? 'first came from' : 'did not first come from'} ${c.value}`;
    }
  };
  const walk = (n: ListNode, top: boolean): string => {
    if ('and' in n) return n.and.map((x) => walk(x, false)).join(' and ');
    if ('or' in n) {
      const s = n.or.map((x) => ('and' in x ? `(${walk(x, false)})` : walk(x, false))).join(', or ');
      return top ? s : `(${s})`;
    }
    return clause(n);
  };
  return `Guests who ${walk(node, true)}`;
}

/** Deep equality for two trees, for the round-trip check. */
export function sameList(a: ListNode, b: ListNode): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
