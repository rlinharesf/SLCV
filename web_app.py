#!/usr/bin/env python3
"""
SLCV Web Dashboard — monitor de câmera com interface web.
Uso: python web_app.py
Acesse: http://localhost:5000
"""
import cv2
import os
import threading
import time
import logging
from datetime import datetime
from flask import Flask, Response, render_template, jsonify
from config import (
    WEB_PORT, SNAPSHOTS_DIR, LOG_FILE,
    CHECK_INTERVAL, COOLDOWN_SECONDS, CAMERA_URL,
)
from detector import PersonDetector
from notifier import send_alert
from monitor import open_camera

os.makedirs(SNAPSHOTS_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("SLCV.web")

app = Flask(__name__)

_state = {
    "annotated": None,
    "person_detected": False,
    "last_detection": None,
    "detection_count": 0,
    "alerts_sent": 0,
}
_lock = threading.Lock()


def _monitoring_loop():
    detector = PersonDetector()
    cap = open_camera(CAMERA_URL)

    if not cap.isOpened():
        log.error(f"Não foi possível abrir câmera: {CAMERA_URL}")
        return

    log.info("Thread de monitoramento iniciada.")
    last_alert = 0.0

    while True:
        ret, frame = cap.read()
        if not ret:
            log.warning("Falha ao ler frame. Reconectando em 5s...")
            cap.release()
            time.sleep(5)
            cap = open_camera(CAMERA_URL)
            continue

        detected, annotated, count = detector.detect(frame)

        with _lock:
            _state["annotated"] = annotated.copy()
            _state["person_detected"] = detected

        if detected:
            now = time.time()
            if now - last_alert >= COOLDOWN_SECONDS:
                ts = datetime.now()
                snap = os.path.join(
                    SNAPSHOTS_DIR,
                    f"detection_{ts.strftime('%Y%m%d_%H%M%S')}.jpg",
                )
                cv2.imwrite(snap, annotated)

                with _lock:
                    _state["last_detection"] = ts.isoformat()
                    _state["detection_count"] += 1

                log.info(f"PESSOA DETECTADA | count={count} | {snap}")

                try:
                    send_alert(snap, count, ts)
                    with _lock:
                        _state["alerts_sent"] += 1
                except Exception as e:
                    log.error(f"Erro ao enviar email: {e}")

                last_alert = now

        time.sleep(CHECK_INTERVAL)


def _frame_generator():
    while True:
        with _lock:
            frame = _state["annotated"]

        if frame is None:
            time.sleep(0.1)
            continue

        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            continue

        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n"
            + buf.tobytes()
            + b"\r\n"
        )
        time.sleep(0.04)  # ~25 fps max


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/video_feed")
def video_feed():
    return Response(
        _frame_generator(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


@app.route("/api/status")
def api_status():
    with _lock:
        return jsonify({
            "person_detected": _state["person_detected"],
            "last_detection": _state["last_detection"],
            "detection_count": _state["detection_count"],
            "alerts_sent": _state["alerts_sent"],
        })


if __name__ == "__main__":
    t = threading.Thread(target=_monitoring_loop, daemon=True)
    t.start()
    log.info(f"Dashboard disponível em http://localhost:{WEB_PORT}")
    app.run(host="0.0.0.0", port=WEB_PORT, debug=False, threaded=True)
