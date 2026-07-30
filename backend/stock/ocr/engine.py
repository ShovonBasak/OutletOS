"""
PaddleOCR 3.x engines: PPStructureV3 (table-aware) and PaddleOCR text OCR.

Both engines are lazy singletons — model weights load on first use.

Environment variables:
    PADDLE_OCR_VERSION  — OCR model to use (default: PP-OCRv6)
    PADDLE_OCR_LANG     — language code for both engines (default: en)

Output format is kept backward-compatible with the 2.x callers:

    run_text_ocr() → [[bbox, (text, confidence)], ...]
        bbox = [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]

    run() → [{"type": "table"|"text"|..., "res": ...}, ...]
        table res = {"html": "<table>...</table>"}
        text  res = [{"text": "...", "txt": "..."}]
"""
from __future__ import annotations

import os
import threading

from stock.ocr._exceptions import PaddleOcrUnavailable

OCR_VERSION = os.environ.get("PADDLE_OCR_VERSION", "PP-OCRv6")


# ---------------------------------------------------------------------------
# Availability check
# ---------------------------------------------------------------------------

def available() -> bool:
    """True when paddleocr / paddle are importable (models not yet loaded)."""
    try:
        import paddleocr  # noqa: F401
        import paddle     # noqa: F401
        return True
    except ImportError:
        return False


# ---------------------------------------------------------------------------
# PPStructureV3 (table-aware layout analysis)
# ---------------------------------------------------------------------------

_pp_engine = None
_pp_lock   = threading.Lock()


def _build_pp() -> object:
    try:
        from paddleocr import PPStructureV3
    except ImportError as exc:
        raise PaddleOcrUnavailable(
            "paddleocr is not installed — "
            "run: pip install paddleocr opencv-python-headless"
        ) from exc

    lang = os.environ.get("PADDLE_OCR_LANG", "en")
    try:
        return PPStructureV3(
            lang=lang,
            ocr_version=OCR_VERSION,
            use_table_recognition=True,
            use_formula_recognition=False,
            use_chart_recognition=False,
            use_seal_recognition=False,
        )
    except Exception as exc:
        raise PaddleOcrUnavailable(f"PPStructureV3 init failed: {exc}") from exc


def get_engine():
    """Return (and lazily build) the shared PPStructureV3 engine."""
    global _pp_engine
    if _pp_engine is None:
        with _pp_lock:
            if _pp_engine is None:
                _pp_engine = _build_pp()
    return _pp_engine


def run(image_bgr) -> list[dict]:
    """Run PPStructureV3 on a preprocessed BGR array.

    Returns a 2.x-compatible region list::

        [{"type": "table"|"text", "res": ...}, ...]

    Table regions:  res = {"html": "<table>...</table>"}
    Text regions:   res = [{"text": "...", "txt": "..."}]

    Raises PaddleOcrUnavailable on any failure.
    """
    engine = get_engine()
    try:
        results = engine.predict(image_bgr, use_table_recognition=True)
    except Exception as exc:
        raise PaddleOcrUnavailable(f"PPStructureV3 inference failed: {exc}") from exc

    if not results:
        return []

    result = results[0]  # LayoutParsingResult (dict-like)
    regions: list[dict] = []

    # ── Tables ──────────────────────────────────────────────────────────────
    # table_res_list holds one entry per detected table.  Each entry is a
    # dict-like object; the HTML is on its .html property (a dict with a
    # "pred" key) or accessible as result["table_res_list"][i]["html"]["pred"].
    table_res_list = _safe_get(result, "table_res_list", [])
    for table_res in table_res_list:
        html = _extract_table_html(table_res)
        if html:
            regions.append({"type": "table", "res": {"html": html}})

    # ── Plain text blocks (non-table, for header / footer / address lines) ──
    # overall_ocr_res contains every text box in the image.  We include it so
    # slip_parser / ai_extraction can pick up invoice header fields (date,
    # invoice number, supplier) that live outside the table area.
    overall_ocr = _safe_get(result, "overall_ocr_res", {})
    dt_polys  = _safe_get(overall_ocr, "dt_polys",  [])
    rec_texts = _safe_get(overall_ocr, "rec_texts", [])
    for poly, text in zip(dt_polys, rec_texts):
        if not text:
            continue
        regions.append({
            "type": "text",
            "res": [{"text": text, "txt": text}],
        })

    return regions


