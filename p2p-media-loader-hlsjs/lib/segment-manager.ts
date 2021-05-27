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

import { Events, Segment, LoaderInterface, XhrSetupCallback } from "p2p-media-loader-core";
import { Manifest, Parser } from "m3u8-parser";
import { AssetsStorage } from "./engine";

const defaultSettings: SegmentManagerSettings = {
    forwardSegmentCount: 20,
    swarmId: undefined,
    assetsStorage: undefined,
};

export type ByteRange = { length: number; offset: number } | undefined;

export class SegmentManager {
    private readonly loader: LoaderInterface;
    private masterPlaylist: Playlist | null = null;
    private readonly variantPlaylists = new Map<string, Playlist>();
    private segmentRequest: SegmentRequest | null = null;
    private playQueue: {
        segmentSequence: number;
        segmentUrl: string;
        segmentByteRange: ByteRange;
        playPosition?: {
            start: number;
            duration: number;
        };
    }[] = [];
    private readonly settings: SegmentManagerSettings;

    public constructor(loader: LoaderInterface, settings: Partial<SegmentManagerSettings> = {}) {
        this.settings = { ...defaultSettings, ...settings };        //settings启用默认配置
                                                                    //构造函数初始化类，一般采用默认配置
        this.loader = loader;
        this.loader.on(Events.SegmentLoaded, this.onSegmentLoaded);
        this.loader.on(Events.SegmentError, this.onSegmentError);
        this.loader.on(Events.SegmentAbort, this.onSegmentAbort);
    }

    public getSettings(): SegmentManagerSettings {          //获取当前配置
        return this.settings;
    }

    public processPlaylist(requestUrl: string, content: string, responseUrl: string): void {
        const parser = new Parser();
        parser.push(content);
        parser.end();

        const playlist = new Playlist(requestUrl, responseUrl, parser.manifest);

        if (playlist.manifest.playlists) {        //如果播放列表显示有正在显示的话 
            this.masterPlaylist = playlist;     //主播放器列表为现在的播放器列表

            for (const [key, variantPlaylist] of this.variantPlaylists) {
                const { streamSwarmId, found, index } = this.getStreamSwarmId(variantPlaylist.requestUrl);
                if (!found) {
                    this.variantPlaylists.delete(key);
                } else {
                    variantPlaylist.streamSwarmId = streamSwarmId;
                    variantPlaylist.streamId = "V" + index.toString();
                }
            }
        } else {
            const { streamSwarmId, found, index } = this.getStreamSwarmId(requestUrl);

            if (found || this.masterPlaylist === null) {
                // do not add audio and subtitles to variants
                playlist.streamSwarmId = streamSwarmId;
                playlist.streamId = this.masterPlaylist === null ? undefined : "V" + index.toString();
                this.variantPlaylists.set(requestUrl, playlist);
                this.updateSegments();
            }
        }
    }

    public async loadPlaylist(url: string): Promise<{ response: string; responseURL: string }> {
        const assetsStorage = this.settings.assetsStorage;
        let xhr: { response: string; responseURL: string } | undefined;

        if (assetsStorage !== undefined) {
            let masterSwarmId: string | undefined;
            masterSwarmId = this.getMasterSwarmId();
            if (masterSwarmId === undefined) {
                masterSwarmId = url.split("?")[0];
            }
            const asset = await assetsStorage.getAsset(url, undefined, masterSwarmId);

            if (asset !== undefined) {
                xhr = {
                    responseURL: asset.responseUri,
                    response: asset.data as string,
                };
            } else {
                xhr = await this.loadContent(url, "text");
                void assetsStorage.storeAsset({
                    masterManifestUri: this.masterPlaylist !== null ? this.masterPlaylist.requestUrl : url,
                    masterSwarmId: masterSwarmId,
                    requestUri: url,
                    responseUri: xhr.responseURL,
                    data: xhr.response,
                });
            }
        } else {
            xhr = await this.loadContent(url, "text");
        }

        this.processPlaylist(url, xhr.response, xhr.responseURL);
        return xhr;
    }

