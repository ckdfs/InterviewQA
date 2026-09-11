"""长驻转写 worker。

启动即预加载 faster-whisper 模型并常驻，通过 stdin/stdout 的行式 JSON 与 Electron 主进程通信，
避免每一段音频都重新加载模型（省 2~5 秒）。

协议：
  收到第一行：初始化配置 JSON
  发送：{"event": "ready"} 或 {"event": "error", "error": "..."}
  收到：{"cmd": "transcribe", "id": 3, "wav": "D:/tmp/chunk_3.wav"}
  发送：{"id": 3, "text": "转写结果", "seconds": 1.8}  或 {"id": 3, "error": "..."}
  收到：{"cmd": "exit"} 退出
"""

import json
import sys
import time

# 静音/背景音乐场景下 Whisper 常见的幻觉文本，命中即丢弃
HALLUCINATION_PATTERNS = [
    "请不吝点赞",
    "打赏支持明镜",
    "字幕由",
    "amara.org",
    "Amara.org",
    "字幕志愿者",
    "谢谢观看",
    "请点赞分享",
]


def clean_text(text):
    text = (text or "").strip()
    if not text:
        return ""
    lowered = text.lower()
    for pattern in HALLUCINATION_PATTERNS:
        if pattern.lower() in lowered:
            return ""
    return text


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    try:
        cfg = json.loads(sys.stdin.readline())
    except Exception as exc:  # noqa: BLE001
        emit({"event": "error", "error": f"配置解析失败: {exc}"})
        return 1

    w = cfg.get("whisper", {})
    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(
            w.get("model", "small"),
            device=w.get("device", "cpu"),
            compute_type=w.get("computeType", "int8"),
            cpu_threads=int(w.get("threads", 6)),
            num_workers=1,
        )
    except Exception as exc:  # noqa: BLE001
        emit({"event": "error", "error": f"模型加载失败: {exc}"})
        return 1

    language = w.get("language") or None
    beam_size = int(w.get("beamSize", 1))
    initial_prompt = w.get("initialPrompt")

    emit({"event": "ready"})

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:  # noqa: BLE001
            continue

        cmd = req.get("cmd")
        if cmd == "exit":
            break
        if cmd != "transcribe":
            continue

        rid = req.get("id")
        wav_path = req.get("wav")
        started = time.time()
        try:
            segments, _info = model.transcribe(
                wav_path,
                language=language,
                beam_size=beam_size,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
                initial_prompt=initial_prompt,
                condition_on_previous_text=False,
                temperature=0,
                without_timestamps=True,
            )
            text = clean_text("".join(seg.text for seg in segments))
            emit({"id": rid, "text": text, "seconds": round(time.time() - started, 2)})
        except Exception as exc:  # noqa: BLE001
            emit({"id": rid, "error": str(exc)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
