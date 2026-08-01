// 进程内 TTL 缓存：避免短时间内重复搜索相同 query 造成重复开销。

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /** 已过期条目视为未命中（惰性删除） */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined)
      return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  /** 当前有效条目数（惰性清理过期条目后统计） */
  size(): number {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt)
        this.entries.delete(key);
    }
    return this.entries.size;
  }
}