    public async loadSegment(
        url: string,
        byteRange: ByteRange
    ): Promise<{ content: ArrayBuffer | undefined; downloadBandwidth?: number }> {
        const segmentLocation = this.getSegmentLocation(url, byteRange);
        const byteRangeString = byteRangeToString(byteRange);

        if (!segmentLocation) {
            let content: ArrayBuffer | undefined;

            // Not a segment from variants; usually can be: init, audio or subtitles segment, encription key etc.
            const assetsStorage = this.settings.assetsStorage;
            if (assetsStorage !== undefined) {
                let masterManifestUri = this.masterPlaylist?.requestUrl;

                let masterSwarmId: string | undefined;
                masterSwarmId = this.getMasterSwarmId();

                if (masterSwarmId === undefined && this.variantPlaylists.size === 1) {
                    const result = this.variantPlaylists.values().next();
                    if (!result.done) {
                        // always true
                        masterSwarmId = result.value.requestUrl.split("?")[0];
                    }
                }

                if (masterManifestUri === undefined && this.variantPlaylists.size === 1) {
                    const result = this.variantPlaylists.values().next();
                    if (!result.done) {
                        // always true
                        masterManifestUri = result.value.requestUrl;
                    }
                }

                if (masterSwarmId !== undefined && masterManifestUri !== undefined) {
                    const asset = await assetsStorage.getAsset(url, byteRangeString, masterSwarmId);
                    if (asset !== undefined) {
                        content = asset.data as ArrayBuffer;
                    } else {
                        const xhr = await this.loadContent(url, "arraybuffer", byteRangeString);
                        content = xhr.response as ArrayBuffer;
                        void assetsStorage.storeAsset({
                            masterManifestUri: masterManifestUri,
                            masterSwarmId: masterSwarmId,
                            requestUri: url,
                            requestRange: byteRangeString,
                            responseUri: xhr.responseURL,
                            data: content,
                        });
                    }
                }
            }

            if (content === undefined) {
                const xhr = await this.loadContent(url, "arraybuffer", byteRangeString);
                content = xhr.response as ArrayBuffer;
            }

            return { content, downloadBandwidth: 0 };
        }

        const segmentSequence =
            (segmentLocation.playlist.manifest.mediaSequence ? segmentLocation.playlist.manifest.mediaSequence : 0) +
            segmentLocation.segmentIndex;

        if (this.playQueue.length > 0) {
            const previousSegment = this.playQueue[this.playQueue.length - 1];
            if (previousSegment.segmentSequence !== segmentSequence - 1) {
                // Reset play queue in case of segment loading out of sequence
                this.playQueue = [];
            }
        }

        if (this.segmentRequest) {
            this.segmentRequest.onError("Cancel segment request: simultaneous segment requests are not supported");
        }

        const promise = new Promise<{ content: ArrayBuffer | undefined; downloadBandwidth?: number }>(
            (resolve, reject) => {
                this.segmentRequest = new SegmentRequest(
                    url,
                    byteRange,
                    segmentSequence,
                    segmentLocation.playlist.requestUrl,
                    (content: ArrayBuffer | undefined, downloadBandwidth?: number) =>
                        resolve({ content, downloadBandwidth }),
                    (error) => reject(error)
                );
            }
        );

        this.playQueue.push({ segmentUrl: url, segmentByteRange: byteRange, segmentSequence: segmentSequence });
        void this.loadSegments(segmentLocation.playlist, segmentLocation.segmentIndex, true);

        return promise;
    }//load segment

    public setPlayingSegment(url: string, byteRange: ByteRange, start: number, duration: number): void {
        const urlIndex = this.playQueue.findIndex(
            (segment) => segment.segmentUrl === url && compareByteRanges(segment.segmentByteRange, byteRange)
        );

        if (urlIndex >= 0) {
            this.playQueue = this.playQueue.slice(urlIndex);
            this.playQueue[0].playPosition = { start, duration };
            this.updateSegments();
        }
    }               //设置引擎要播放的片段

    public setPlayingSegmentByCurrentTime(playheadPosition: number): void {
        if (this.playQueue.length === 0 || !this.playQueue[0].playPosition) {
            return;
        }

        const currentSegmentPosition = this.playQueue[0].playPosition;
        const segmentEndTime = currentSegmentPosition.start + currentSegmentPosition.duration;

        if (segmentEndTime - playheadPosition < 0.2) {
            // means that current segment is (almost) finished playing
            // remove it from queue

            this.playQueue = this.playQueue.slice(1);
            this.updateSegments();
        }
    }//通过给定播放头位置通知引擎当前播放片段。

    public abortSegment(url: string, byteRange: ByteRange): void {
        if (
            this.segmentRequest &&
            this.segmentRequest.segmentUrl === url &&
            compareByteRanges(this.segmentRequest.segmentByteRange, byteRange)
        ) {
            this.segmentRequest.onSuccess(undefined, 0);
            this.segmentRequest = null;
        }
    }//如果符合条件就将segment终止掉

