# pip install pdfplumber python-dateutil pypdf rich
"""CLI tool to parse healthcare claim PDFs.

This module provides `HcfaParser` and `EobParser` classes for extracting
fields from text-based PDF documents.  The main script accepts a path or
glob of PDF files, classifies each as either an HCFA-1500 claim form or an
Explanation of Benefits (EOB), and outputs JSON records for each file.
"""

from __future__ import annotations

import argparse
import glob
import json
import logging
import re
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import List, Optional

import pdfplumber
from dateutil import parser as dateparser


logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def parse_money(value: str) -> Optional[Decimal]:
    """Convert a currency string to ``Decimal``.

    Returns ``None`` if conversion fails.
    """
    if not value:
        return None
    cleaned = re.sub(r"[^0-9.-]", "", value)
    try:
        return Decimal(cleaned)
    except Exception:
        logger.debug("Failed to parse money value: %s", value)
        return None


@dataclass
class ServiceLine:
    date_of_service: Optional[str] = None
    place_of_service: Optional[str] = None
    cpt_code: Optional[str] = None
    charge: Optional[Decimal] = None
    rendering_npi: Optional[str] = None
    patient_responsibility: Optional[Decimal] = None
    insurance_paid: Optional[Decimal] = None


# ---------------------------------------------------------------------------
# Classification logic
# ---------------------------------------------------------------------------

HCFA_KEYWORDS = ["CMS-1500", "HCFA", "1a.", "24J."]
EOB_KEYWORDS = ["EXPLANATION OF BENEFITS", "EOB", "Patient Responsibility"]


def classify_text(text: str) -> Optional[str]:
    """Return ``HCFA`` or ``EOB`` if keywords indicate document type."""
    upper = text.upper()
    if any(k.upper() in upper for k in HCFA_KEYWORDS):
        return "HCFA"
    if any(k.upper() in upper for k in EOB_KEYWORDS):
        return "EOB"
    return None


# ---------------------------------------------------------------------------
# PDF extraction helpers
# ---------------------------------------------------------------------------

def extract_text_from_pdf(pdf_path: Path) -> str:
    """Extract all text from a PDF using pdfplumber."""
    text_parts = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text(x_tolerance=2, y_tolerance=2)
            if page_text:
                text_parts.append(page_text)
    return "\n".join(text_parts)


# ---------------------------------------------------------------------------
# HCFA Parser
# ---------------------------------------------------------------------------

@dataclass
class HcfaParser:
    text: str
    result: dict = field(default_factory=dict)

    def parse(self) -> dict:
        self.result = {
            "doc_type": "HCFA",
            "patient_name": self._find_field(r"PATIENT'S NAME[^\n]*?\n(.+)", group=1),
            "patient_dob": self._parse_date(self._find_field(r"3\.\s*DATE OF BIRTH[^\n]*?\n(.+)", 1)),
            "patient_address": self._find_field(r"5\.\s*PATIENT ADDRESS[^\n]*?\n(.+)", 1),
            "insured_id": self._find_field(r"1A\.\s*INSURED'S ID NUMBER[^\n]*?\n(.+)", 1),
            "diagnosis_codes": self._find_all(r"21\.\s*DIAGNOSIS[^\n]*?\n(.+)", 1),
            "service_lines": self._parse_service_lines(),
            "federal_tax_id": self._find_field(r"25\.\s*FEDERAL TAX ID NUMBER[^\n]*?\n(.+)", 1),
            "physician_signature": self._find_field(r"31\.\s*SIGNATURE[^\n]*?\n(.+)", 1),
            "service_facility": self._find_field(r"32\.\s*SERVICE FACILITY LOCATION[^\n]*?\n(.+)", 1),
            "billing_npi": self._find_field(r"33A\.\s*NPI[^\n]*?\n(.+)", 1),
        }
        return self.result

    def _find_field(self, pattern: str, group: int = 0) -> Optional[str]:
        m = re.search(pattern, self.text, re.IGNORECASE)
        return m.group(group).strip() if m else None

    def _find_all(self, pattern: str, group: int = 0) -> List[str]:
        matches = re.findall(pattern, self.text, flags=re.IGNORECASE)
        return [m.strip() for m in matches]

    def _parse_date(self, value: Optional[str]) -> Optional[str]:
        if not value:
            return None
        try:
            return dateparser.parse(value, fuzzy=True).date().isoformat()
        except Exception:
            logger.debug("Failed to parse date: %s", value)
            return None

    def _parse_service_lines(self) -> List[dict]:
        lines = []
        pattern = re.compile(r"24A.*24B.*24D.*24F.*24J", re.IGNORECASE)
        header_match = pattern.search(self.text)
        if not header_match:
            return lines
        header_end = header_match.end()
        body = self.text[header_end:].splitlines()
        for raw in body:
            cols = raw.split()
            if len(cols) < 5:
                continue
            line = ServiceLine(
                date_of_service=cols[0],
                place_of_service=cols[1],
                cpt_code=cols[2],
                charge=parse_money(cols[3]),
                rendering_npi=cols[4],
            )
            lines.append({k: v for k, v in line.__dict__.items() if v is not None})
        return lines


