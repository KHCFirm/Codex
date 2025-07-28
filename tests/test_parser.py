import builtins
from decimal import Decimal
import sys
from pathlib import Path

# Ensure the repository root is on the Python path so ``pdf_claim_parser`` can
# be imported when tests are executed from within the ``tests`` directory.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pdf_claim_parser as parser


def test_classify_text_hcfa():
    text = "This is a CMS-1500 form with box 24J." 
    assert parser.classify_text(text) == "HCFA"


def test_classify_text_eob():
    text = "EXPLANATION OF BENEFITS statement"
    assert parser.classify_text(text) == "EOB"


def test_classify_text_cms_variant():
    text = "This document uses the CMS 1500 health insurance claim form"
    assert parser.classify_text(text) == "HCFA"


def test_classify_text_remittance_advice():
    text = "Please see the remittance advice for payment details"
    assert parser.classify_text(text) == "EOB"


def test_parse_money():
    assert parser.parse_money("$1,234.56") == Decimal("1234.56")


def test_eob_parser_fields():
    text = (
        "Sample Insurance Company\n"
        "Statement Date: 02/05/2024\n"
        "CLAIM NUMBER ABC123\n"
        "CPT CODE\n"
        "99213 100.00 20.00 80.00\n"
    )
    p = parser.EobParser(text)
    result = p.parse()
    assert result["eob_date"] == "2024-02-05"
    assert result["insurance_name"] == "Sample Insurance Company"
    assert result["patient_responsibility"] == Decimal("20.00")
    assert result["insurance_paid"] == Decimal("80.00")
    assert result["cpt_codes"] == ["99213"]
