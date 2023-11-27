import { wrap } from "comlink";
import * as Comlink from "comlink";
import * as THREE from "three";

import { BlockID } from "./Block";
import { BlockFactory } from "./Block/BlockFactory";
import { ChunkQueue } from "./ChunkQueue";
import ChunkWorker, { InstanceData, BufferData } from "./chunkWorker";
// import chunkWorker from "./chunkWorker?worker&url";
import { DataStore } from "./DataStore";

const loader = new THREE.TextureLoader();
const texture = loader.load("/textures/block_atlas.png");
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;
texture.colorSpace = THREE.SRGBColorSpace;

const material = new THREE.MeshLambertMaterial({
  map: texture,
  side: THREE.DoubleSide,
  alphaTest: 0.1,
  transparent: true,
});

const wireframeMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });

const geometry = new THREE.BoxGeometry();

export type WorldParams = {
  seed: number;
  textures: {
    tileSize: number;
    tileTextureWidth: number;
    tileTextureHeight: number;
  };
  terrain: {
    scale: number;
    magnitude: number;
    offset: number;
  };
  surface: {
    offset: number;
    magnitude: number;
  };
  bedrock: {
    offset: number;
    magnitude: number;
  };
  trees: {
    frequency: number;
    trunkHeight: {
      min: number;
      max: number;
    };
    canopy: {
      size: {
        min: number;
        max: number;
      };
    };
  };
};

export type WorldSize = {
  width: number;
  height: number;
};

export class WorldChunk extends THREE.Group {
  data: InstanceData[][][] = [];
  params: WorldParams;
  size: WorldSize;
  loaded: boolean;
  dataStore: DataStore;
  chunkQueue: ChunkQueue;
  static chunkWorker: ChunkWorker;

  constructor(
    size: WorldSize,
    params: WorldParams,
    dataStore: DataStore,
    chunkQueue: ChunkQueue
  ) {
    super();
    this.size = size;
    this.params = params;
    this.dataStore = dataStore;
    this.loaded = false;
    this.chunkQueue = chunkQueue;
    this.initWorker();
  }

  async initWorker() {
    if (WorldChunk.chunkWorker == null) {
      WorldChunk.chunkWorker = await new WorldChunkWorker(
        this.size,
        this.params,
        this.dataStore
      );
    }
  }

  async generate() {
    // const start = performance.now();

    await this.initWorker();

    if (WorldChunk.chunkWorker) {
      WorldChunk.chunkWorker
        .generateChunk(
          this.position.x,
          this.position.z,
          this.dataStore.serializeChanges(this.position.x, this.position.z)
        )
        .then((chunk: BufferData) => {
          this.chunkQueue.enqueue(
            { x: this.position.x, z: this.position.z },
            () => {
              requestIdleCallback(() => {
                this.data = chunk.data;

                const geometry = new THREE.BufferGeometry();
                // data passed is incomplete, re-initialize
                const positions = new THREE.BufferAttribute(
                  new Float32Array(chunk.positions),
                  3
                );
                const normals = new THREE.BufferAttribute(
                  new Float32Array(chunk.normals),
                  3
                );
                const uvs = new THREE.BufferAttribute(
                  new Float32Array(chunk.uvs),
                  2
                );
                geometry.setAttribute("position", positions);
                geometry.setAttribute("normal", normals);
                geometry.setAttribute("uv", uvs);
                geometry.setIndex(chunk.indices);
                const mesh = new THREE.Mesh(geometry, material);
                const wireframe = new THREE.WireframeGeometry(geometry);
                const line = new THREE.LineSegments(
                  wireframe,
                  wireframeMaterial
                );
                // mesh.add(line);

                this.add(mesh);
                this.loaded = true;

                console.log(`Loaded chunk`);
              });
            }
          );
        });
    } else {
      console.log("Chunk worker not initialized");
    }
  }

  /**
   * Loads player changes from the data store
   */
  loadPlayerChanges() {
    for (let x = 0; x < this.size.width; x++) {
      for (let y = 0; y < this.size.height; y++) {
        for (let z = 0; z < this.size.width; z++) {
          // Overwrite with value in data store if it exists
          if (
            this.dataStore.contains(this.position.x, this.position.z, x, y, z)
          ) {
            const blockId = this.dataStore.get(
              this.position.x,
              this.position.z,
              x,
              y,
              z
            );
            console.log(`Overwriting block at ${x}, ${y}, ${z} to ${blockId}`);
            this.setBlockId(x, y, z, blockId);
          }
        }
      }
    }
  }

  setBlockId(x: number, y: number, z: number, blockId: BlockID) {
    if (this.inBounds(x, y, z)) {
      this.data[x][y][z].block = blockId;
    }
  }

  /**
   * Gets the block data at (x, y, z) for this chunk
   */
  getBlock(x: number, y: number, z: number): InstanceData | null {
    if (this.inBounds(x, y, z)) {
      return this.data[x][y][z];
    } else {
      return null;
    }
  }

  /**
   * Adds a new block at (x, y, z) for this chunk
   */
  addBlock(x: number, y: number, z: number, blockId: BlockID) {
    // Safety check that we aren't adding a block for one that already exists
    if (this.getBlock(x, y, z)?.block === BlockID.Air) {
      this.setBlockId(x, y, z, blockId);
      this.dataStore.set(this.position.x, this.position.z, x, y, z, blockId);
    }
  }

  /**
   * Removes the block at (x, y, z)
   */
  removeBlock(x: number, y: number, z: number) {
    const block = this.getBlock(x, y, z);
    if (block && block.block !== BlockID.Air) {
      console.log(`Removing block at ${x}, ${y}, ${z}`);
      this.setBlockId(x, y, z, BlockID.Air);
      this.dataStore.set(
        this.position.x,
        this.position.z,
        x,
        y,
        z,
        BlockID.Air
      );
    }
  }

  /**
   * Checks if the given coordinates are within the world bounds
   */
  inBounds(x: number, y: number, z: number): boolean {
    return (
      x >= 0 &&
      x < this.size.width &&
      y >= 0 &&
      y < this.size.height &&
      z >= 0 &&
      z < this.size.width
    );
  }

  isBlockObscured(x: number, y: number, z: number): boolean {
    const up = this.getBlock(x, y + 1, z);
    const down = this.getBlock(x, y - 1, z);
    const left = this.getBlock(x - 1, y, z);
    const right = this.getBlock(x + 1, y, z);
    const front = this.getBlock(x, y, z + 1);
    const back = this.getBlock(x, y, z - 1);

    // If any of the block's sides are exposed, it's not obscured
    if (
      !up ||
      !down ||
      !left ||
      !right ||
      !front ||
      !back ||
      up?.block === BlockID.Air ||
      down?.block === BlockID.Air ||
      left?.block === BlockID.Air ||
      right?.block === BlockID.Air ||
      front?.block === BlockID.Air ||
      back?.block === BlockID.Air ||
      up?.block === BlockID.Leaves ||
      down?.block === BlockID.Leaves ||
      left?.block === BlockID.Leaves ||
      right?.block === BlockID.Leaves ||
      front?.block === BlockID.Leaves ||
      back?.block === BlockID.Leaves
    ) {
      return false;
    }

    return true;
  }

  disposeChildren() {
    this.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    });
    this.clear();
  }
}

// const WorldChunkWorker: any = new ComlinkWorker<typeof import("./chunkWorker")>(
//   new URL("./chunkWorker", import.meta.url)
// );

const WorldChunkWorker: any = Comlink.wrap<typeof import("./chunkWorker")>(
  new Worker(new URL("./chunkWorker", import.meta.url), { type: "module" })
);
