/**
 * @license Apache-2.0
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

/* eslint-disable */

export const version = "0.6.2";
export * from "./engine";
export * from "./segment-manager";

import { Engine } from "./engine";

declare const videojs: any;

declare global {
    interface Window {
        p2pml: Record<string, unknown>;
    }
}

export function initHlsJsPlayer(player: any): void {
    if (player && player.config && player.config.loader && typeof player.config.loader.getEngine === "function") {
        initHlsJsEvents(player, player.config.loader.getEngine());
    }
}                   //初始化一个hls的播放器

export function initClapprPlayer(player: any): void {
    player.on("play", () => {
        const playback = player.core.getCurrentPlayback();
        if (playback._hls && !playback._hls._p2pm_linitialized) {
            playback._hls._p2pm_linitialized = true;
            initHlsJsPlayer(player.core.getCurrentPlayback()._hls);
        }
    });
}

export function initFlowplayerHlsJsPlayer(player: any): void {
    player.on("ready", () => initHlsJsPlayer(player.engine.hlsjs ?? player.engine.hls));
}

export function initVideoJsContribHlsJsPlayer(player: any): void {
    player.ready(() => {
        const options = player.tech_.options_;
        if (
            options &&
            options.hlsjsConfig &&
            options.hlsjsConfig.loader &&
            typeof options.hlsjsConfig.loader.getEngine === "function"
        ) {
            initHlsJsEvents(player.tech_, options.hlsjsConfig.loader.getEngine());
        }
    });
}                   //上面所有的都是初始化播放器

export function initVideoJsHlsJsPlugin(): void {                //初始化视频插件
    if (videojs == undefined || videojs.Html5Hlsjs == undefined) {
        return;
    }
                        //初始化播放器之前初始化一下视频配置
    videojs.Html5Hlsjs.addHook("beforeinitialize", (videojsPlayer: any, hlsjs: any) => {
        if (hlsjs.config && hlsjs.config.loader && typeof hlsjs.config.loader.getEngine === "function") {
            initHlsJsEvents(hlsjs, hlsjs.config.loader.getEngine());        //如果存在配置 loader以及getEngine
        }
    });
}

export function initMediaElementJsPlayer(mediaElement: any): void {
    mediaElement.addEventListener("hlsFragChanged", (event: any) => {
        const hls = mediaElement.hlsPlayer;
        if (hls && hls.config && hls.config.loader && typeof hls.config.loader.getEngine === "function") {
            const engine: Engine = hls.config.loader.getEngine();

            if (event.data && event.data.length > 1) {
                const frag = event.data[1].frag;
                const byteRange =
                    frag.byteRange.length !== 2
                        ? undefined
                        : { offset: frag.byteRange[0], length: frag.byteRange[1] - frag.byteRange[0] };
                engine.setPlayingSegment(frag.url, byteRange, frag.start, frag.duration);
            }
        }
    });
    mediaElement.addEventListener("hlsDestroying", async () => {
        const hls = mediaElement.hlsPlayer;
        if (hls && hls.config && hls.config.loader && typeof hls.config.loader.getEngine === "function") {
            const engine: Engine = hls.config.loader.getEngine();
            await engine.destroy();
        }
    });
    mediaElement.addEventListener("hlsError", (event: any) => {
        const hls = mediaElement.hlsPlayer;
        if (hls && hls.config && hls.config.loader && typeof hls.config.loader.getEngine === "function") {
            if (event.data !== undefined && event.data.details === "bufferStalledError") {
                const engine: Engine = hls.config.loader.getEngine();
                engine.setPlayingSegmentByCurrentTime(hls.media.currentTime);
            }
        }
    });
}

export function initJwPlayer(player: any, hlsjsConfig: any): void {     //初始化Jw播放器
    const iid = setInterval(() => {
        if (player.hls && player.hls.config) {
            clearInterval(iid);
            Object.assign(player.hls.config, hlsjsConfig);
            initHlsJsPlayer(player.hls);
        }
    }, 200);
}

function initHlsJsEvents(player: any, engine: Engine): void {           //根据不同情况初始化各种事件
    player.on("hlsFragChanged", (_event: string, data: any) => {        //包括删除hls，hls报错，hlsFrag发生改变三种情况
        const frag = data.frag;
        const byteRange =
            frag.byteRange.length !== 2
                ? undefined
                : { offset: frag.byteRange[0], length: frag.byteRange[1] - frag.byteRange[0] };
        engine.setPlayingSegment(frag.url, byteRange, frag.start, frag.duration);
    });
    player.on("hlsDestroying", async () => {
        await engine.destroy();
    });
    player.on("hlsError", (_event: string, errorData: { details: string }) => {
        if (errorData.details === "bufferStalledError") {
            const htmlMediaElement = (player.media === undefined
                ? player.el_ // videojs-contrib-hlsjs
                : player.media) as HTMLMediaElement | undefined; // all others
            if (htmlMediaElement) {
                engine.setPlayingSegmentByCurrentTime(htmlMediaElement.currentTime);
            }
        }
    });
}
