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

/* eslint-disable @typescript-eslint/no-explicit-any */

import { EventEmitter } from "events";                  //字符串类型的事件触发器

export class STEEmitter<T extends string | symbol> extends EventEmitter {
    public on = (event: T, listener: (...args: any[]) => void): this => super.on(event, listener);  //注册事件（字符串）和监听器
    public emit = (event: T, ...args: any[]): boolean => super.emit(event, ...args);    //发出事件触发信号
}
