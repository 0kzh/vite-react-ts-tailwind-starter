/// <reference lib="webworker" />
import * as Comlink from "comlink";
import * as THREE from "three";
import { SimplexNoise } from "three/examples/jsm/math/SimplexNoise";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { BlockID, oreConfig } from "./Block";
import { BlockFactory } from "./Block/BlockFactory";
import { DataStore } from "./DataStore";
import { RNG } from "./RNG";
import { WorldParams, WorldSize } from "./WorldChunk";

declare const self: DedicatedWorkerGlobalScope;

const faces = [
  {
    // left
    uvRow: 0,
    dir: [-1, 0, 0],
    corners: [
      { pos: [0, 1, 0], uv: [0, 1] },
      { pos: [0, 0, 0], uv: [0, 0] },
      { pos: [0, 1, 1], uv: [1, 1] },
      { pos: [0, 0, 1], uv: [1, 0] },
    ],
    index: 0,
  },
  {
    // right
    uvRow: 0,
    dir: [1, 0, 0],
    corners: [
      { pos: [1, 1, 1], uv: [0, 1] },
      { pos: [1, 0, 1], uv: [0, 0] },
      { pos: [1, 1, 0], uv: [1, 1] },
      { pos: [1, 0, 0], uv: [1, 0] },
    ],
    index: 1,
  },
  {
    // bottom
    uvRow: 2,
    dir: [0, -1, 0],
    corners: [
      { pos: [1, 0, 1], uv: [1, 0] },
      { pos: [0, 0, 1], uv: [0, 0] },
      { pos: [1, 0, 0], uv: [1, 1] },
      { pos: [0, 0, 0], uv: [0, 1] },
    ],
    index: 2,
  },
  {
    // top
    uvRow: 1,
    dir: [0, 1, 0],
    corners: [
      { pos: [0, 1, 1], uv: [1, 1] },
      { pos: [1, 1, 1], uv: [0, 1] },
      { pos: [0, 1, 0], uv: [1, 0] },
      { pos: [1, 1, 0], uv: [0, 0] },
    ],
    index: 3,
  },
  {
    // back
    uvRow: 0,
    dir: [0, 0, -1],
    corners: [
      { pos: [1, 0, 0], uv: [0, 0] },
      { pos: [0, 0, 0], uv: [1, 0] },
      { pos: [1, 1, 0], uv: [0, 1] },
      { pos: [0, 1, 0], uv: [1, 1] },
    ],
    index: 4,
  },
  {
    // front
    uvRow: 0,
    dir: [0, 0, 1],
    corners: [
      { pos: [0, 0, 1], uv: [0, 0] },
      { pos: [1, 0, 1], uv: [1, 0] },
      { pos: [0, 1, 1], uv: [0, 1] },
      { pos: [1, 1, 1], uv: [1, 1] },
    ],
    index: 5,
  },
];

export type InstanceData = {
  block: BlockID;
  instanceId: number | null; // reference to mesh instanceId
};

export type BufferData = {
  data: InstanceData[][][];
  positions: number[];
  normals: number[];
  indices: number[];
  uvs: number[];
};

type ChangeRecord = { x: number; y: number; z: number; blockId: BlockID };

export class ChunkWorker {
  data: InstanceData[][][] = [];
  size: WorldSize;
  params: WorldParams;
  rng: RNG;

  constructor(size: WorldSize, params: WorldParams) {
    this.size = size;
    this.params = params;
    this.rng = new RNG(params.seed);
  }

  async generateChunk(
    x: number,
    z: number,
    changes: ChangeRecord[]
  ): Promise<BufferData> {
    console.log("changes", changes);
    const chunkPos = new THREE.Vector3(x, 0, z);
    this.initEmptyChunk();

    this.generateResources(chunkPos);
    this.generateTerrain(chunkPos);
    this.generateTrees(chunkPos);
    this.loadPlayerChanges(chunkPos, changes);
    const chunk: BufferData = this.generateMeshes();

    return chunk;
  }

  initEmptyChunk() {
    this.data = [];
    for (let x = 0; x < this.size.width; x++) {
      const slice = [];
      for (let y = 0; y < this.size.height; y++) {
        const row: InstanceData[] = [];
        for (let z = 0; z < this.size.width; z++) {
          row.push({
            block: BlockID.Air,
            instanceId: null,
          });
        }
        slice.push(row);
      }
      this.data.push(slice);
    }
  }

