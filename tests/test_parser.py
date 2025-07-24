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


def test_parse_money():
    assert parser.parse_money("$1,234.56") == Decimal("1234.56")
