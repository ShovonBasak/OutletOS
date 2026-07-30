"""OCRService — thread-safe singleton wrapping PaddleOCR PP-Structure and text OCR.

The PaddleOCR models are loaded once and reused across all requests.
Heavy imports (paddleocr, paddle) happen only on first use.
"""
from __future__ import annotations

import os
import threading
from typing import Any

from .exceptions import OCRExtractionError, OCRInitializationError


class OCRService:
    """Wraps PP-StructureV3 (layout analysis) and PaddleOCR (text extraction).

    Usage::

        service = OCRService.get_instance()
        layout  = service.run_layout(image_bgr)
        lines   = service.run_text(image_bgr)
    """

    _instance: "OCRService | None" = None
    _class_lock: threading.Lock = threading.Lock()

    # ------------------------------------------------------------------
    # Singleton access
    # ------------------------------------------------------------------

    @classmethod
    def get_instance(cls) -> "OCRService":
        """Return the process-level singleton, creating it on first call."""
        if cls._instance is None:
            with cls._class_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @classmethod
    def reset(cls) -> None:
        """Destroy the singleton (useful in tests)."""
        with cls._class_lock:
            cls._instance = None

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    def __init__(self) -> None:
        self._pp_engine: Any = None
        self._ocr_engine: Any = None
        self._pp_lock = threading.Lock()
        self._ocr_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Public methods
    # ------------------------------------------------------------------

    def run_layout(self, image_bgr) -> list[dict]:
        """Run PP-StructureV3 layout analysis on a BGR numpy array.

        Returns a list of region dicts, each with keys:
            type  — "table" | "text" | "title" | ...
            bbox  — [x1, y1, x2, y2]
            res   — region-specific payload (HTML string for tables, text list for text)

        Raises:
            OCRInitializationError: engine failed to load.
            OCRExtractionError: engine crashed during inference.
        """
        engine = self._get_pp_engine()
        try:
            result = engine(image_bgr)
            return result if result else []
        except Exception as exc:
            raise OCRExtractionError(f"PP-Structure inference failed: {exc}") from exc

    def run_text(self, image_bgr) -> list:
        """Run basic PaddleOCR text extraction on a BGR numpy array.

        Returns a flat list of [bbox, (text, confidence)] pairs.

        Raises:
            OCRInitializationError: engine failed to load.
            OCRExtractionError: engine crashed during inference.
        """
        engine = self._get_ocr_engine()
        try:
            result = engine.ocr(image_bgr, cls=True)
            page = result[0] if result else []
            return [item for item in (page or []) if item]
        except Exception as exc:
            raise OCRExtractionError(f"PaddleOCR text extraction failed: {exc}") from exc

    # ------------------------------------------------------------------
    # Lazy engine initialisation
    # ------------------------------------------------------------------

    def _get_pp_engine(self) -> Any:
        if self._pp_engine is None:
            with self._pp_lock:
                if self._pp_engine is None:
                    self._pp_engine = self._build_pp_engine()
        return self._pp_engine

    def _get_ocr_engine(self) -> Any:
        if self._ocr_engine is None:
            with self._ocr_lock:
                if self._ocr_engine is None:
                    self._ocr_engine = self._build_ocr_engine()
        return self._ocr_engine

    @staticmethod
    def _build_pp_engine() -> Any:
        use_gpu = os.getenv("PADDLE_USE_GPU", "0").lower() in ("1", "true", "yes")
        lang = os.getenv("PADDLE_OCR_LANG", "en")
        try:
            from paddleocr import PPStructure
        except ImportError as exc:
            raise OCRInitializationError(
                "PaddleOCR is not installed. "
                "Run: pip install paddlepaddle paddleocr"
            ) from exc
        try:
            return PPStructure(
                table=True,
                ocr=True,
                lang=lang,
                use_gpu=use_gpu,
                recovery=False,
                show_log=False,
            )
        except Exception as exc:
            raise OCRInitializationError(
                f"PP-Structure model failed to initialise: {exc}"
            ) from exc

    @staticmethod
    def _build_ocr_engine() -> Any:
        use_gpu = os.getenv("PADDLE_USE_GPU", "0").lower() in ("1", "true", "yes")
        lang = os.getenv("PADDLE_OCR_LANG", "en")
        try:
            from paddleocr import PaddleOCR
        except ImportError as exc:
            raise OCRInitializationError(
                "PaddleOCR is not installed. "
                "Run: pip install paddlepaddle paddleocr"
            ) from exc
        try:
            return PaddleOCR(use_angle_cls=True, lang=lang, use_gpu=use_gpu, show_log=False)
        except Exception as exc:
            raise OCRInitializationError(
                f"PaddleOCR text engine failed to initialise: {exc}"
            ) from exc
