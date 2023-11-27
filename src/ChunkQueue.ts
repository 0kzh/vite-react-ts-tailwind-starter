import { OrderedMap } from "immutable";

export class ChunkQueue {
  queue: OrderedMap<string, (...params: any[]) => void>;

  constructor() {
    this.queue = OrderedMap();
  }

  enqueue(chunkPos: { x: number; z: number }, cb: (...params: any[]) => void) {
    this.queue = this.queue.set(`${chunkPos.x},${chunkPos.z}`, cb);
  }

  dequeue() {
    const key = this.queue.keySeq().first();
    if (key) {
      const cb = this.queue.get(key);
      this.queue = this.queue.delete(key);
      const x = parseInt(key.split(",")[0]);
      const z = parseInt(key.split(",")[1]);
      return { x, z, cb };
    }
  }

  get length() {
    return this.queue.size;
  }

  get isEmpty() {
    return this.queue.size === 0;
  }
}