# ---------------------------------------------------------------------------
# EOB Parser
# ---------------------------------------------------------------------------

@dataclass
class EobParser:
    text: str
    result: dict = field(default_factory=dict)

    def parse(self) -> dict:
        self.result = {
            "doc_type": "EOB",
            "eob_date": self._find_date(),
            "claim_number": self._find_field(r"CLAIM NUMBER[:\s]*([A-Z0-9-]+)", 1),
            "service_lines": self._parse_service_lines(),
        }
        return self.result

    def _find_field(self, pattern: str, group: int = 0) -> Optional[str]:
        m = re.search(pattern, self.text, re.IGNORECASE)
        return m.group(group).strip() if m else None

    def _find_date(self) -> Optional[str]:
        for label in ["Payment Date", "Check Date", "Printed Date"]:
            m = re.search(label + r"[:\s]*([^\n]+)", self.text, re.IGNORECASE)
            if m:
                try:
                    return dateparser.parse(m.group(1), fuzzy=True).date().isoformat()
                except Exception:
                    logger.debug("Failed to parse date: %s", m.group(1))
        return None

    def _parse_service_lines(self) -> List[dict]:
        lines = []
        pattern = re.compile(r"CPT\s+CODE", re.IGNORECASE)
        header_match = pattern.search(self.text)
        if not header_match:
            return lines
        body = self.text[header_match.end():].splitlines()
        for raw in body:
            if not raw.strip():
                continue
            cols = raw.split()
            if len(cols) < 4:
                continue
            line = ServiceLine(
                cpt_code=cols[0],
                charge=parse_money(cols[1]),
                patient_responsibility=parse_money(cols[2]),
                insurance_paid=parse_money(cols[3]),
            )
            lines.append({k: v for k, v in line.__dict__.items() if v is not None})
        return lines


# ---------------------------------------------------------------------------
# Main command-line interface
# ---------------------------------------------------------------------------

def parse_file(path: Path) -> dict:
    text = extract_text_from_pdf(path)
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


def main(argv: Optional[List[str]] = None) -> None:
    parser = argparse.ArgumentParser(description="Parse claim PDFs")
    parser.add_argument("input", help="Input file path or glob")
    parser.add_argument("--output", help="Output JSON file path", default=None)
    args = parser.parse_args(argv)

    paths = [Path(p) for p in glob.glob(args.input)]
    results = []
    for p in paths:
        logger.info("Processing %s", p)
        try:
            results.append(parse_file(p))
        except Exception as exc:
            logger.error("Failed to parse %s: %s", p, exc)
    output = json.dumps(results, indent=2)
    if args.output:
        Path(args.output).write_text(output)
    else:
        print(output)


if __name__ == "__main__":
    main()
