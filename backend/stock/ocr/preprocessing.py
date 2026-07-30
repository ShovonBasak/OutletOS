"""
OpenCV preprocessing pipeline for delivery slip images.

Steps applied in order:
  1. Load image — Pillow, honor EXIF rotation, support HEIC via pillow-heif
  2. Convert RGB → BGR for OpenCV
  3. Deskew  — Hough-line dominant-angle correction (±15°)
  4. Denoise — fast non-local means
  5. Contrast — CLAHE (adaptive histogram equalisation)
  6. Return BGR ndarray ready for PP-StructureV3
"""
from __future__ import annotations

import io

from stock.ocr._exceptions import PreprocessingError


# ---------------------------------------------------------------------------
# Image loading
# ---------------------------------------------------------------------------

def load_image(source):
    """Load from a file path (str), raw bytes, or a file-like object.

    Honors EXIF rotation and flattens to RGB. Raises PreprocessingError on
    unreadable input. Returns a numpy ndarray (RGB).
    """
    try:
        import numpy as np
        from PIL import Image, ImageOps
    except ImportError as exc:
        raise PreprocessingError(
            "Pillow or numpy not installed. Run: pip install Pillow numpy"
        ) from exc

    try:
        try:
            import pillow_heif  # noqa: F401
            pillow_heif.register_heif_opener()
        except ImportError:
            pass

        if isinstance(source, bytes):
            img = Image.open(io.BytesIO(source))
        elif isinstance(source, str):
            img = Image.open(source)
        else:
            source.seek(0)
            img = Image.open(source)

        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        return np.array(img)
    except PreprocessingError:
        raise
    except Exception as exc:
        raise PreprocessingError(f"Cannot load image: {exc}") from exc


# ---------------------------------------------------------------------------
# OpenCV preprocessing
# ---------------------------------------------------------------------------

def preprocess(rgb) -> object:
    """RGB ndarray → preprocessed BGR ndarray.

    Returns a BGR numpy array because PaddleOCR (and OpenCV internally) use BGR.
    Raises PreprocessingError if opencv-python-headless is not installed.
    """
    try:
        import cv2
        import numpy as np
    except ImportError as exc:
        raise PreprocessingError(
            "opencv-python-headless or numpy not installed. "
            "Run: pip install opencv-python-headless numpy"
        ) from exc

    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    bgr = _deskew(bgr, gray)

    # Apply CLAHE contrast enhancement in LAB color space so color information
    # (needed by PP-StructureV3 for layout classification) is preserved.
    # The previous approach collapsed to grayscale here, causing PP-Structure
    # to misclassify table regions as "figure".
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    l_chan, a_chan, b_chan = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_chan = clahe.apply(l_chan)
    bgr = cv2.cvtColor(cv2.merge([l_chan, a_chan, b_chan]), cv2.COLOR_LAB2BGR)

    return bgr


def _deskew(bgr, gray):
    """Detect and correct small rotational skew (±15°) via Hough-line analysis."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return bgr

    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(
        edges, rho=1, theta=np.pi / 180,
        threshold=100, minLineLength=100, maxLineGap=10,
    )
    if lines is None:
        return bgr

    angles = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        if x2 != x1:
            angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
            if abs(angle) < 15:
                angles.append(angle)

    if not angles:
        return bgr

    median_angle = float(np.median(angles))
    if abs(median_angle) < 0.5:
        return bgr

    h, w = bgr.shape[:2]
    center = (w // 2, h // 2)
    M = cv2.getRotationMatrix2D(center, median_angle, 1.0)
    return cv2.warpAffine(
        bgr, M, (w, h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )


# ---------------------------------------------------------------------------
# Convenience
# ---------------------------------------------------------------------------

def load_and_preprocess(source) -> np.ndarray:
    """Load from any source, apply full preprocessing, return BGR ndarray."""
    return preprocess(load_image(source))
