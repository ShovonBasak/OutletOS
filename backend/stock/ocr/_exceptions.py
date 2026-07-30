"""Shared exception classes for the stock.ocr pipeline."""


class PaddleOcrUnavailable(Exception):
    """paddlepaddle / paddleocr not installed, or model initialisation failed."""


class PreprocessingError(Exception):
    """Image cannot be loaded or OpenCV / numpy is not installed."""
