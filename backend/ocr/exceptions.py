"""Custom exceptions for the Invoice OCR module."""


class OCRInitializationError(Exception):
    """Raised when PaddleOCR/PP-Structure fails to initialize."""


class OCRExtractionError(Exception):
    """Raised when OCR processing fails on an image."""


class InvoiceParsingError(Exception):
    """Raised when the OCR result cannot be parsed into invoice structure."""
