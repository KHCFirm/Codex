"""Claim PDF parser for HCFA-1500 and EOB documents.

This module exposes helper functions for extracting text from PDF files
and parsing common fields from healthcare claims. It provides two simple
parsers ``HcfaParser`` and ``EobParser`` with a unified ``parse_file``
entry point.  The goal is to keep the parsing logic easy to extend while
remaining lightweight so it can run in limited environments such as
Streamlit Cloud.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict, field
from decimal import Decimal
from pathlib import Path
from typing import List, Optional, Dict
import re

import pdfplumber
from pdf2image import convert_from_path
import pytesseract
from dateutil import parser as dateparser


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def parse_money(value: str) -> Optional[Decimal]:
    """Parse a currency string into ``Decimal``.

    This helper strips common currency formatting and also supports
    parentheses for negative amounts.  It returns ``None`` when the value
    cannot be converted.
    """
    if not value:
        return None
    cleaned = value.strip()
    negative = cleaned.startswith("(") and cleaned.endswith(")")
    if negative:
        cleaned = cleaned[1:-1]
    cleaned = re.sub(r"[^0-9.-]", "", cleaned)
    try:
        amount = Decimal(cleaned)
        return -amount if negative else amount
    except Exception:
        return None


def parse_date(value: str) -> Optional[str]:
    """Convert various date strings to ISO ``YYYY-MM-DD`` format."""
    if not value:
        return None
    try:
        return dateparser.parse(value, fuzzy=True).date().isoformat()
    except Exception:
        return None


@dataclass
class ServiceLine:
    cpt_code: Optional[str] = None
    charge: Optional[Decimal] = None
    patient_responsibility: Optional[Decimal] = None
    insurance_paid: Optional[Decimal] = None


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------
HCFA_PATTERNS = [
    r"CMS[-\s]?1500",
    r"HCFA[-\s]?1500",
    r"HCFA",
    r"HEALTH\s+INSURANCE\s+CLAIM\s+FORM",
    r"\b24J\b",
]

EOB_PATTERNS = [
    r"EXPLANATION\s+OF\s+BENEFITS",
    r"REMITTANCE\s+ADVICE",
    r"EXPLANATION\s+OF\s+PAYMENT",
    r"\bEOB\b",
    r"CLAIM\s+SUMMARY",
    r"PATIENT\s+RESPONSIBILITY",
]


def classify_text(text: str) -> Optional[str]:
    """Return ``HCFA`` or ``EOB`` based on keyword presence."""
    for pattern in HCFA_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return "HCFA"
    for pattern in EOB_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return "EOB"
    return None


# ---------------------------------------------------------------------------
# PDF text extraction
# ---------------------------------------------------------------------------

def extract_text(pdf_path: Path) -> str:
    """Extract text from a PDF using ``pdfplumber`` with OCR fallback."""
    text_parts: List[str] = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text(x_tolerance=1, y_tolerance=1)
            if page_text:
                text_parts.append(page_text)
    text = "\n".join(text_parts).strip()
    if text:
        return text
    try:
        images = convert_from_path(str(pdf_path))
        for img in images:
            text_parts.append(pytesseract.image_to_string(img))
        return "\n".join(text_parts)
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

@dataclass
class HcfaParser:
    text: str
    result: Dict[str, object] = field(default_factory=dict)

    FIELD_PATTERNS = {
        "patient_name": r"PATIENT'S NAME[^\n]*\n(.+)",
        "insured_id": r"1A\.\s*INSURED'S ID NUMBER[^\n]*\n(.+)",
        "patient_address": r"5\.\s*PATIENT ADDRESS[^\n]*\n(.+)",
        "federal_tax_id": r"25\.\s*FEDERAL TAX ID NUMBER[^\n]*\n(.+)",
        "billing_npi": r"33A\.\s*NPI[^\n]*\n(.+)",
    }

    def parse(self) -> Dict[str, object]:
        self.result = {"doc_type": "HCFA"}
        for field_name, pattern in self.FIELD_PATTERNS.items():
            value = self._find_field(pattern)
            if value:
                self.result[field_name] = value
        dob = self._find_field(r"3\.\s*DATE OF BIRTH[^\n]*\n(.+)")
        if dob:
            self.result["patient_dob"] = parse_date(dob)
        self.result["service_lines"] = self._parse_service_lines()
        return self.result

    def _find_field(self, pattern: str) -> Optional[str]:
        m = re.search(pattern, self.text, re.IGNORECASE)
        return m.group(1).strip() if m else None

    def _parse_service_lines(self) -> List[Dict[str, object]]:
        # Very simple service line parser: look for lines after the 24A header
        header = re.search(r"24A.*24B.*24D.*24F.*24J", self.text, re.IGNORECASE)
        if not header:
            return []
        lines: List[Dict[str, object]] = []
        body = self.text[header.end():].splitlines()
        for raw in body:
            cols = raw.split()
            if len(cols) < 4:
                continue
            line = ServiceLine(
                cpt_code=cols[2],
                charge=parse_money(cols[3]),
            )
            lines.append({k: v for k, v in asdict(line).items() if v is not None})
        return lines


@dataclass
class EobParser:
    text: str
    result: Dict[str, object] = field(default_factory=dict)

    DATE_PATTERNS = [
        r"(?:statement|payment|check|printed|processing)\s*date\s*(?:on)?\s*[:\-]?\s*([^\n]+)",
        r"date\s*[:\-]?\s*([^\n]+)"
    ]

    def parse(self) -> Dict[str, object]:
        self.result = {"doc_type": "EOB"}

        date = self._extract_date()
        if date:
            self.result["eob_date"] = parse_date(date)

        claim = self._find_field(r"CLAIM NUMBER[:\s]*([A-Z0-9-]+)")
        if claim:
            self.result["claim_number"] = claim

        self.result["insurance_name"] = self._extract_insurance_name()

        service_lines = self._parse_service_lines()
        self.result["service_lines"] = service_lines

        if service_lines:
            cpt_codes = [l.get("cpt_code") for l in service_lines if l.get("cpt_code")]
            self.result["cpt_codes"] = sorted(set(cpt_codes))
            pr_total = sum((l.get("patient_responsibility") or Decimal(0) for l in service_lines), Decimal(0))
            ip_total = sum((l.get("insurance_paid") or Decimal(0) for l in service_lines), Decimal(0))
            self.result["patient_responsibility"] = pr_total
            self.result["insurance_paid"] = ip_total

        return self.result

    def _find_field(self, pattern: str) -> Optional[str]:
        m = re.search(pattern, self.text, re.IGNORECASE)
        return m.group(1).strip() if m else None

    def _extract_date(self) -> Optional[str]:
        for pattern in self.DATE_PATTERNS:
            date = self._find_field(pattern)
            if date:
                return date
        return None

    def _extract_insurance_name(self) -> Optional[str]:
        for line in self.text.splitlines()[:10]:
            if "insurance" in line.lower():
                return line.strip()
        return None

    def _parse_service_lines(self) -> List[Dict[str, object]]:
        header = re.search(r"CPT\s+CODE", self.text, re.IGNORECASE)
        if not header:
            return []
        lines: List[Dict[str, object]] = []
        for raw in self.text[header.end():].splitlines():
            cols = raw.split()
            if len(cols) < 4:
                continue
            line = ServiceLine(
                cpt_code=cols[0],
                charge=parse_money(cols[1]),
                patient_responsibility=parse_money(cols[2]),
                insurance_paid=parse_money(cols[3]),
            )
            lines.append({k: v for k, v in asdict(line).items() if v is not None})
        return lines


# ---------------------------------------------------------------------------
# High-level entry point
# ---------------------------------------------------------------------------

def parse_file(path: Path) -> Dict[str, object]:
    text = extract_text(path)
    doc_type = classify_text(text) or "UNKNOWN"
    if doc_type == "HCFA":
        parser = HcfaParser(text)
        result = parser.parse()
    elif doc_type == "EOB":
        parser = EobParser(text)
        result = parser.parse()
    else:
        result = {"doc_type": doc_type}
    result["source_file"] = path.name
    return result


__all__ = [
    "parse_file",
    "classify_text",
    "parse_money",
    "extract_text",
    "HcfaParser",
    "EobParser",
]
