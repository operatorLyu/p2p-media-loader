/**
 * Copyright 2019 Novage LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Segment } from "./loader-interface";
import { SegmentsStorage } from "./hybrid-loader";
/*export interface SegmentsStorage {
    storeSegment: (segment: Segment) => Promise<void>;
    getSegmentsMap: (masterSwarmId: string) => Promise<Map<string, { segment: Segment }>>;
    getSegment: (id: string, masterSwarmId: string) => Promise<Segment | undefined>;
    clean: (masterSwarmId: string, lockedSegmentsFilter?: (id: string) => boolean) => Promise<boolean>;
    destroy: () => Promise<void>;
}*/

export class SegmentsMemoryStorage implements SegmentsStorage {
    private cache = new Map<string, { segment: Segment; lastAccessed: number }>();

    constructor(
        private settings: {
            cachedSegmentExpiration: number;            //cachedSegmentExpiration个时间未被访问就删除掉
            cachedSegmentsCount: number;                //缓存段的个数
        }
    ) {}

    public storeSegment = async (segment: Segment): Promise<void> => {
        this.cache.set(segment.id, { segment, lastAccessed: performance.now() }); // 将缓存段的ID与上次访问时间对应
    };

    public getSegmentsMap = async (): Promise<Map<string, { segment: Segment }>> => {
        return this.cache;                                                        //取出segment的map
    };

    public getSegment = async (id: string): Promise<Segment | undefined> => {
        const cacheItem = this.cache.get(id);

        if (cacheItem === undefined) {
            return undefined;
        }

        cacheItem.lastAccessed = performance.now();             //getSegment根据id寻找与id对应的数据，没有返回undefined
        return cacheItem.segment;                               //存在则更新lastAccessed以及返回这个segment
    };

    public hasSegment = async (id: string): Promise<boolean> => {   //检查是否含有segment
        return this.cache.has(id);
    };

    public clean = async (masterSwarmId: string, lockedSegmentsFilter?: (id: string) => boolean): Promise<boolean> => {
        const segmentsToDelete: string[] = [];
        const remainingSegments: { segment: Segment; lastAccessed: number }[] = [];

        // Delete old segments
        const now = performance.now();

        for (const cachedSegment of this.cache.values()) {
            if (now - cachedSegment.lastAccessed > this.settings.cachedSegmentExpiration) {
                segmentsToDelete.push(cachedSegment.segment.id);
            } else {
                remainingSegments.push(cachedSegment);                      //找到需要删除的segment并放进列表
            }                   
        }

        // Delete segments over cached count
        let countOverhead = remainingSegments.length - this.settings.cachedSegmentsCount;
        if (countOverhead > 0) {
            remainingSegments.sort((a, b) => a.lastAccessed - b.lastAccessed);

            for (const cachedSegment of remainingSegments) {
                if (lockedSegmentsFilter === undefined || !lockedSegmentsFilter(cachedSegment.segment.id)) {
                    segmentsToDelete.push(cachedSegment.segment.id);
                    countOverhead--;
                    if (countOverhead === 0) {
                        break;
                    }
                }
            }
        }                                       //缓存的个数过多也要将上次访问时间过长的放入删除列表

        segmentsToDelete.forEach((id) => this.cache.delete(id));            //删除非法的segment
        return segmentsToDelete.length > 0;
    };

    public destroy = async (): Promise<void> => {               //将所有segment都删除
        this.cache.clear();
    };
}
