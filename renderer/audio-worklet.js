/**
 * AudioWorklet：把系统声音按 16kHz 单声道切成 Int16 PCM，每 0.5 秒回传一次主线程。
 * 主线程再交给主进程缓冲、切片与转写。
 */
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    // 0.5 秒的缓冲（sampleRate 由 AudioContext 指定为 16000）
    this.buffer = new Float32Array(Math.floor(sampleRate * 0.5));
    this.filled = 0;
    this.levelSum = 0;
    this.levelFrames = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.flush) this.flush();
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channelCount = input.length;
      const first = input[0];
      for (let i = 0; i < first.length; i++) {
        // 多声道先降混为单声道，避免只取左声道漏内容
        let sample = first[i];
        if (channelCount > 1) {
          sample = 0;
          for (let c = 0; c < channelCount; c++) sample += input[c][i];
          sample /= channelCount;
        }
        this.levelSum += sample * sample;
        this.levelFrames++;
        this.buffer[this.filled++] = sample;
        if (this.filled >= this.buffer.length) this.flush();
      }
    }
    if (this.levelFrames >= 4000) {
      const level = Math.sqrt(this.levelSum / this.levelFrames);
      this.port.postMessage({ level });
      this.levelSum = 0;
      this.levelFrames = 0;
    }
    return true; // 不写输出，避免把系统声音再播出去
  }

  flush() {
    if (this.filled === 0) return;
    const int16 = new Int16Array(this.filled);
    const data = this.buffer;
    for (let i = 0; i < this.filled; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage({ pcm: int16.buffer }, [int16.buffer]);
    this.filled = 0;
  }
}

registerProcessor('pcm-recorder', PcmRecorder);
