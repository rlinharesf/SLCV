import cv2
import logging
from config import DETECTION_MODEL, DETECTION_CONFIDENCE

log = logging.getLogger("SLCV.detector")


class PersonDetector:
    def __init__(self):
        self.mode = DETECTION_MODEL
        if self.mode == "yolo":
            self._init_yolo()
        else:
            self._init_hog()

    def _init_yolo(self):
        try:
            from ultralytics import YOLO
            log.info("Carregando modelo YOLOv8n (download automático na primeira vez)...")
            self.model = YOLO("yolov8n.pt")
            log.info("YOLOv8n carregado com sucesso")
        except ImportError:
            log.warning("'ultralytics' não instalado. Usando HOG como fallback.")
            self.mode = "hog"
            self._init_hog()

    def _init_hog(self):
        log.info("Inicializando detector HOG (built-in OpenCV)...")
        self.hog = cv2.HOGDescriptor()
        self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        self.mode = "hog"

    def detect(self, frame):
        """Returns (person_detected: bool, annotated_frame, person_count: int)."""
        if self.mode == "yolo":
            return self._detect_yolo(frame)
        return self._detect_hog(frame)

    def _detect_yolo(self, frame):
        results = self.model(frame, classes=[0], conf=DETECTION_CONFIDENCE, verbose=False)
        annotated = results[0].plot()
        count = len(results[0].boxes)
        return count > 0, annotated, count

    def _detect_hog(self, frame):
        copy = frame.copy()
        boxes, weights = self.hog.detectMultiScale(
            copy, winStride=(8, 8), padding=(4, 4), scale=1.05
        )
        valid = [
            (box, w) for box, w in zip(boxes, weights) if w > 0.5
        ] if len(boxes) > 0 else []
        for (x, y, bw, bh), w in valid:
            cv2.rectangle(copy, (x, y), (x + bw, y + bh), (0, 255, 0), 2)
            cv2.putText(copy, f"Person {w[0]:.2f}", (x, y - 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
        count = len(valid)
        return count > 0, copy, count
