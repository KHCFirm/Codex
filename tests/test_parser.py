import builtins
from decimal import Decimal

import pdf_claim_parser as parser


def test_classify_text_hcfa():
    text = "This is a CMS-1500 form with box 24J." 
    assert parser.classify_text(text) == "HCFA"


def test_classify_text_eob():
    text = "EXPLANATION OF BENEFITS statement" 
    assert parser.classify_text(text) == "EOB"


def test_parse_money():
    assert parser.parse_money("$1,234.56") == Decimal("1234.56")