def _extract_table_html(table_res) -> str:
    """Pull the HTML string out of a table result object (handles API variants)."""
    # Variant A: table_res.html is a property returning {"pred": "<table>..."}
    try:
        h = table_res.html
        if isinstance(h, dict):
            return h.get("pred", "") or h.get("html", "")
        if isinstance(h, str):
            return h
    except Exception:
        pass

    # Variant B: direct dict access
    for key in ("html", "html_str"):
        try:
            val = table_res[key]
            if isinstance(val, dict):
                return val.get("pred", "") or val.get("html", "")
            if isinstance(val, str) and val.strip():
                return val
        except (KeyError, TypeError):
            pass

    # Variant C: nested under "table_ocr_pred"
    try:
        pred = table_res["table_ocr_pred"]
        if isinstance(pred, dict):
            return pred.get("html", "") or pred.get("pred", "")
    except (KeyError, TypeError):
        pass

    return ""


def _safe_get(obj, key, default):
    """dict-like get that tolerates both __getitem__ and attribute access."""
    try:
        return obj[key]
    except (KeyError, TypeError):
        pass
    try:
        return getattr(obj, key, default)
    except Exception:
        return default


# ---------------------------------------------------------------------------
# PaddleOCR text OCR (positional boxes)
# ---------------------------------------------------------------------------

_ocr_engine = None
_ocr_lock   = threading.Lock()


def _build_text_ocr() -> object:
    try:
        from paddleocr import PaddleOCR
    except ImportError as exc:
        raise PaddleOcrUnavailable(
            "paddleocr is not installed — "
            "run: pip install paddleocr opencv-python-headless"
        ) from exc

    lang = os.environ.get("PADDLE_OCR_LANG", "en")
    try:
        return PaddleOCR(lang=lang, ocr_version=OCR_VERSION)
    except Exception as exc:
        raise PaddleOcrUnavailable(f"PaddleOCR init failed: {exc}") from exc


def get_text_ocr_engine():
    """Return (and lazily build) the shared PaddleOCR text engine."""
    global _ocr_engine
    if _ocr_engine is None:
        with _ocr_lock:
            if _ocr_engine is None:
                _ocr_engine = _build_text_ocr()
    return _ocr_engine


def run_text_ocr(image_bgr) -> list:
    """Run PP-OCRv6 text detection + recognition on a BGR array.

    Returns a 2.x-compatible flat list::

        [[bbox, (text, confidence)], ...]
        bbox = [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]

    Raises PaddleOcrUnavailable on failure.
    """
    engine = get_text_ocr_engine()
    try:
        results = engine.predict(image_bgr)
    except Exception as exc:
        raise PaddleOcrUnavailable(f"PaddleOCR predict failed: {exc}") from exc

    if not results:
        return []

    result = results[0]  # one result per image

    dt_polys  = _safe_get(result, "dt_polys",  [])
    rec_texts = _safe_get(result, "rec_texts", [])
    rec_scores = _safe_get(result, "rec_scores", [])

    # Pad scores if missing (older paddlex may omit them)
    if not rec_scores:
        rec_scores = [1.0] * len(rec_texts)

    boxes = []
    for poly, text, score in zip(dt_polys, rec_texts, rec_scores):
        if not text:
            continue
        if hasattr(poly, "tolist"):
            poly = poly.tolist()
        boxes.append([poly, (text, float(score))])
    return boxes
