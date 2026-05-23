import os
from dotenv import load_dotenv

load_dotenv()

CAMERA_URL = os.getenv("CAMERA_URL", "0")
DETECTION_MODEL = os.getenv("DETECTION_MODEL", "yolo")  # "yolo" ou "hog"
DETECTION_CONFIDENCE = float(os.getenv("DETECTION_CONFIDENCE", "0.5"))
CHECK_INTERVAL = float(os.getenv("CHECK_INTERVAL", "1.0"))
COOLDOWN_SECONDS = int(os.getenv("COOLDOWN_SECONDS", "60"))

EMAIL_SMTP_HOST = os.getenv("EMAIL_SMTP_HOST", "smtp.gmail.com")
EMAIL_SMTP_PORT = int(os.getenv("EMAIL_SMTP_PORT", "587"))
EMAIL_USER = os.getenv("EMAIL_USER", "")
EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD", "")
EMAIL_TO = os.getenv("EMAIL_TO", "")

SNAPSHOTS_DIR = os.getenv("SNAPSHOTS_DIR", "snapshots")
LOG_FILE = os.getenv("LOG_FILE", "detections.log")
WEB_PORT = int(os.getenv("WEB_PORT", "5000"))
