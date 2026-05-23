import smtplib
import os
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from datetime import datetime
from config import EMAIL_SMTP_HOST, EMAIL_SMTP_PORT, EMAIL_USER, EMAIL_PASSWORD, EMAIL_TO

log = logging.getLogger("SLCV.notifier")


def send_alert(snapshot_path: str, person_count: int, timestamp: datetime) -> bool:
    if not all([EMAIL_USER, EMAIL_PASSWORD, EMAIL_TO]):
        log.warning("Credenciais de email não configuradas — notificação ignorada.")
        return False

    msg = MIMEMultipart("related")
    msg["From"] = EMAIL_USER
    msg["To"] = EMAIL_TO
    msg["Subject"] = (
        f"[SLCV] {person_count} pessoa(s) detectada(s) — "
        f"{timestamp.strftime('%d/%m/%Y %H:%M:%S')}"
    )

    html = f"""
    <html><body style="font-family:sans-serif;background:#1a1a2e;color:#eee;padding:20px">
      <div style="max-width:600px;margin:0 auto;background:#16213e;border-radius:12px;
                  padding:24px;border:2px solid #e94560">
        <h2 style="color:#e94560;margin-top:0">&#9888; Alerta de Segurança — SLCV</h2>
        <table style="width:100%;margin-bottom:16px">
          <tr>
            <td style="color:#888;padding:4px 0">Pessoas detectadas:</td>
            <td><strong style="color:#e94560">{person_count}</strong></td>
          </tr>
          <tr>
            <td style="color:#888;padding:4px 0">Data/Hora:</td>
            <td>{timestamp.strftime('%d/%m/%Y %H:%M:%S')}</td>
          </tr>
        </table>
        <img src="cid:snapshot" style="width:100%;border-radius:8px;
             border:2px solid #e94560;display:block">
        <p style="color:#888;font-size:0.8rem;margin-top:16px;margin-bottom:0">
          Gerado pelo SLCV — Sistema de Monitoramento por Câmera
        </p>
      </div>
    </body></html>
    """
    msg.attach(MIMEText(html, "html"))

    if snapshot_path and os.path.exists(snapshot_path):
        with open(snapshot_path, "rb") as f:
            img = MIMEImage(f.read())
            img.add_header("Content-ID", "<snapshot>")
            img.add_header("Content-Disposition", "inline", filename="snapshot.jpg")
            msg.attach(img)

    with smtplib.SMTP(EMAIL_SMTP_HOST, EMAIL_SMTP_PORT) as server:
        server.ehlo()
        server.starttls()
        server.login(EMAIL_USER, EMAIL_PASSWORD)
        server.sendmail(EMAIL_USER, EMAIL_TO, msg.as_string())

    log.info(f"Email de alerta enviado para {EMAIL_TO}")
    return True
