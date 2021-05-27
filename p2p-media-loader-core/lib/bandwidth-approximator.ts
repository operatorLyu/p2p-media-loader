/**
 * Copyright 2018 Novage LLC.
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

const SMOOTH_INTERVAL = 15 * 1000;
const MEASURE_INTERVAL = 60 * 1000;

class NumberWithTime {
    constructor(readonly value: number, readonly timeStamp: number) {}
}

export class BandwidthApproximator {
    private lastBytes: NumberWithTime[] = [];               //上次的传输码率    
    private currentBytesSum = 0;                            //总共的传输码率
    private lastBandwidth: NumberWithTime[] = [];           //上次的带宽

    public addBytes = (bytes: number, timeStamp: number): void => {
        this.lastBytes.push(new NumberWithTime(bytes, timeStamp));
        this.currentBytesSum += bytes;

        while (timeStamp - this.lastBytes[0].timeStamp > SMOOTH_INTERVAL) {     //如果间隔时间大于SMOTTH_INTERVAL循环的
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion    //弹出超出间隔的对象
            this.currentBytesSum -= this.lastBytes.shift()!.value;              //总码率减去弹出的码率
        }

        const interval = Math.min(SMOOTH_INTERVAL, timeStamp);              //定义一个间隔
        this.lastBandwidth.push(new NumberWithTime(this.currentBytesSum / interval, timeStamp));    //根据间隔以及总码率
    };                                                                //求出上一时刻的估计带宽

    // in bytes per millisecond
    public getBandwidth = (timeStamp: number): number => {
        while (this.lastBandwidth.length !== 0 && timeStamp - this.lastBandwidth[0].timeStamp > MEASURE_INTERVAL) {
            this.lastBandwidth.shift();
        }

        let maxBandwidth = 0;
        for (const bandwidth of this.lastBandwidth) {
            if (bandwidth.value > maxBandwidth) {
                maxBandwidth = bandwidth.value;                 //返回一段时间的最大带宽
            }
        }

        return maxBandwidth;
    };

    public getSmoothInterval = (): number => {
        return SMOOTH_INTERVAL;
    };

    public getMeasureInterval = (): number => {
        return MEASURE_INTERVAL;
    };
}