    public async destroy(): Promise<void> {
        if (this.segmentRequest) {
            this.segmentRequest.onError("Loading aborted: object destroyed");
            this.segmentRequest = null;
        }

        this.masterPlaylist = null;
        this.variantPlaylists.clear();
        this.playQueue = [];

        if (this.settings.assetsStorage !== undefined) {
            await this.settings.assetsStorage.destroy();
        }

        await this.loader.destroy();
    }//破坏播放引擎；销毁加载程序和段管理器。

    private updateSegments(): void {
        if (!this.segmentRequest) {
            return;
        }

        const segmentLocation = this.getSegmentLocation(
            this.segmentRequest.segmentUrl,
            this.segmentRequest.segmentByteRange
        );
        if (segmentLocation) {
            void this.loadSegments(segmentLocation.playlist, segmentLocation.segmentIndex, false);
        }
    }//更新segment，如果有segment正在load也一并更新

    private onSegmentLoaded = (segment: Segment) => {
        if (
            this.segmentRequest &&
            this.segmentRequest.segmentUrl === segment.url &&
            byteRangeToString(this.segmentRequest.segmentByteRange) === segment.range
        ) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this.segmentRequest.onSuccess(segment.data!.slice(0), segment.downloadBandwidth);
            this.segmentRequest = null;
        }
    };//带有on的都是出发之前所注册的事件

    private onSegmentError = (segment: Segment, error: unknown) => {
        if (
            this.segmentRequest &&
            this.segmentRequest.segmentUrl === segment.url &&
            byteRangeToString(this.segmentRequest.segmentByteRange) === segment.range
        ) {
            this.segmentRequest.onError(error);
            this.segmentRequest = null;
        }
    };//触发segment error事件

    private onSegmentAbort = (segment: Segment) => {
        if (
            this.segmentRequest &&
            this.segmentRequest.segmentUrl === segment.url &&
            byteRangeToString(this.segmentRequest.segmentByteRange) === segment.range
        ) {
            this.segmentRequest.onError("Loading aborted: internal abort");
            this.segmentRequest = null;
        }
    };//终止segment请求

    private getSegmentLocation(
        url: string,
        byteRange: ByteRange
    ): { playlist: Playlist; segmentIndex: number } | undefined {
        for (const playlist of this.variantPlaylists.values()) {
            const segmentIndex = playlist.getSegmentIndex(url, byteRange);
            if (segmentIndex >= 0) {
                return { playlist: playlist, segmentIndex: segmentIndex };
            }
        }

        return undefined;
    }//找到segment所在位置

    private async loadSegments(playlist: Playlist, segmentIndex: number, requestFirstSegment: boolean) {
        const segments: Segment[] = [];
        const playlistSegments = playlist.manifest.segments;
        const initialSequence = playlist.manifest.mediaSequence ?? 0;
        let loadSegmentId: string | null = null;

        let priority = Math.max(0, this.playQueue.length - 1);

        const masterSwarmId = this.getMasterSwarmId();

        for (
            let i = segmentIndex;
            i < playlistSegments.length && segments.length < this.settings.forwardSegmentCount;
            ++i
        ) {
            const segment = playlist.manifest.segments[i];

            const url = playlist.getSegmentAbsoluteUrl(segment.uri);
            const byteRange: ByteRange = segment.byteRange;
            const id = this.getSegmentId(playlist, initialSequence + i);
            segments.push({
                id: id,
                url: url,
                masterSwarmId: masterSwarmId !== undefined ? masterSwarmId : playlist.streamSwarmId,
                masterManifestUri: this.masterPlaylist !== null ? this.masterPlaylist.requestUrl : playlist.requestUrl,
                streamId: playlist.streamId,
                sequence: (initialSequence + i).toString(),
                range: byteRangeToString(byteRange),
                priority: priority++,
            });
            if (requestFirstSegment && !loadSegmentId) {
                loadSegmentId = id;
            }
        }

        this.loader.load(segments, playlist.streamSwarmId);

        if (loadSegmentId) {
            const segment = await this.loader.getSegment(loadSegmentId);
            if (segment) {
                // Segment already loaded by loader
                this.onSegmentLoaded(segment);
            }
        }
    }   //加载segments

    private getSegmentId(playlist: Playlist, segmentSequence: number): string {
        return `${playlist.streamSwarmId}+${segmentSequence}`;
    }   //得到segment的ID

    private getMasterSwarmId() {            //得到播放器的集群ID
        const settingsSwarmId =
            this.settings.swarmId && this.settings.swarmId.length !== 0 ? this.settings.swarmId : undefined;
        if (settingsSwarmId !== undefined) {
            return settingsSwarmId;
        }

        return this.masterPlaylist !== null ? this.masterPlaylist.requestUrl.split("?")[0] : undefined;
    }

    private getStreamSwarmId(playlistUrl: string): { streamSwarmId: string; found: boolean; index: number } {
        const masterSwarmId = this.getMasterSwarmId();

        if (this.masterPlaylist && this.masterPlaylist.manifest.playlists && masterSwarmId) {
            for (let i = 0; i < this.masterPlaylist.manifest.playlists.length; ++i) {
                const url = new URL(
                    this.masterPlaylist.manifest.playlists[i].uri,
                    this.masterPlaylist.responseUrl
                ).toString();
                if (url === playlistUrl) {
                    return { streamSwarmId: `${masterSwarmId}+V${i}`, found: true, index: i };
                }
            }
        }

        return {
            streamSwarmId: masterSwarmId ?? playlistUrl.split("?")[0],
            found: false,
            index: -1,
        };
    }//根据传进来的playlistUrl来判断是否能够得到streamswarmid，如果可以就返回详细信息，不可以就返回false,-1,以及playlisturl的
    //swarmID
    private async loadContent(
        url: string,
        responseType: XMLHttpRequestResponseType,
        range?: string
    ): Promise<XMLHttpRequest> {
        return new Promise<XMLHttpRequest>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.responseType = responseType;

            if (range) {
                xhr.setRequestHeader("Range", range);
            }

            xhr.addEventListener("readystatechange", () => {
                if (xhr.readyState !== 4) return;
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr);
                } else {
                    reject(xhr.statusText);
                }
            });

            const xhrSetup = (this.loader.getSettings() as { xhrSetup?: XhrSetupCallback }).xhrSetup;
            if (xhrSetup) {
                xhrSetup(xhr, url);
            }

            xhr.send();
        });
    }
}

