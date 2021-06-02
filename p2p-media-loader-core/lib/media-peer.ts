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

/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
//主要定义了各种命令，根据命令执行操作，比如取消segment请求，
import Debug from "debug";
import { Buffer } from "buffer";

import { STEEmitter } from "./stringly-typed-event-emitter";

enum MediaPeerCommands {
    SegmentData,
    SegmentAbsent,
    SegmentsMap,
    SegmentRequest,
    CancelSegmentRequest,
}                           //meidia_peer命令

type MediaPeerCommand =             //可能是以下三个花括号中的一个
    | {
          c:
              | MediaPeerCommands.SegmentAbsent
              | MediaPeerCommands.SegmentRequest
              | MediaPeerCommands.CancelSegmentRequest;             //c可能是三个命令中的一个
          i: string;
      }
    | {
          c: MediaPeerCommands.SegmentsMap;
          m: { [key: string]: [string, number[]] };
      }
    | {
          c: MediaPeerCommands.SegmentData;
          i: string;
          s: number;
          src: string;
      };

export enum MediaPeerSegmentStatus {                    //定义下载的状态
    Loaded,
    LoadingByHttp,
}

class DownloadingSegment {                              //下载的segment信息
    public bytesDownloaded = 0;
    public pieces: ArrayBuffer[] = [];
    constructor(readonly id: string, readonly size: number) {}
}

export class MediaPeer extends STEEmitter<              //根据STEEmitter拓展定义MediaPeer
    | "connect"
    | "close"
    | "data-updated"
    | "segment-request"
    | "segment-absent"
    | "segment-loaded"
    | "segment-error"
    | "segment-timeout"
    | "bytes-downloaded"
    | "bytes-uploaded"
