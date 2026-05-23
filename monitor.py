#!/usr/bin/env python3
"""
SLCV — Monitor de câmera em modo terminal (sem interface web).
Uso: python monitor.py
"""
import cv2
import os
import time
import logging
from datetime import datetime
from config import (
    CAMERA_URL, SNAPSHOTS_DIR, LOG_FILE,
    CHECK_INTERVAL, COOLDOWN_SECONDS,
)
from detector import PersonDetector
from notifier import send_alert

os.makedirs(SNAPSHOTS_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("SLCV")


def open_camera(url: str):
    source = int(url) if url.isdigit() else url
    cap = cv2.VideoCapture(source)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap


def run_monitor(on_frame=None):
    """
    Loop principal de monitoramento.
    on_frame(annotated_frame, person_detected) é chamado a cada frame (opcional,
    usado pelo web_app para compartilhar o frame via thread).
    """
    log.info("=" * 50)
    log.info("SLCV iniciado")
    log.info(f"Câmera : {CAMERA_URL}")
    log.info(f"Cooldown alertas : {COOLDOWN_SECONDS}s")
    log.info(f"Snapshots em    : {SNAPSHOTS_DIR}/")
    log.info("=" * 50)

    detector = PersonDetector()
    cap = open_camera(CAMERA_URL)

    if not cap.isOpened():
        log.error(f"Não foi possível abrir câmera: {CAMERA_URL}")
        return

    log.info("Câmera conectada. Monitorando...")
    last_alert_time = 0.0

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                log.warning("Falha ao ler frame. Tentando reconectar em 5s...")
                cap.release()
                time.sleep(5)
                cap = open_camera(CAMERA_URL)
                if not cap.isOpened():
                    log.error("Reconexão falhou. Tentando novamente...")
                continue

            detected, annotated, count = detector.detect(frame)

            if on_frame is not None:
                on_frame(annotated, detected)

            if detected:
                now = time.time()
                if now - last_alert_time >= COOLDOWN_SECONDS:
                    ts = datetime.now()
                    snap = os.path.join(
                        SNAPSHOTS_DIR,
                        f"detection_{ts.strftime('%Y%m%d_%H%M%S')}.jpg",
                    )
                    cv2.imwrite(snap, annotated)
                    log.info(f"PESSOA DETECTADA | count={count} | {snap}")

                    try:
                        send_alert(snap, count, ts)
                    except Exception as e:
                        log.error(f"Erro ao enviar email: {e}")

                    last_alert_time = now
                else:
                    remaining = int(COOLDOWN_SECONDS - (now - last_alert_time))
                    log.debug(f"Detectado (cooldown: {remaining}s restantes)")

            time.sleep(CHECK_INTERVAL)

    except KeyboardInterrupt:
        log.info("Monitor encerrado pelo usuário (Ctrl+C).")
    finally:
        cap.release()


if __name__ == "__main__":
    run_monitor()
