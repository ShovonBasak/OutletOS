"""Image preprocessing pipeline: load → auto-rotate → deskew → perspective → enhance.

All heavy dependencies (cv2, numpy, Pillow) are imported lazily so that importing
this module does not crash Django startup when OpenCV is not installed.
"""
from __future__ import annotations

import io
import os
from typing import Union


ImageSource = Union[str, bytes, "io.IOBase"]


def preprocess(source: ImageSource):
    """Full preprocessing pipeline.

    Args:
        source: File path (str), raw bytes, or a file-like object.

    Returns:
        numpy.ndarray in BGR format, ready for PaddleOCR.

    Raises:
        ImportError: OpenCV or Pillow not installed.
        ValueError: Image cannot be read from the given source.
    """
    import cv2
    import numpy as np

    bgr = _load(source)
    bgr = _auto_rotate_exif(bgr, source)
    bgr = _deskew(bgr)
    bgr = _perspective_correct(bgr)
    bgr = _enhance_contrast(bgr)
    return bgr


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _load(source: ImageSource):
    """Load image from path, bytes, or file-like object → BGR numpy array."""
    import cv2
    import numpy as np

    if isinstance(source, (str, os.PathLike)):
        bgr = cv2.imread(str(source))
        if bgr is None:
            raise ValueError(f"cv2.imread could not read: {source!r}")
        return bgr

    if isinstance(source, (bytes, bytearray)):
        raw = source
    elif hasattr(source, "read"):
        raw = source.read()
        if hasattr(source, "seek"):
            source.seek(0)
    else:
        raise ValueError(f"Unsupported image source type: {type(source)}")

    # Try Pillow first (handles HEIC, WebP, etc.)
    try:
        from PIL import Image, ExifTags
        import pillow_heif  # noqa: F401 — registers HEIC codec
    except ImportError:
        pass
    else:
        try:
            pil = Image.open(io.BytesIO(raw)).convert("RGB")
            arr = np.array(pil)
            return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
        except Exception:
            pass

    # Fallback: OpenCV from buffer
    arr = np.frombuffer(raw, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("OpenCV could not decode the image buffer.")
    return bgr


def _auto_rotate_exif(bgr, source: ImageSource):
    """Correct orientation using EXIF data (phones often shoot rotated)."""
    try:
        from PIL import Image, ExifTags
        import numpy as np
        import cv2

        # Re-read original bytes to get EXIF
        if isinstance(source, (str, os.PathLike)):
            with open(source, "rb") as f:
                raw = f.read()
        elif isinstance(source, (bytes, bytearray)):
            raw = bytes(source)
        elif hasattr(source, "read"):
            raw = source.read()
            if hasattr(source, "seek"):
                source.seek(0)
        else:
            return bgr

        pil = Image.open(io.BytesIO(raw))
        exif = getattr(pil, "_getexif", lambda: None)()
        if not exif:
            return bgr

        orientation_key = next(
            (k for k, v in ExifTags.TAGS.items() if v == "Orientation"), None
        )
        if orientation_key is None:
            return bgr
        orientation = exif.get(orientation_key)

        _ROT = {3: 180, 6: 270, 8: 90}
        angle = _ROT.get(orientation)
        if angle:
            pil = pil.rotate(angle, expand=True)
            arr = np.array(pil.convert("RGB"))
            return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    except Exception:
        pass
    return bgr


def _deskew(bgr):
    """Correct small rotation angles (±15°) using Hough line detection."""
    import cv2
    import numpy as np

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150, apertureSize=3)
    lines = cv2.HoughLines(edges, 1, np.pi / 180, threshold=100)

    if lines is None or len(lines) == 0:
        return bgr

    angles: list[float] = []
    for line in lines[:30]:
        rho, theta = line[0]
        # Convert theta to degree offset from horizontal/vertical
        angle_deg = np.degrees(theta)
        if angle_deg < 45:
            angles.append(angle_deg)
        elif angle_deg < 135:
            angles.append(angle_deg - 90)
        else:
            angles.append(angle_deg - 180)

    if not angles:
        return bgr

    median_angle = float(np.median(angles))
    if abs(median_angle) < 0.5:
        return bgr  # negligible skew

    h, w = bgr.shape[:2]
    center = (w / 2, h / 2)
    M = cv2.getRotationMatrix2D(center, median_angle, 1.0)
    rotated = cv2.warpAffine(bgr, M, (w, h), flags=cv2.INTER_CUBIC,
                              borderMode=cv2.BORDER_REPLICATE)
    return rotated


def _perspective_correct(bgr):
    """Warp perspective if a clear document quadrilateral is detected.

    Skips correction when no confident boundary is found — better to leave
    a slightly trapezoidal image than to warp incorrectly.
    """
    import cv2
    import numpy as np

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    if not contours:
        return bgr

    # Largest contour by area
    largest = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(largest)
    img_area = bgr.shape[0] * bgr.shape[1]

    # Only correct if the contour covers 30–95% of the image (it's the document)
    if not (0.30 * img_area <= area <= 0.95 * img_area):
        return bgr

    peri = cv2.arcLength(largest, True)
    approx = cv2.approxPolyDP(largest, 0.02 * peri, True)

    if len(approx) != 4:
        return bgr  # not a clear quadrilateral

    pts = approx.reshape(4, 2).astype(np.float32)

    # Order: top-left, top-right, bottom-right, bottom-left
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1)
    ordered = np.array([
        pts[np.argmin(s)],
        pts[np.argmin(diff)],
        pts[np.argmax(s)],
        pts[np.argmax(diff)],
    ], dtype=np.float32)

    (tl, tr, br, bl) = ordered
    w_top = np.linalg.norm(tr - tl)
    w_bot = np.linalg.norm(br - bl)
    h_left = np.linalg.norm(bl - tl)
    h_right = np.linalg.norm(br - tr)
    out_w = int(max(w_top, w_bot))
    out_h = int(max(h_left, h_right))

    if out_w < 10 or out_h < 10:
        return bgr

    dst = np.array([[0, 0], [out_w, 0], [out_w, out_h], [0, out_h]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(ordered, dst)
    warped = cv2.warpPerspective(bgr, M, (out_w, out_h))
    return warped


def _enhance_contrast(bgr):
    """Apply CLAHE on the L channel of LAB to improve contrast without blowout."""
    import cv2

    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    l_ch, a_ch, b_ch = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_ch = clahe.apply(l_ch)
    enhanced = cv2.merge([l_ch, a_ch, b_ch])
    return cv2.cvtColor(enhanced, cv2.COLOR_LAB2BGR)
