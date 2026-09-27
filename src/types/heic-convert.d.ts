declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: Buffer | Uint8Array | ArrayBuffer;
    format: 'JPEG' | 'PNG';
    /** 0–1, JPEG only. */
    quality?: number;
  }
  function convert(options: ConvertOptions): Promise<ArrayBuffer>;
  export default convert;
}
