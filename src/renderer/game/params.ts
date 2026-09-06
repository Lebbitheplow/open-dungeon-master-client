// The params promise a page receives, with its value attached so the
// react shim's use() can answer synchronously (a real promise would
// suspend on every render).
export interface ResolvedParams<T> extends Promise<T> {
  __value: T;
}

export function resolvedParams<T>(value: T): ResolvedParams<T> {
  return Object.assign(Promise.resolve(value), { __value: value });
}
