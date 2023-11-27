import * as THREE from "three";

import { BlockID } from "./Block";
import { ChunkQueue } from "./ChunkQueue";
import { DataStore } from "./DataStore";
import { Player } from "./Player";
import { WorldChunk, WorldParams, WorldSize } from "./WorldChunk";

export class World extends THREE.Group {
  seed: number;
  renderDistance = 10;
  // renderDistance = 6;
  chunkLoadQueue: ChunkQueue;
  minChunkLoadTimeout = 200;
  lastChunkLoadTime = 0;

  asyncLoading = true;
  chunkSize: WorldSize = {
    width: 16,
    height: 64,
  };

  params: WorldParams = {
    seed: 0,
    textures: {
      tileSize: 16,
      tileTextureWidth: 160,
      tileTextureHeight: 64,
    },
    terrain: {
      scale: 50,
      magnitude: 0.1,
      offset: 0.5,
    },
    surface: {
      offset: 4,
      magnitude: 4,
    },
    bedrock: {
      offset: 1,
      magnitude: 1,
    },
    trees: {
      frequency: 0.04,
      trunkHeight: {
        min: 5,
        max: 7,
      },
      canopy: {
        size: {
          min: 1,
          max: 3,
        },
      },
    },
  };

  // Used for persisting changes to the world
  dataStore = new DataStore();

  constructor(seed = 0) {
    super();
    this.seed = seed;
    this.chunkLoadQueue = new ChunkQueue();
  }

  /**
   * Clears existing world data and re-generates everything
   */
  regenerate(player: Player) {
    this.children.forEach((chunk) => {
      (chunk as WorldChunk).disposeChildren();
    });
    this.clear();
    this.update(player);
  }

  /**
   * Updates the visible portions of the world based on the current player position
   */
  update(player: Player) {
    const visibleChunks = this.getVisibleChunks(player);
    const chunksToAdd = this.getChunksToAdd(visibleChunks);
    this.removeUnusedChunks(visibleChunks);

    if (chunksToAdd.length > 0) {
      console.log("Chunks to add", chunksToAdd);
    }

    for (const chunk of chunksToAdd) {
      this.generateChunk(chunk.x, chunk.z);
    }

    // Load chunks from the queue
    if (
      !this.chunkLoadQueue.isEmpty &&
      (!player.controls.isLocked ||
        performance.now() - this.lastChunkLoadTime > this.minChunkLoadTimeout)
    ) {
      const chunk = this.chunkLoadQueue.dequeue();
      if (chunk?.cb) {
        chunk?.cb();
      }
      this.lastChunkLoadTime = performance.now();
    }
  }

  /**
   * Returns an array containing the coordinates of the chunks
   * that are currently visible to the player, starting from the center
   */
  getVisibleChunks(player: Player): { x: number; z: number }[] {
    // get coordinates of the chunk the player is currently on
    const coords = this.worldToChunkCoords(
      player.position.x,
      player.position.y,
      player.position.z
    );

    const visibleChunks = [];
    const range = Array.from(
      { length: this.renderDistance * 2 + 1 },
      (_, i) => i - this.renderDistance
    );
    range.sort((a, b) => Math.abs(a) - Math.abs(b));

    for (const dx of range) {
      for (const dz of range) {
        visibleChunks.push({ x: coords.chunk.x + dx, z: coords.chunk.z + dz });
      }
    }

    // visibleChunks.push({ x: coords.chunk.x, z: coords.chunk.z });

    return visibleChunks;
  }

  /**
   * Returns an array containing the coordinates of the chunks that
   * are not yet loaded and need to be added to the scene
   */
  getChunksToAdd(
    visibleChunks: { x: number; z: number }[]
  ): { x: number; z: number }[] {
    return visibleChunks.filter((chunk) => {
      const chunkExists = this.children
        .map((obj) => obj.userData)
        .find(({ x, z }) => {
          return chunk.x === x && chunk.z == z;
        });

      return !chunkExists;
    });
  }

  /**
   * Removes current loaded chunks that are no longer visible
   */
  removeUnusedChunks(visibleChunks: { x: number; z: number }[]) {
    const chunksToRemove = this.children.filter((obj) => {
      const { x, z } = obj.userData;
      const chunkExists = visibleChunks.find((visibleChunk) => {
        return visibleChunk.x === x && visibleChunk.z === z;
      });

      return !chunkExists;
    });

    chunksToRemove.forEach((chunk) => {
      this.chunkLoadQueue.enqueue(
        { x: chunk.userData.x, z: chunk.userData.z },
        () => {
          requestIdleCallback(() => {
            (chunk as WorldChunk).disposeChildren();
            this.remove(chunk);
            console.log(
              `Removed chunk at X: ${chunk.userData.x} Z: ${chunk.userData.z}`
            );
          });
        }
      );
    });
  }

