// Downsamples mic audio to 16 kHz mono PCM16 and posts ~50 ms chunks to the main thread.
class PcmWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetRate ?? 16000;
    this.ratio = sampleRate / this.targetRate;
    this.buffer = [];
    this.chunkSize = Math.round(this.targetRate * 0.05);
    this.pos = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    while (this.pos < input.length) {
      const s = Math.max(-1, Math.min(1, input[Math.floor(this.pos)]));
      this.buffer.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    while (this.buffer.length >= this.chunkSize) {
      const chunk = Int16Array.from(this.buffer.splice(0, this.chunkSize));
      this.port.postMessage(chunk.buffer, [chunk.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