  /**
   * Generates the resources (coal, stone, etc.) for the world
   */
  generateResources(chunkPos: THREE.Vector3) {
    const simplex = new SimplexNoise(this.rng);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [_, config] of Object.entries(oreConfig)) {
      for (let x = 0; x < this.size.width; x++) {
        for (let y = 0; y < this.size.height; y++) {
          for (let z = 0; z < this.size.width; z++) {
            const value = simplex.noise3d(
              (chunkPos.x + x) / config.scale.x,
              (chunkPos.y + y) / config.scale.y,
              (chunkPos.z + z) / config.scale.z
            );

            if (value > config.scarcity) {
              this.setBlockId(x, y, z, config.id);
            }
          }
        }
      }
    }
  }

  /**
   * Generates the terrain data
   */
  generateTerrain(chunkPos: THREE.Vector3) {
    const simplex = new SimplexNoise(this.rng);
    for (let x = 0; x < this.size.width; x++) {
      for (let z = 0; z < this.size.width; z++) {
        const value = simplex.noise(
          (chunkPos.x + x) / this.params.terrain.scale,
          (chunkPos.z + z) / this.params.terrain.scale
        );

        const scaledNoise =
          this.params.terrain.offset + this.params.terrain.magnitude * value;

        let height = Math.floor(this.size.height * scaledNoise);
        height = Math.max(0, Math.min(height, this.size.height - 1));

        const numSurfaceBlocks =
          this.params.surface.offset +
          Math.abs(simplex.noise(x, z) * this.params.surface.magnitude);

        const numBedrockBlocks =
          this.params.bedrock.offset +
          Math.abs(simplex.noise(x, z) * this.params.bedrock.magnitude);

        for (let y = 0; y < this.size.height; y++) {
          if (y < height) {
            if (y < numBedrockBlocks) {
              this.setBlockId(x, y, z, BlockID.Bedrock);
            } else if (y < height - numSurfaceBlocks) {
              if (this.getBlock(x, y, z)?.block === BlockID.Air) {
                this.setBlockId(x, y, z, BlockID.Stone);
              }
            } else {
              this.setBlockId(x, y, z, BlockID.Dirt);
            }
          } else if (y === height) {
            this.setBlockId(x, y, z, BlockID.Grass);
          } else if (y > height) {
            this.setBlockId(x, y, z, BlockID.Air);
          }
        }
      }
    }
  }

  /**
   * Generates trees
   */
  generateTrees(chunkPos: THREE.Vector3) {
    const simplex = new SimplexNoise(this.rng);
    const canopySize = this.params.trees.canopy.size.max;
    for (
      let baseX = canopySize;
      baseX < this.size.width - canopySize;
      baseX++
    ) {
      for (
        let baseZ = canopySize;
        baseZ < this.size.width - canopySize;
        baseZ++
      ) {
        const n =
          simplex.noise(chunkPos.x + baseX, chunkPos.z + baseZ) * 0.5 + 0.5;
        if (n < 1 - this.params.trees.frequency) {
          continue;
        }

        // Find the grass tile
        for (let y = this.size.height - 1; y >= 0; y--) {
          if (this.getBlock(baseX, y, baseZ)?.block !== BlockID.Grass) {
            continue;
          }

          // Found grass, move one time up
          const baseY = y + 1;

          const minH = this.params.trees.trunkHeight.min;
          const maxH = this.params.trees.trunkHeight.max;
          const trunkHeight =
            Math.round(this.rng.random() * (maxH - minH)) + minH;
          const topY = baseY + trunkHeight;

          // Fill in blocks for the trunk
          for (let i = baseY; i < topY; i++) {
            this.setBlockId(baseX, i, baseZ, BlockID.OakLog);
          }

          // Generate the canopy
          // generate layer by layer, 4 layers in total
          for (let i = 0; i < 4; i++) {
            if (i === 0) {
              // first layer above the height of tree and has 5 leaves in a + shape
              this.setBlockId(baseX, topY, baseZ, BlockID.Leaves);
              this.setBlockId(baseX + 1, topY, baseZ, BlockID.Leaves);
              this.setBlockId(baseX - 1, topY, baseZ, BlockID.Leaves);
              this.setBlockId(baseX, topY, baseZ + 1, BlockID.Leaves);
              this.setBlockId(baseX, topY, baseZ - 1, BlockID.Leaves);
            } else if (i === 1) {
              // base layer
              this.setBlockId(baseX, topY - i, baseZ, BlockID.Leaves);
              this.setBlockId(baseX + 1, topY - i, baseZ, BlockID.Leaves);
              this.setBlockId(baseX - 1, topY - i, baseZ, BlockID.Leaves);
              this.setBlockId(baseX, topY - i, baseZ + 1, BlockID.Leaves);
              this.setBlockId(baseX, topY - i, baseZ - 1, BlockID.Leaves);

              // diagonal leaf blocks grow min of 1 and max of 3 blocks away from the trunk
              const minR = this.params.trees.canopy.size.min;
              const maxR = this.params.trees.canopy.size.max;
              const R = Math.round(this.rng.random() * (maxR - minR)) + minR;

              // grow leaves in a diagonal shape
              for (let x = -R; x <= R; x++) {
                for (let z = -R; z <= R; z++) {
                  if (x * x + z * z > R * R) {
                    continue;
                  }

                  if (
                    this.getBlock(baseX + x, topY - i, baseZ + z)?.block !==
                    BlockID.Air
                  ) {
                    continue;
                  }

                  if (this.rng.random() > 0.5) {
                    this.setBlockId(
                      baseX + x,
                      topY - i,
                      baseZ + z,
                      BlockID.Leaves
                    );
                  }
                }
              }
            } else if (i === 2 || i == 3) {
              for (let x = -2; x <= 2; x++) {
                for (let z = -2; z <= 2; z++) {
                  if (
                    this.getBlock(baseX + x, topY - i, baseZ + z)?.block !==
                    BlockID.Air
                  ) {
                    continue;
                  }

                  this.setBlockId(
                    baseX + x,
                    topY - i,
                    baseZ + z,
                    BlockID.Leaves
                  );
                }
              }

              // remove 4 corners randomly
              for (const x of [-2, 2]) {
                for (const z of [-2, 2]) {
                  if (this.rng.random() > 0.5) {
                    this.setBlockId(
                      baseX + x,
                      topY - i,
                      baseZ + z,
                      BlockID.Air
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  /**
   * Loads player changes from the data store
   */
  loadPlayerChanges(chunkPos: THREE.Vector3, changes: ChangeRecord[]) {
    for (const { x, y, z, blockId } of changes) {
      // Overwrite with value in data store if it exists
      if (this.inBounds(x, y, z)) {
        this.setBlockId(x, y, z, blockId);
      }
    }
  }

  generateMeshes(): BufferData {
    const positions = [];
    const normals = [];
    const indices = [];
    const uvs = [];

    for (let x = 0; x < this.size.width; x++) {
      for (let y = 0; y < this.size.height; y++) {
        for (let z = 0; z < this.size.width; z++) {
          const block = this.getBlock(x, y, z)?.block;

          if (block == null || block === BlockID.Air) {
            continue;
          }

          if (block && !this.isBlockObscured(x, y, z)) {
            const uvVoxel = block - 1; // voxel 0 is sky so for UVs we start at 0
            for (const { dir, corners, uvRow } of faces) {
              const neighbor = this.getBlock(
                x + dir[0],
                y + dir[1],
                z + dir[2]
              )?.block;

              if (neighbor == null || neighbor === BlockID.Air) {
                const ndx = positions.length / 3;
                for (const { pos, uv } of corners) {
                  positions.push(pos[0] + x, pos[1] + y, pos[2] + z);
                  normals.push(...dir);
                  uvs.push(
                    ((uvVoxel + uv[0]) * this.params.textures.tileSize) /
                      this.params.textures.tileTextureWidth,
                    1 -
                      ((uvRow + 1 - uv[1]) * this.params.textures.tileSize) /
                        this.params.textures.tileTextureHeight
                  );
                }
                indices.push(ndx, ndx + 1, ndx + 2, ndx + 2, ndx + 1, ndx + 3);
              }
            }
          }
        }
      }
    }

    return {
      data: this.data,
      positions: positions,
      normals: normals,
      indices: indices,
      uvs: uvs,
    };
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

  setBlockId(x: number, y: number, z: number, blockId: BlockID) {
    if (this.inBounds(x, y, z)) {
      this.data[x][y][z].block = blockId;
    }
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
}

Comlink.expose(ChunkWorker);

export default ChunkWorker;