  /**
   * Generates the chunk at (x, z) coordinates
   */
  async generateChunk(x: number, z: number) {
    const chunk = new WorldChunk(
      this.chunkSize,
      this.params,
      this.dataStore,
      this.chunkLoadQueue
    );
    chunk.position.set(x * this.chunkSize.width, 0, z * this.chunkSize.width);
    chunk.userData = { x, z };

    chunk.generate();

    this.add(chunk);

    return chunk;
  }

  getChunkKey(x: number, z: number) {
    return `${x},${z}`;
  }

  /**
   * Adds a new block at (x, y, z)
   */
  addBlock(x: number, y: number, z: number, block: BlockID) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk && chunk.loaded) {
      chunk.addBlock(coords.block.x, coords.block.y, coords.block.z, block);

      // Hide any blocks that may be totally obscured
      this.hideBlockIfNeeded(x - 1, y, z);
      this.hideBlockIfNeeded(x + 1, y, z);
      this.hideBlockIfNeeded(x, y - 1, z);
      this.hideBlockIfNeeded(x, y + 1, z);
      this.hideBlockIfNeeded(x, y, z - 1);
      this.hideBlockIfNeeded(x, y, z + 1);
    }
  }

  removeBlock(x: number, y: number, z: number) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk && chunk.loaded) {
      console.log(`Removing block at ${x}, ${y}, ${z} for chunk ${chunk.uuid}`);
      chunk.removeBlock(coords.block.x, coords.block.y, coords.block.z);

      // Reveal any adjacent blocks that may have been exposed after the block at (x,y,z) was removed
      this.revealBlock(x - 1, y, z);
      this.revealBlock(x + 1, y, z);
      this.revealBlock(x, y - 1, z);
      this.revealBlock(x, y + 1, z);
      this.revealBlock(x, y, z - 1);
      this.revealBlock(x, y, z + 1);
    }
  }

  /**
   * Gets the block data at (x, y, z)
   */
  getBlock(x: number, y: number, z: number) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk && chunk.loaded) {
      return chunk.getBlock(coords.block.x, y, coords.block.z);
    }
  }

  /**
   * Returns the chunk and world coordinates of the block at (x, y, z)
   *  - `chunk` is the coordinates of the chunk containing the block
   *  - `block` is the world coordinates of the block
   */
  worldToChunkCoords(
    x: number,
    y: number,
    z: number
  ): {
    chunk: { x: number; z: number };
    block: { x: number; y: number; z: number };
  } {
    const chunkX = Math.floor(x / this.chunkSize.width);
    const chunkZ = Math.floor(z / this.chunkSize.width);

    const blockX = x - chunkX * this.chunkSize.width;
    const blockZ = z - chunkZ * this.chunkSize.width;

    return {
      chunk: { x: chunkX, z: chunkZ },
      block: { x: blockX, y, z: blockZ },
    };
  }

  /**
   * Returns the WorldChunk object that contains the specified coordinates
   */
  getChunk(x: number, z: number): WorldChunk | undefined {
    return this.children.find((obj) => {
      return obj.userData.x === x && obj.userData.z === z;
    }) as WorldChunk | undefined;
  }

  /**
   * Reveals block at (x, y, z) by adding new mesh instance
   */
  revealBlock(x: number, y: number, z: number) {
    console.log(`Revealing block at ${x}, ${y}, ${z}`);
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk && chunk.loaded) {
      chunk.addBlockInstance(coords.block.x, coords.block.y, coords.block.z);
    }
  }

  /**
   * Hides block at (x, y, z) by removing mesh instance
   */
  hideBlockIfNeeded(x: number, y: number, z: number) {
    console.log(`Hiding block at ${x}, ${y}, ${z}`);
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (
      chunk &&
      chunk.loaded &&
      chunk.isBlockObscured(coords.block.x, coords.block.y, coords.block.z)
    ) {
      chunk.deleteBlockInstance(coords.block.x, coords.block.y, coords.block.z);
    }
  }
}
