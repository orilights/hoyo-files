/* tslint:disable */
/* eslint-disable */

export class UsmStreamDecoder {
    free(): void;
    [Symbol.dispose](): void;
    finish(): any;
    constructor(key_hex: string);
    push(data: Uint8Array): any;
    reset(ivf_header: Uint8Array, channels: Array<any>, base_offset: bigint): void;
}
export function decode_hca(channels_data: Array<any>, key_hex: string): Uint8Array;
export function decode_usm(data: Uint8Array, key_hex: string): any;
export function decode_usm_to_mkv(data: Uint8Array, key_hex: string, ch_index?: number | null): Uint8Array;
export function init(): void;
export function mux_ivf_flac_to_mkv(ivf: Uint8Array, tracks: Array<any>): Uint8Array;
export function prepare_usm_mkv(data: Uint8Array, key_hex: string, ch_index?: number | null): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_usmstreamdecoder_free: (a: number, b: number) => void;
    readonly decode_hca: (a: any, b: number, c: number) => [number, number, number];
    readonly decode_usm: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly decode_usm_to_mkv: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly init: () => void;
    readonly mux_ivf_flac_to_mkv: (a: number, b: number, c: any) => [number, number, number];
    readonly prepare_usm_mkv: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly usmstreamdecoder_finish: (a: number) => [number, number, number];
    readonly usmstreamdecoder_new: (a: number, b: number) => [number, number, number];
    readonly usmstreamdecoder_push: (a: number, b: number, c: number) => [number, number, number];
    readonly usmstreamdecoder_reset: (a: number, b: number, c: number, d: any, e: bigint) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
