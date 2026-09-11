"""转写自检脚本：单独拉起 worker.py，转写一段音频并打印结果。

用法：.venv/Scripts/python.exe stt/test_transcribe.py [音频路径]
"""

import json
import os
import subprocess
import sys
import time

APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV_PYTHON = os.path.join(APP_ROOT, ".venv", "Scripts", "python.exe")
WORKER = os.path.join(APP_ROOT, "stt", "worker.py")


def main():
    audio = sys.argv[1] if len(sys.argv) > 1 else os.path.join(APP_ROOT, "stt", "test_sample.wav")
    if not os.path.exists(audio):
        print(f"音频不存在: {audio}")
        return 1

    with open(os.path.join(APP_ROOT, "config.json"), "r", encoding="utf-8") as f:
        config = json.load(f)

    env = dict(os.environ)
    env.update({"PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1", "HF_ENDPOINT": "https://hf-mirror.com"})

    started = time.time()
    proc = subprocess.Popen(
        [VENV_PYTHON, WORKER],
        cwd=APP_ROOT,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    proc.stdin.write(json.dumps({"whisper": config["whisper"]}) + "\n")
    proc.stdin.flush()

    def read_message():
        """读一行并解析成 JSON；非 JSON（如进度/告警日志）原样打印后继续。"""
        while True:
            line = proc.stdout.readline()
            if not line:
                return None
            line = line.strip()
            if not line:
                continue
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                print("[log]", line)

    # 等待模型就绪
    while True:
        msg = read_message()
        if msg is None:
            print("worker 启动失败（无输出）")
            return 1
        if msg.get("event") == "ready":
            print(f"模型就绪，用时 {time.time() - started:.1f}s")
            break
        if msg.get("event") == "error":
            print("模型加载失败:", msg.get("error"))
            return 1

    t0 = time.time()
    proc.stdin.write(json.dumps({"cmd": "transcribe", "id": 1, "wav": audio}) + "\n")
    proc.stdin.flush()

    while True:
        msg = read_message()
        if msg is None:
            print("转写超时/无返回")
            return 1
        if msg.get("id") == 1:
            if msg.get("error"):
                print("转写出错:", msg["error"])
                return 1
            print(f"转写用时: {time.time() - t0:.2f}s（音频时长约 {audio_duration(audio):.1f}s）")
            print("识别结果:", msg.get("text"))
            break

    proc.stdin.write(json.dumps({"cmd": "exit"}) + "\n")
    proc.stdin.flush()
    proc.wait(timeout=10)
    return 0


def audio_duration(path):
    try:
        import av

        with av.open(path) as container:
            stream = container.streams.audio[0]
            return float(stream.duration * stream.time_base)
    except Exception:
        return 0.0


if __name__ == "__main__":
    sys.exit(main())