> {
    public id: string;
    public remoteAddress = "";                                      //名字基本就是变量的意思
    private downloadingSegmentId: string | null = null;
    private downloadingSegment: DownloadingSegment | null = null;
    private segmentsMap = new Map<string, MediaPeerSegmentStatus>();
    private debug = Debug("p2pml:media-peer");
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        // eslint-disable-next-line
        readonly peer: any,                                 
        readonly settings: {
            p2pSegmentDownloadTimeout: number;
            webRtcMaxMessageSize: number;
        }
    ) {
        super();
        // this.peer is trackerPeer in p2p media manager, come from torrent server
        this.peer.on("connect", this.onPeerConnect);
        this.peer.on("close", this.onPeerClose);
        this.peer.on("error", this.onPeerError);
        this.peer.on("data", this.onPeerData);

        this.id = peer.id;
    }

    private onPeerConnect = () => {
        this.debug("peer connect", this.id, this);
        this.remoteAddress = this.peer.remoteAddress;
        this.emit("connect", this); //"connect" emited to call onPeerConnect, onPeerConnect emit connect?????  --->  this emit the connect in p2p-media-manager
    };

    private onPeerClose = () => {
        this.debug("peer close", this.id, this);
        this.terminateSegmentRequest();
        this.emit("close", this);
    };

    private onPeerError = (error: unknown) => {
        this.debug("peer error", this.id, error, this);
    };

    private receiveSegmentPiece = (data: ArrayBuffer): void => {                //接受segmentpiece
        if (!this.downloadingSegment) {
            // The segment was not requested or canceled
            this.debug("peer segment not requested", this.id, this);            //如果不是请求的段打印信息并直接返回
            return;
        }

        this.downloadingSegment.bytesDownloaded += data.byteLength;
        this.downloadingSegment.pieces.push(data);                          //要下载的块压入列表
        this.emit("bytes-downloaded", this, data.byteLength);

        const segmentId = this.downloadingSegment.id;

        if (this.downloadingSegment.bytesDownloaded === this.downloadingSegment.size) {
            const segmentData = new Uint8Array(this.downloadingSegment.size);
            let offset = 0;
            for (const piece of this.downloadingSegment.pieces) {
                segmentData.set(new Uint8Array(piece), offset);
                offset += piece.byteLength;
            }

            this.debug("peer segment download done", this.id, segmentId, this);
            this.terminateSegmentRequest();                                                         //成功下载
            this.emit("segment-loaded", this, segmentId, segmentData.buffer);
        } else if (this.downloadingSegment.bytesDownloaded > this.downloadingSegment.size) {
            this.debug("peer segment download bytes mismatch", this.id, segmentId, this);           //字节不匹配触发
            this.terminateSegmentRequest();                                                         //错误时间
            this.emit("segment-error", this, segmentId, "Too many bytes received for segment");
        }
    };

    private getJsonCommand = (data: ArrayBuffer) => {                   //获得json命令
        const bytes = new Uint8Array(data);

        // Serialized JSON string check by first, second and last characters: '{" .... }'
        if (bytes[0] === 123 && bytes[1] === 34 && bytes[data.byteLength - 1] === 125) {
            try {
                return JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
            } catch {
                return null;
            }
        }

        return null;
    };

    private onPeerData = (data: ArrayBuffer) => {
        const command = this.getJsonCommand(data);

        if (command === null) {                                 //检查上一个命令为空接受segmentpiece
            this.receiveSegmentPiece(data);
            return;
        }

        if (this.downloadingSegment) {                       //不为空检查正在下载的片段是真的话打印下载被打断
            this.debug("peer segment download is interrupted by a command", this.id, this);

            const segmentId = this.downloadingSegment.id;
            this.terminateSegmentRequest();                 //终止下载并报错打印信息
            this.emit("segment-error", this, segmentId, "Segment download is interrupted by a command");
            return;
        }

        this.debug("peer receive command", this.id, command, this); //不为空说明收到了新的命令，根据命令进行switch操作

        switch (command.c) {                                                
            case MediaPeerCommands.SegmentsMap:
                this.segmentsMap = this.createSegmentsMap(command.m);
                this.emit("data-updated");                      //更新数据信息
                break;

            case MediaPeerCommands.SegmentRequest:                  //发送请求段
                this.emit("segment-request", this, command.i);
                break;

            case MediaPeerCommands.SegmentData:
                this.downloadingSegmentId = command.i as string; //added by liuxi
                if (
                    this.downloadingSegmentId &&
                    this.downloadingSegmentId === command.i &&
                    typeof command.s === "number" &&
                    command.s >= 0
                ) {
                    this.downloadingSegment = new DownloadingSegment(command.i, command.s);
                    this.cancelResponseTimeoutTimer();
                }
                console.log("MediaPeer id: "+this.id+" start to receive Seg: "+command.i);
                break;

            case MediaPeerCommands.SegmentAbsent:
                if (this.downloadingSegmentId && this.downloadingSegmentId === command.i) {
                    this.terminateSegmentRequest();
                    this.segmentsMap.delete(command.i);
                    this.emit("segment-absent", this, command.i);
                }
                break;

            case MediaPeerCommands.CancelSegmentRequest:
                // TODO: peer stop sending buffer
                break;

            default:
                break;
        }
    };

    private createSegmentsMap = (segments: unknown) => {
        if (!(segments instanceof Object)) {                // instanceof是接口的类型判断                 
            return new Map<string, MediaPeerSegmentStatus>();
        }

        const segmentsMap = new Map<string, MediaPeerSegmentStatus>();

        for (const streamSwarmId of Object.keys(segments)) {
            const swarmData = (segments as Record<string, unknown>)[streamSwarmId];  //as断言的意思，让程序确定它是什么类型       
            if (
                !(swarmData instanceof Array) ||
                swarmData.length !== 2 ||
                typeof swarmData[0] !== "string" ||
                !(swarmData[1] instanceof Array)
            ) {
                return new Map<string, MediaPeerSegmentStatus>();// 不合法返回一个新的segmentMap
            }

            const segmentsIds = swarmData[0].split("|");
            const segmentsStatuses = swarmData[1] as  [];

            if (segmentsIds.length !== segmentsStatuses.length) {
                return new Map<string, MediaPeerSegmentStatus>();   //不合法返回新的segmentMap
            }

            for (let i = 0; i < segmentsIds.length; i++) {
                const segmentStatus = segmentsStatuses[i];
                if (typeof segmentStatus !== "number" || MediaPeerSegmentStatus[segmentStatus] === undefined) {
                    return new Map<string, MediaPeerSegmentStatus>();
                }

                segmentsMap.set(`${streamSwarmId}+${segmentsIds[i]}`, segmentStatus);
            }
        }

        return segmentsMap;
    };

    private sendCommand = (command: MediaPeerCommand): void => {
        this.debug("peer send command", this.id, command, this);
        
        this.peer.write(JSON.stringify(command));
    };

    public destroy = (): void => {
        this.debug("peer destroy", this.id, this);
        this.terminateSegmentRequest();
        this.peer.destroy();
    };

    public getDownloadingSegmentId = (): string | null => {             //获得正在下载segment的ID
        return this.downloadingSegmentId;
    };

    public getSegmentsMap = (): Map<string, MediaPeerSegmentStatus> => {//获得正在segmentsMap
        return this.segmentsMap;
    };

    public sendSegmentsMap = (segmentsMap: { [key: string]: [string, number[]] }): void => {
        this.sendCommand({ c: MediaPeerCommands.SegmentsMap, m: segmentsMap });     //发送segments Map
    };

    public sendSegmentData = (segmentId: string, data: ArrayBuffer): void => {
        this.sendCommand({                                          //发送segment的数据
            c: MediaPeerCommands.SegmentData,
            i: segmentId,
            s: data.byteLength,
            src: this.id,
        });
        console.log("MediaPeer id: "+this.id+" segmentId: "+segmentId+" byteLen: "+data.byteLength);
        let bytesLeft = data.byteLength;
        while (bytesLeft > 0) {
            const bytesToSend =
                bytesLeft >= this.settings.webRtcMaxMessageSize ? this.settings.webRtcMaxMessageSize : bytesLeft;
            const buffer = Buffer.from(data, data.byteLength - bytesLeft, bytesToSend);

            this.peer.write(buffer);
            bytesLeft -= bytesToSend;
        }

        this.emit("bytes-uploaded", this, data.byteLength);             //传给其它节点数据
    };

    public sendSegmentAbsent = (segmentId: string): void => {
        this.sendCommand({ c: MediaPeerCommands.SegmentAbsent, i: segmentId });
    };

    public requestSegment = (segmentId: string): void => {
        if (this.downloadingSegmentId) {
            throw new Error("A segment is already downloading: " + this.downloadingSegmentId);
        }

        this.sendCommand({ c: MediaPeerCommands.SegmentRequest, i: segmentId });
        this.downloadingSegmentId = segmentId;
        this.runResponseTimeoutTimer();
    };

    public cancelSegmentRequest = (): ArrayBuffer[] | undefined => {
        let downloadingSegment: ArrayBuffer[] | undefined;

        if (this.downloadingSegmentId) {
            const segmentId = this.downloadingSegmentId;
            downloadingSegment = this.downloadingSegment ? this.downloadingSegment.pieces : undefined;
            this.terminateSegmentRequest();
            this.sendCommand({ c: MediaPeerCommands.CancelSegmentRequest, i: segmentId });
        }

        return downloadingSegment;
    };

    private runResponseTimeoutTimer = (): void => {
        this.timer = setTimeout(() => {
            this.timer = null;
            if (!this.downloadingSegmentId) {
                return;
            }
            const segmentId = this.downloadingSegmentId;
            this.cancelSegmentRequest();
            this.emit("segment-timeout", this, segmentId); // TODO: send peer not responding event
        }, this.settings.p2pSegmentDownloadTimeout);
    };

    private cancelResponseTimeoutTimer = (): void => {                  //取消超时计时器
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    };

    private terminateSegmentRequest = () => {
        this.downloadingSegmentId = null;
        this.downloadingSegment = null;
        this.cancelResponseTimeoutTimer();
    };
}