class Playlist {
    public streamSwarmId = "";
    public streamId?: string;
            //需要的url，需要回应的url，需要显示的
    public constructor(readonly requestUrl: string, readonly responseUrl: string, readonly manifest: Manifest) {}

    public getSegmentIndex(url: string, byteRange: ByteRange): number { //获得segment的索引
        for (let i = 0; i < this.manifest.segments.length; ++i) {
            const segment = this.manifest.segments[i];
            const segmentUrl = this.getSegmentAbsoluteUrl(segment.uri);
                            //需要的url相同以及字节比较相等，就返回segment的索引
            if (url === segmentUrl && compareByteRanges(segment.byteRange, byteRange)) {
                return i;
            }
        }
                //没有找到就返回-1索引
        return -1;
    }

    public getSegmentAbsoluteUrl(segmentUrl: string): string {          //获取完整的URL
        return new URL(segmentUrl, this.responseUrl).toString();
    }
}//播放的列表

class SegmentRequest {
    public constructor(
        readonly segmentUrl: string,
        readonly segmentByteRange: ByteRange,
        readonly segmentSequence: number,
        readonly playlistRequestUrl: string,        //下载成功的话显示下载的内容，下载的带宽
        readonly onSuccess: (content: ArrayBuffer | undefined, downloadBandwidth: number | undefined) => void,
        readonly onError: (error: unknown) => void  //下载失败的话抛出error
    ) {}
}//请求的segment

export interface SegmentManagerSettings {   //段管理器设置
    /**
     * Number of segments for building up predicted forward segments sequence; used to predownload and share via P2P
     * 用于建立预测前向分段序列的分段数；用于通过P2P预下载和共享
     */
    forwardSegmentCount: number;

    /**
     * Override default swarm ID that is used to identify unique media stream with trackers (manifest URL without
     * query parameters is used as the swarm ID if the parameter is not specified)
     * 重写用于使用跟踪器标识唯一媒体流的默认swarm ID（如果未指定参数，则使用不带查询参数的清单URL作为swarm ID）
     */
    swarmId?: string;

    /**
     * 下载资产的存储：清单、字幕、init段、DRM资产等。默认情况下，这些资产不会存储。
     * A storage for the downloaded assets: manifests, subtitles, init segments, DRM assets etc. By default the assets are not stored.
     */
    assetsStorage?: AssetsStorage;
}

function compareByteRanges(b1: ByteRange, b2: ByteRange) {  //比较字节范围
    return b1 === undefined ? b2 === undefined : b2 !== undefined && b1.length === b2.length && b1.offset === b2.offset;
}

function byteRangeToString(byteRange: ByteRange): string | undefined {
    if (byteRange === undefined) {
        return undefined;
    }

    const end = byteRange.offset + byteRange.length - 1;

    return `bytes=${byteRange.offset}-${end}`;
}//字节范围转成string串
