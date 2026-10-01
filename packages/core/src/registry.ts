/**
 * Process-wide registries: the module catalogue, events, jobs, tools, templates, plugs, and the
 * hooks modules use to react to each other. They are filled as a side effect of importing a
 * module's files.
 *
 * Two things make that fragile, and this file is the one place that deals with them:
 *
 *   - A bundler may evaluate a package more than once. Registries therefore live on globalThis,
 *     so every copy of the code sees the same one.
 *   - In development, hot reload re-evaluates a file that changed, and its registrations run
 *     again. Outside development a duplicate key is a real mistake and throws. In development
 *     the newer registration replaces the older one, and a file's hooks from its previous
 *     evaluation are dropped when it registers again.
 */
const STORE = Symbol.for('ros.registries');
type Store = Map<string, unknown>;

function store(): Store {
  const g = globalThis as { [STORE]?: Store };
  return (g[STORE] ??= new Map());
}

const hotReload = () => process.env.NODE_ENV === 'development';
/**
 * Under a test runner every file is evaluated exactly once, so a duplicate key is a real
 * mistake and throws. A bundler (the web app's build, or its dev server) may evaluate the same
 * module in more than one chunk of one process; there the later registration replaces the
 * earlier one, which is the same definition.
 */
const strict = () => process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

/** A keyed registry shared by the whole process. */
export function keyedRegistry<V>(name: string): Map<string, V> {
  const s = store();
  let m = s.get(`map:${name}`) as Map<string, V> | undefined;
  if (!m) s.set(`map:${name}`, (m = new Map<string, V>()));
  return m;
}

/** Add to a keyed registry. A duplicate key throws, except under hot reload where it replaces. */
export function register<V>(registry: Map<string, V>, key: string, value: V, what: string): V {
  if (registry.has(key) && strict()) throw new Error(`${what} ${key} is already defined`);
  registry.set(key, value);
  return value;
}

interface HookEntry<T> {
  fn: T;
  file: string;
  epoch: number;
}

let epoch = 0;
let epochOpen = false;

/** All registrations made in one synchronous stretch (one file evaluation) share an epoch. */
function currentEpoch(): number {
  if (!epochOpen) {
    epoch++;
    epochOpen = true;
    queueMicrotask(() => {
      epochOpen = false;
    });
  }
  return epoch;
}

function callerFile(): string {
  const stack = new Error().stack?.split('\n') ?? [];
  // 0: Error, 1: callerFile, 2: add, 3: the module's own on…() function, 4: the registering file.
  for (const line of stack.slice(3)) {
    const m = line.match(/\(?((?:file:\/\/|\/|[A-Za-z]:\\|webpack-internal:|\[project\]|\.{1,2}\/)[^():]+?)(?::\d+){1,2}\)?$/);
    if (m && !m[1]!.includes('/core/src/registry')) return m[1]!;
  }
  return 'unknown';
}

export interface HookList<T> {
  add(fn: T): void;
  remove(fn: T): void;
  all(): T[];
}

/** An ordered list of handlers shared by the whole process. */
export function hookList<T>(name: string): HookList<T> {
  const s = store();
  let entries = s.get(`hooks:${name}`) as HookEntry<T>[] | undefined;
  if (!entries) s.set(`hooks:${name}`, (entries = []));
  const list = entries;
  return {
    add(fn) {
      if (strict()) {
        list.push({ fn, file: '', epoch: 0 });
        return;
      }
      // The same module evaluated in a second chunk registers the same handler again: keep one.
      const source = String(fn);
      for (let i = list.length - 1; i >= 0; i--) {
        if (String(list[i]!.fn) === source) list.splice(i, 1);
      }
      if (!hotReload()) {
        list.push({ fn, file: '', epoch: 0 });
        return;
      }
      const file = callerFile();
      const now = currentEpoch();
      // The file is being evaluated again: what it registered last time is stale.
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]!.file === file && list[i]!.epoch !== now) list.splice(i, 1);
      }
      list.push({ fn, file, epoch: now });
    },
    remove(fn) {
      const i = list.findIndex((e) => e.fn === fn);
      if (i >= 0) list.splice(i, 1);
    },
    all: () => list.map((e) => e.fn),
  };
}

/** A single-valued slot (e.g. "the catalog resolver"). Last registration wins. */
export function slot<T>(name: string): { set(value: T): void; get(): T | null } {
  const s = store();
  return {
    set: (value) => void s.set(`slot:${name}`, value),
    get: () => (s.get(`slot:${name}`) as T | undefined) ?? null,
  };
}
